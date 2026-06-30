/**
 * Tests for assembleSystemPrompt: surface-aware appending of the routing
 * directive and the end-of-turn protocol.
 *
 * The end-of-turn protocol is REPL infrastructure — the verdict-ledger /
 * verdict-card UI depends on the model emitting one of four named terminal
 * states (Done / Blocked / Asking / Interrupted) at the tail of every turn.
 * Without these tests, a refactor that drops the protocol from interactive
 * surfaces would silently disable the ledger rail and the regression would
 * only surface as "the rail never appears" — exactly the symptom that
 * motivated this fix.
 */

import { describe, it, expect } from 'vitest';

import { parseTerminalState } from '../cli/commands/interactive/terminal-state.js';

import {
  END_OF_TURN_DIRECTIVE,
  ROUTING_DIRECTIVE,
  assembleSystemPrompt,
} from './routing-directive.js';

const BASE = 'You are a careful assistant.';

describe('assembleSystemPrompt', () => {
  describe('base prompt handling', () => {
    it('returns undefined when base is undefined', () => {
      expect(assembleSystemPrompt(undefined, false)).toBeUndefined();
      expect(assembleSystemPrompt(undefined, true, 'repl')).toBeUndefined();
    });

    it('returns the base prompt unchanged when nothing should be appended', () => {
      expect(assembleSystemPrompt(BASE, false, 'one-shot')).toBe(BASE);
    });

    it('returns the base prompt unchanged when base is an empty string', () => {
      // `if (!base) return base` short-circuits — covers the
      // "empty-string base" case so we don't append directives to nothing
      // and produce a leading-newline prompt.
      expect(assembleSystemPrompt('', true, 'repl')).toBe('');
    });
  });

  describe('routing directive (auto-routing flag)', () => {
    it('appends ROUTING_DIRECTIVE when autoRouting=true', () => {
      const out = assembleSystemPrompt(BASE, true, 'one-shot');
      expect(out).toContain(BASE);
      expect(out).toContain(ROUTING_DIRECTIVE);
    });

    it('omits ROUTING_DIRECTIVE when autoRouting=false', () => {
      const out = assembleSystemPrompt(BASE, false, 'one-shot');
      expect(out).not.toContain(ROUTING_DIRECTIVE);
    });
  });

  describe('end-of-turn directive (surface)', () => {
    it('appends END_OF_TURN_DIRECTIVE on the REPL surface', () => {
      const out = assembleSystemPrompt(BASE, false, 'repl');
      expect(out).toContain(BASE);
      expect(out).toContain(END_OF_TURN_DIRECTIVE);
    });

    it('appends END_OF_TURN_DIRECTIVE on the Telegram surface', () => {
      const out = assembleSystemPrompt(BASE, false, 'telegram');
      expect(out).toContain(END_OF_TURN_DIRECTIVE);
    });

    it('omits END_OF_TURN_DIRECTIVE on the one-shot surface', () => {
      // Invariant: non-interactive surfaces must not receive the directive.
      // Scripted callers of `afk chat` parse stdout; injecting a structured
      // terminal-state heading would corrupt downstream pipelines.
      const out = assembleSystemPrompt(BASE, false, 'one-shot');
      expect(out).not.toContain(END_OF_TURN_DIRECTIVE);
    });

    it('omits END_OF_TURN_DIRECTIVE on the subagent surface', () => {
      // Subagent output is consumed by a parent agent, not rendered to a
      // ledger rail. The protocol would add noise the parent has to
      // strip back out.
      const out = assembleSystemPrompt(BASE, false, 'subagent');
      expect(out).not.toContain(END_OF_TURN_DIRECTIVE);
    });

    it('defaults to one-shot semantics when surface is omitted', () => {
      // Contract: omitting the surface tag MUST be the safe choice. Any new
      // call site that forgets to pass a surface must not silently inject
      // protocol into a non-interactive output stream.
      const out = assembleSystemPrompt(BASE, false);
      expect(out).not.toContain(END_OF_TURN_DIRECTIVE);
      expect(out).toBe(BASE);
    });
  });

  describe('combined directives', () => {
    it('appends both directives when autoRouting=true and surface=repl', () => {
      const out = assembleSystemPrompt(BASE, true, 'repl');
      expect(out).toContain(BASE);
      expect(out).toContain(ROUTING_DIRECTIVE);
      expect(out).toContain(END_OF_TURN_DIRECTIVE);
    });

    it('orders sections as: base, routing, end-of-turn', () => {
      // Invariant: end-of-turn must be the final block so it lands in the
      // model's highest-attention tail region. Routing rides between base
      // and end-of-turn — its content is structural guidance, not a
      // turn-terminator.
      const out = assembleSystemPrompt(BASE, true, 'repl');
      expect(out).toBeDefined();
      const baseIdx = out!.indexOf(BASE);
      const routingIdx = out!.indexOf(ROUTING_DIRECTIVE);
      const endIdx = out!.indexOf(END_OF_TURN_DIRECTIVE);
      expect(baseIdx).toBeLessThan(routingIdx);
      expect(routingIdx).toBeLessThan(endIdx);
    });

    it('separates sections with a blank line', () => {
      const out = assembleSystemPrompt(BASE, true, 'repl');
      expect(out).toBeDefined();
      // Three sections → at least two `\n\n` separators.
      const separators = (out!.match(/\n\n/g) ?? []).length;
      expect(separators).toBeGreaterThanOrEqual(2);
    });
  });

  describe('ROUTING_DIRECTIVE content', () => {
    it('routes /ground-state as a pre-write trigger in the primary routing block', () => {
      // Regression guard (the "agent ran inline git instead of /ground-state"
      // fix): /ground-state must live in the imperative "Route recurring work"
      // block, not only under the weaker "exploratory investigators" heading.
      // When it sat under "exploratory", the agent gated it out during
      // concrete implementation work and substituted inline `git status` /
      // `get_runtime_state` for the skill.
      const groundStateIdx = ROUTING_DIRECTIVE.indexOf('/ground-state');
      const exploratoryIdx = ROUTING_DIRECTIVE.indexOf('the task is exploratory');
      expect(groundStateIdx).toBeGreaterThan(-1);
      expect(exploratoryIdx).toBeGreaterThan(-1);
      // The first (authoritative) /ground-state mention sits above the
      // exploratory section, i.e. in the primary routing block.
      expect(groundStateIdx).toBeLessThan(exploratoryIdx);
    });

    it('warns against substituting inline git / get_runtime_state for /ground-state', () => {
      // The anti-substitution clause is the core of the fix: without it the
      // imperative names a behavior ("establish git state") that the cheap
      // inline tools satisfy, so the skill never gets invoked.
      expect(ROUTING_DIRECTIVE).toMatch(/Do NOT substitute inline/);
      expect(ROUTING_DIRECTIVE).toContain('get_runtime_state');
    });

    it('keeps an escape hatch when /ground-state dispatch fails', () => {
      // A hard prohibition with no fallback is worse than the pre-fix state:
      // at depth limits or when the skill manifest is unavailable, the agent
      // would otherwise be told to neither call the skill nor use the inline
      // fallback.
      expect(ROUTING_DIRECTIVE).toMatch(/dispatch fails/);
      expect(ROUTING_DIRECTIVE).toMatch(/fall back to inline checks/);
    });
  });

  describe('END_OF_TURN_DIRECTIVE content', () => {
    it('names all four terminal kinds', () => {
      expect(END_OF_TURN_DIRECTIVE).toMatch(/\bDone\b/);
      expect(END_OF_TURN_DIRECTIVE).toMatch(/\bBlocked\b/);
      expect(END_OF_TURN_DIRECTIVE).toMatch(/\bAsking\b/);
      expect(END_OF_TURN_DIRECTIVE).toMatch(/\bInterrupted\b/);
    });

    it('uses the bold-heading format the terminal-state parser accepts', () => {
      // Contract: `parseTerminalState()` in cli/commands/interactive/
      // terminal-state.ts matches headings like `**Done**`. If the directive
      // drifts to a different format (e.g. `# Done`) without the parser
      // following, the ledger silently breaks. This test pins the format.
      expect(END_OF_TURN_DIRECTIVE).toContain('**Done**');
      expect(END_OF_TURN_DIRECTIVE).toContain('**Blocked**');
      expect(END_OF_TURN_DIRECTIVE).toContain('**Asking**');
      expect(END_OF_TURN_DIRECTIVE).toContain('**Interrupted**');
    });

    it('carries the uncommitted-mutation guard in the Done block', () => {
      // Regression guard for the commit-gate invariant (pattern card
      // "world_changed && commits=0 leaves work in an unrecoverable
      // intermediate state"). A Done state that claims clean completion while
      // files were mutated but never committed is the failure this prevents.
      // The check is self-observed: the agent reasons from its own in-turn
      // tool history, because world_changes telemetry (facets/derive.ts) is
      // computed post-session and is not visible to the model at turn-end.
      expect(END_OF_TURN_DIRECTIVE).toMatch(/git commit/);
      expect(END_OF_TURN_DIRECTIVE).toMatch(/uncommitted/i);
    });
  });

  describe('end-to-end contract with parseTerminalState', () => {
    // These tests are the central regression guard for the verdict-ledger
    // feature. They simulate a model that followed the END_OF_TURN_DIRECTIVE
    // and assert that the parser the REPL uses can recover a non-null verdict.
    // If either the directive or the parser drift such that they no longer
    // agree on the format, these tests fail before the ledger silently breaks
    // in production.

    it('parses a Done response shaped like the directive prescribes', () => {
      const response = [
        'I refactored the cache layer and ran the suite.',
        '',
        '**Done**',
        '- What was done: extracted CacheManager into its own module',
        '- Evidence that exists: 47 tests pass, no new failures',
        '- What changed in the world: src/cache/manager.ts created',
        '- Anything still pending or deferred, with why: none',
      ].join('\n');

      const verdict = parseTerminalState(response);
      expect(verdict).not.toBeNull();
      expect(verdict?.kind).toBe('done');
      expect(verdict?.whatWasDone).toContain('CacheManager');
      expect(verdict?.evidence).toContain('47 tests');
    });

    it('parses a Blocked response shaped like the directive prescribes', () => {
      const response = [
        'I cannot proceed without credentials.',
        '',
        '**Blocked**',
        '- What blocks: missing GITHUB_TOKEN in env',
        '- What must change to unblock: operator exports the token',
        '- What has already been done: branch created, diff staged',
      ].join('\n');

      const verdict = parseTerminalState(response);
      expect(verdict).not.toBeNull();
      expect(verdict?.kind).toBe('blocked');
      expect(verdict?.whatBlocks).toContain('GITHUB_TOKEN');
      expect(verdict?.unblockCondition).toContain('operator');
      expect(verdict?.alreadyDone).toContain('branch created');
    });

    it('parses an Asking response shaped like the directive prescribes', () => {
      const response = [
        '**Asking**',
        '- One precise question: should I bump major or minor version?',
        '- The assumption it resolves: whether the API change is breaking',
        '- What you will do once answered: tag the release and push',
      ].join('\n');

      const verdict = parseTerminalState(response);
      expect(verdict).not.toBeNull();
      expect(verdict?.kind).toBe('asking');
      expect(verdict?.question).toContain('major or minor');
    });

    it('parses an Interrupted response shaped like the directive prescribes', () => {
      const response = [
        '**Interrupted**',
        '- What you were doing: running the migration script',
        '- Where state was saved: ~/.afk/state/sessions/abc.json',
        '- What resumption requires: re-run with --resume abc',
      ].join('\n');

      const verdict = parseTerminalState(response);
      expect(verdict).not.toBeNull();
      expect(verdict?.kind).toBe('interrupted');
      expect(verdict?.whatWasInProgress).toContain('migration');
    });
  });
});
