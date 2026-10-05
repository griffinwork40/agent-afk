/**
 * Tests for `isStandalone` and the whatif-session / anaphora exclusion logic
 * added in episodes.ts to address issue #2408.
 *
 * Split from episodes.test.ts to keep both files under 350 LOC.
 */

import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectRealTurns, isStandalone } from './episodes.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function ledgerLine(kind: string, text: string): string {
  return JSON.stringify({ v: 1, ts: Date.now(), kind, text }) + '\n';
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'whatif-standalone-test-'));
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

async function writeSession(sessionId: string, lines: string[]): Promise<void> {
  const sessDir = path.join(tmpDir, sessionId);
  await fsp.mkdir(sessDir, { recursive: true });
  await fsp.writeFile(path.join(sessDir, 'events.jsonl'), lines.join(''), 'utf8');
}

// ---------------------------------------------------------------------------
// isStandalone — acceptance tests
// ---------------------------------------------------------------------------

describe('isStandalone', () => {
  it('rejects context-dependent follow-ups starting with "it"', () => {
    expect(isStandalone('inspect it please')).toBe(false);
  });

  it('rejects "proceed with that"', () => {
    expect(isStandalone('proceed with that')).toBe(false);
  });

  it('rejects "just #1 please"', () => {
    expect(isStandalone('just #1 please')).toBe(false);
  });

  it('rejects "that looks good, run it"', () => {
    expect(isStandalone('that looks good, run it')).toBe(false);
  });

  it('rejects "this one" (too short + deictic)', () => {
    expect(isStandalone('this one')).toBe(false);
  });

  it('rejects "same as before but with more detail please add it"', () => {
    expect(isStandalone('same as before but with more detail please add it')).toBe(false);
  });

  it('rejects "#2 please run it for me now"', () => {
    expect(isStandalone('#2 please run it for me now')).toBe(false);
  });

  it('accepts a standalone question about the project', () => {
    expect(isStandalone("Why doesn't fast compact work on agent-afk?")).toBe(true);
  });

  it('accepts a substantial independent request', () => {
    expect(isStandalone('Can you explain how the replay corpus is built in the agent engine?')).toBe(true);
  });

  it('rejects text shorter than MIN_LEN_LATER (40 chars)', () => {
    // 35 chars, all standalone-looking
    expect(isStandalone('How does the login flow work here?')).toBe(false);
  });

  it('accepts text of exactly 40 chars that passes all checks', () => {
    // exactly 40 chars, starts with "How", no anaphora
    const text = 'How does the route matching work today?!';
    expect(text.length).toBe(40);
    expect(isStandalone(text)).toBe(true);
  });

  it('rejects text that mentions whatif as the topic', () => {
    expect(isStandalone('Could you explain what the whatif command does and how to run it?')).toBe(false);
  });

  it('accepts a standalone first-person question', () => {
    expect(isStandalone('Can you add a retry mechanism to the HTTP client module?')).toBe(true);
  });

  it('rejects "those results look wrong, fix them"', () => {
    expect(isStandalone('those results look wrong, fix them')).toBe(false);
  });

  it('rejects "these are the errors, please fix"', () => {
    expect(isStandalone('these are the errors, please fix')).toBe(false);
  });

  it('rejects "1. run the tests again now please"', () => {
    expect(isStandalone('1. run the tests again now please')).toBe(false);
  });

  // Finding 2: ordinal-list ANAPHORA_RE branch at 40+ chars (previously uncovered)
  it('rejects a 40+ char ordinal-list prompt via ANAPHORA_RE', () => {
    const text = '1. run the tests with verbose output flags set to true';
    expect(text.length).toBeGreaterThanOrEqual(40);
    expect(isStandalone(text)).toBe(false);
  });

  it('rejects a 2) ordinal prompt of 40+ chars via ANAPHORA_RE', () => {
    const text = '2) please re-run the full integration test suite now';
    expect(text.length).toBeGreaterThanOrEqual(40);
    expect(isStandalone(text)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// collectRealTurns — whatif session exclusion
// ---------------------------------------------------------------------------

describe('collectRealTurns — whatif session exclusion', () => {
  it('excludes a session that contains a /whatif invocation', async () => {
    await writeSession('sess-whatif', [
      ledgerLine('user', '/whatif --verify run this experiment for me right now'),
      ledgerLine('user', 'What is the capital of France?'),
    ]);
    const stats = {
      whatifSessions: 0,
      excludedSessionIds: 0,
      nonStandaloneTurns: 0,
      whatifTopicTurns: 0,
    };
    const eps = await collectRealTurns({ limit: 10, sessionsDir: tmpDir, stats });
    expect(eps).toHaveLength(0);
    expect(stats.whatifSessions).toBe(1);
  });

  it('includes a normal session that has no /whatif invocation', async () => {
    await writeSession('sess-normal', [
      ledgerLine('user', 'What is the capital of France?'),
    ]);
    const eps = await collectRealTurns({ limit: 10, sessionsDir: tmpDir });
    expect(eps).toHaveLength(1);
  });

  it('excludes later turns that start with anaphora', async () => {
    // Fixtures are 40+ chars so the length gate passes and ANAPHORA_RE is
    // what actually rejects them. (Finding 3: prior fixtures were sub-40-char
    // and thus rejected by the length gate before ANAPHORA_RE ran.)
    await writeSession('sess-mixed', [
      ledgerLine('user', 'What is the capital of France?'),
      ledgerLine('user', 'it is a great city, tell me more about its history'),
      ledgerLine('user', 'proceed with the plan and apply all the changes now'),
    ]);
    const stats = {
      whatifSessions: 0,
      excludedSessionIds: 0,
      nonStandaloneTurns: 0,
      whatifTopicTurns: 0,
    };
    const eps = await collectRealTurns({ limit: 10, sessionsDir: tmpDir, stats });
    // Only the first turn should be collected
    expect(eps).toHaveLength(1);
    expect(eps[0]!.prompt).toContain('France');
    expect(stats.nonStandaloneTurns).toBe(2);
  });

  it('includes a later turn that is standalone and substantial', async () => {
    await writeSession('sess-multi', [
      ledgerLine('user', 'What is the capital of France?'),
      ledgerLine('user', 'Can you also explain the history of the French Revolution in detail?'),
    ]);
    const eps = await collectRealTurns({ limit: 10, sessionsDir: tmpDir });
    expect(eps).toHaveLength(2);
  });

  it('excludes later turns primarily about whatif', async () => {
    await writeSession('sess-topic', [
      ledgerLine('user', 'What is the capital of France?'),
      ledgerLine('user', 'How does the whatif command work and what does it measure exactly?'),
    ]);
    const stats = {
      whatifSessions: 0,
      excludedSessionIds: 0,
      nonStandaloneTurns: 0,
      whatifTopicTurns: 0,
    };
    const eps = await collectRealTurns({ limit: 10, sessionsDir: tmpDir, stats });
    expect(eps).toHaveLength(1);
    expect(stats.whatifTopicTurns).toBe(1);
  });

  it('records excludedSessionIds count', async () => {
    await writeSession('sess-skip', [
      ledgerLine('user', 'What is the capital of France?'),
    ]);
    const stats = {
      whatifSessions: 0,
      excludedSessionIds: 0,
      nonStandaloneTurns: 0,
      whatifTopicTurns: 0,
    };
    const eps = await collectRealTurns({
      limit: 10,
      sessionsDir: tmpDir,
      excludeSessionIds: ['sess-skip'],
      stats,
    });
    expect(eps).toHaveLength(0);
    expect(stats.excludedSessionIds).toBe(1);
  });

  it('detects /whatif with leading whitespace', async () => {
    await writeSession('sess-ws', [
      ledgerLine('user', '  /whatif --turns 20 verify the config change now'),
    ]);
    const stats = {
      whatifSessions: 0,
      excludedSessionIds: 0,
      nonStandaloneTurns: 0,
      whatifTopicTurns: 0,
    };
    await collectRealTurns({ limit: 10, sessionsDir: tmpDir, stats });
    expect(stats.whatifSessions).toBe(1);
  });

  // Finding 1: a rejected first turn must not cause the second turn to be
  // evaluated under the stricter isStandalone / MIN_LEN_LATER rules.
  it('collects a valid second turn even when the first turn is rejected by isUsable', async () => {
    await writeSession('sess-first-rejected', [
      // First turn starts with "/" — rejected by isUsable — so the second turn
      // must still be treated as the "first usable" turn and evaluated by
      // isUsable (15-char minimum), not isStandalone (40-char minimum).
      ledgerLine('user', '/plan mode on'),
      ledgerLine('user', 'What is the capital of France?'),
    ]);
    const eps = await collectRealTurns({ limit: 10, sessionsDir: tmpDir });
    expect(eps).toHaveLength(1);
    expect(eps[0]!.prompt).toContain('France');
  });
});
