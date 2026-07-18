/**
 * Tests for the /search slash command — searches the CURRENT session's
 * conversation turns and provides a jump-to-last-error affordance.
 *
 * Contract under test:
 *  (a) `/search <term>` matches a case-insensitive substring across BOTH the
 *      user prompt AND the assistant response of each turn.
 *  (b) Each hit renders a trimmed (~200 char) snippet around the first match,
 *      with the matched substring visually emphasized (a non-cyan palette tone
 *      — cyan is reserved for user identity, see commit "reserve cyan for user
 *      identity"). We strip ANSI and assert on the emphasis wrapper's presence.
 *  (c) Results are capped at the 20 most recent matches with a trailing
 *      "…and N more" line when more exist.
 *  (d) `/search --error` (and `-e`) locates the LAST tool event with
 *      isError across all turns and reports turn ordinal + tool name + snippet.
 *  (e) No-match and no-args paths emit friendly one-liners (never throw, never
 *      mutate state).
 *
 * The command is read-only: these tests also assert it never mutates the
 * turns array it is given.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import chalk from 'chalk';
import type { SlashContext, SessionStats, TurnRecord } from '../types.js';
import { searchCmd } from './search.ts';

// The palette binds chalk color fns at import; chalk checks its `level` at call
// time, so bumping the level here makes those bound fns emit real ANSI even
// though the test process is not a TTY (default level 0 = identity, which would
// make the "emphasis is non-cyan" assertion vacuous). Restored after each test.
let origChalkLevel: number;
beforeEach(() => { origChalkLevel = chalk.level; chalk.level = 1; });
afterEach(() => { chalk.level = origChalkLevel; });

/** Build a SessionStats with the supplied turns (other fields are inert). */
function makeStats(turns: TurnRecord[]): SessionStats {
  return {
    totalTurns: turns.length,
    totalCostUsd: 0,
    totalTokens: 0,
    totalDurationMs: 0,
    sessionStartTime: Date.now(),
    turnCosts: [],
    turnTokens: [],
    turns,
    model: 'sonnet',
    permissionMode: 'default',
  } as unknown as SessionStats;
}

/** Capture every writer call as a tagged line so tests can assert on output. */
function makeCtx(turns: TurnRecord[]): { ctx: SlashContext; lines: string[]; stats: SessionStats } {
  const lines: string[] = [];
  const stats = makeStats(turns);
  const ctx = {
    session: { current: {} },
    stats,
    out: {
      line: (t = ''): void => { lines.push(`LINE:${t}`); },
      raw: (t: string): void => { lines.push(`RAW:${t}`); },
      success: (t: string): void => { lines.push(`SUCCESS:${t}`); },
      info: (t: string): void => { lines.push(`INFO:${t}`); },
      warn: (t: string): void => { lines.push(`WARN:${t}`); },
      error: (t: string): void => { lines.push(`ERROR:${t}`); },
    },
    ui: { clearScreen: vi.fn(), repaintStatusLine: vi.fn() },
  } as unknown as SlashContext;
  return { ctx, lines, stats };
}

function turn(user: string, assistant: string, toolEvents?: TurnRecord['toolEvents']): TurnRecord {
  return { user, assistant, timestamp: Date.now(), toolEvents };
}

/** Join the captured writer lines, stripping ANSI so assertions see plain text. */
function plain(lines: string[]): string {
  // eslint-disable-next-line no-control-regex
  return lines.join('\n').replace(/\u001b\[[0-9;]*m/g, '');
}

describe('/search slash command', () => {
  describe('substring matching across user + assistant text', () => {
    it('matches a term found in the USER prompt, case-insensitively', async () => {
      const { ctx, lines } = makeCtx([
        turn('How do I configure Webpack bundling?', 'You edit the config file.'),
        turn('unrelated', 'unrelated'),
      ]);
      const res = await searchCmd.handler(ctx, 'webpack');
      expect(res).toBe('continue');
      const out = plain(lines);
      expect(out).toContain('Webpack');
      // The unrelated turn must not appear.
      expect(out).not.toContain('unrelated');
    });

    it('matches a term found in the ASSISTANT response, case-insensitively', async () => {
      const { ctx, lines } = makeCtx([
        turn('what happened', 'The build threw a TypeError during compilation.'),
      ]);
      const res = await searchCmd.handler(ctx, 'TYPEERROR');
      expect(res).toBe('continue');
      expect(plain(lines)).toContain('TypeError');
    });

    it('reports the turn ordinal (1-based) and a role tag for each hit', async () => {
      const { ctx, lines } = makeCtx([
        turn('first turn no match here', 'nope'),
        turn('second turn has the needle token', 'assistant reply'),
      ]);
      await searchCmd.handler(ctx, 'needle');
      const out = plain(lines);
      // 1-based ordinal of the matching (second) turn.
      expect(out).toContain('#2');
      // A role tag naming which side matched (user / assistant).
      expect(out.toLowerCase()).toMatch(/user|assistant/);
    });
  });

  describe('snippet trimming + emphasis', () => {
    it('trims a long turn to a window around the first match (~200 chars)', async () => {
      const filler = 'x'.repeat(400);
      const { ctx, lines } = makeCtx([
        turn(`${filler} NEEDLE ${filler}`, 'reply'),
      ]);
      await searchCmd.handler(ctx, 'needle');
      const out = plain(lines);
      // The rendered snippet must be far shorter than the 800+ char source.
      const snippetLine = lines.find((l) => l.includes('NEEDLE'));
      expect(snippetLine).toBeDefined();
      // eslint-disable-next-line no-control-regex
      const width = snippetLine!.replace(/\u001b\[[0-9;]*m/g, '').length;
      expect(width).toBeLessThan(320); // ~200 char window + tag/prefix chrome
      // Elision marker indicates trimming occurred on at least one side.
      expect(out).toContain('…');
    });

    it('emphasizes the matched substring with a non-cyan palette tone', async () => {
      const { ctx, lines } = makeCtx([
        turn('the MATCHME token is here', 'reply'),
      ]);
      await searchCmd.handler(ctx, 'matchme');
      const joined = lines.join('\n');
      // The command uses palette.warning (yellow) for emphasis. Assert the
      // exact wrapper is present around the matched text — and that it is NOT
      // cyan (palette.user), which is reserved for user identity.
      const emphasized = chalk.yellow('MATCHME');
      expect(joined).toContain(emphasized);
      const cyan = chalk.cyan('MATCHME');
      expect(joined).not.toContain(cyan);
    });
  });

  describe('cap + "and N more"', () => {
    it('caps at the 20 most recent matches and prints a remainder line', async () => {
      // 25 matching turns → 20 shown, 5 elided.
      const turns = Array.from({ length: 25 }, (_, i) => turn(`match token turn ${i}`, 'reply'));
      const { ctx, lines } = makeCtx(turns);
      await searchCmd.handler(ctx, 'token');
      const out = plain(lines);
      // 25 total matches, capped to 20 → "and 5 more".
      expect(out).toMatch(/and 5 more/i);
      // Shows the MOST RECENT matches: the last turn (#25) must be present,
      // the earliest (#1) must be dropped. Count the per-hit ordinal lines
      // (shape `#N  ▶/◆ role`) — the header line carries no `#`.
      // eslint-disable-next-line no-control-regex
      const stripped = lines.map((l) => l.replace(/\u001b\[[0-9;]*m/g, ''));
      const hitLines = stripped.filter((l) => /#\d+\s+[▶◆]/.test(l));
      expect(hitLines.length).toBe(20);
      expect(out).toContain('#25');
      expect(out).not.toMatch(/#1\b/);
    });

    it('does not print a remainder line when matches fit under the cap', async () => {
      const turns = Array.from({ length: 3 }, (_, i) => turn(`match ${i}`, 'reply'));
      const { ctx, lines } = makeCtx(turns);
      await searchCmd.handler(ctx, 'match');
      expect(plain(lines)).not.toMatch(/more/i);
    });
  });

  describe('--error / -e (jump to last error)', () => {
    it('finds the LAST tool event with isError across all turns', async () => {
      const { ctx, lines } = makeCtx([
        turn('t1', 'a1', [
          { toolName: 'read_file', toolUseId: 'u1', input: '{}', isError: true, result: 'ENOENT first error' },
        ]),
        turn('t2', 'a2', [
          { toolName: 'bash', toolUseId: 'u2', input: '{}', isError: false, result: 'ok' },
          { toolName: 'edit_file', toolUseId: 'u3', input: '{}', isError: true, result: 'patch did not apply LAST error' },
        ]),
        turn('t3', 'a3', [
          { toolName: 'grep', toolUseId: 'u4', input: '{}', isError: false, result: 'match' },
        ]),
      ]);
      const res = await searchCmd.handler(ctx, '--error');
      expect(res).toBe('continue');
      const out = plain(lines);
      // Reports the LAST error (turn #2, edit_file), not the first (read_file).
      expect(out).toContain('#2');
      expect(out).toContain('edit_file');
      expect(out).toContain('patch did not apply');
      expect(out).not.toContain('ENOENT first error');
    });

    it('accepts the -e short flag', async () => {
      const { ctx, lines } = makeCtx([
        turn('t1', 'a1', [
          { toolName: 'bash', toolUseId: 'u1', input: '{}', isError: true, result: 'boom' },
        ]),
      ]);
      await searchCmd.handler(ctx, '-e');
      const out = plain(lines);
      expect(out).toContain('bash');
      expect(out).toContain('boom');
    });

    it('says so when no error events exist', async () => {
      const { ctx, lines } = makeCtx([
        turn('t1', 'a1', [{ toolName: 'bash', toolUseId: 'u1', input: '{}', isError: false, result: 'ok' }]),
        turn('t2', 'a2'),
      ]);
      await searchCmd.handler(ctx, '--error');
      expect(plain(lines).toLowerCase()).toMatch(/no.*error/);
    });
  });

  describe('no-match and no-args paths', () => {
    it('emits a friendly one-liner when nothing matches', async () => {
      const { ctx, lines } = makeCtx([turn('hello', 'world')]);
      const res = await searchCmd.handler(ctx, 'zzz-not-present');
      expect(res).toBe('continue');
      expect(plain(lines).toLowerCase()).toMatch(/no match/);
    });

    it('prints a usage line when called with no args', async () => {
      const { ctx, lines } = makeCtx([turn('hello', 'world')]);
      const res = await searchCmd.handler(ctx, '');
      expect(res).toBe('continue');
      expect(plain(lines)).toContain('/search');
    });

    it('reports an empty session gracefully', async () => {
      const { ctx, lines } = makeCtx([]);
      const res = await searchCmd.handler(ctx, 'anything');
      expect(res).toBe('continue');
      expect(plain(lines).toLowerCase()).toMatch(/no turns|no match/);
    });
  });

  describe('read-only invariant', () => {
    it('does not mutate the turns array', async () => {
      const turns = [turn('alpha', 'beta'), turn('gamma', 'delta')];
      const snapshot = JSON.parse(JSON.stringify(turns));
      const { ctx } = makeCtx(turns);
      await searchCmd.handler(ctx, 'alpha');
      await searchCmd.handler(ctx, '--error');
      expect(turns).toEqual(snapshot);
    });
  });

  describe('registration metadata', () => {
    it('has a name, summary, and usage for /help + dropdown', () => {
      expect(searchCmd.name).toBe('/search');
      expect(searchCmd.summary.length).toBeGreaterThan(0);
      expect(searchCmd.usage).toContain('/search');
    });
  });
});
