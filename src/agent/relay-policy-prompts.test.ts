/**
 * Contract: the "run it, don't relay it" policy is spread across several
 * prompt strings (framework base prompt, tool prompt, SessionStart note,
 * hook block messages, end-of-turn template). Each one used to nudge the
 * model toward handing a runnable command to the user instead of running it
 * with its own bash tool. These assertions pin the corrected wording so a
 * later edit cannot silently reintroduce the relay default.
 *
 * Plan and evidence: `.afk/plans/run-it-dont-relay-it.md` (local, gitignored).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { BASH_PASSTHROUGH_PROMPT, TOOL_SYSTEM_PROMPT } from './tools/system-prompt.js';
import { createPlaceholderPreventHook } from './placeholder-prevent.js';
import { SAFE_DESTRUCT_BLOCK_INJECT_CONTEXT } from './safe-destruct-detect.js';
import { DESTRUCTIVE_PATTERNS } from './safe-destruct-patterns.js';
import { END_OF_TURN_DIRECTIVE } from './routing-directive.js';
import type { HookContext } from './hooks.js';

const FRAMEWORK_PROMPT = readFileSync(
  fileURLToPath(new URL('../../system-prompt.md', import.meta.url)),
  'utf8',
);

describe('run it, don\'t relay it: framework base prompt', () => {
  it('has the rule under Operating posture, before The operating loop', () => {
    const rule = FRAMEWORK_PROMPT.indexOf("### Run it, don't relay it");
    expect(rule).toBeGreaterThan(FRAMEWORK_PROMPT.indexOf('## Operating posture'));
    expect(rule).toBeLessThan(FRAMEWORK_PROMPT.indexOf('## The operating loop'));
  });

  it('tells the model to run local reversible commands itself', () => {
    expect(FRAMEWORK_PROMPT).toContain('Writing a command for the user to type is not acting.');
    expect(FRAMEWORK_PROMPT).toMatch(/local, non-interactive, and reversible, run it yourself/);
  });

  it('keeps the legitimate hand-off cases', () => {
    for (const reason of ['sudo password', 'browser OAuth', 'plan mode', 'hook blocked that exact command']) {
      expect(FRAMEWORK_PROMPT).toContain(reason);
    }
  });

  it('scopes a hook block to the blocked command and forbids reaching its effect another way', () => {
    expect(FRAMEWORK_PROMPT).toContain('A hook block covers the command it blocked');
    expect(FRAMEWORK_PROMPT).toContain('never reach the blocked effect another way');
  });

  it('no longer frames commands as generated "for the user to run" by default', () => {
    expect(FRAMEWORK_PROMPT).not.toContain('When generating shell commands or code for the user to run');
    expect(FRAMEWORK_PROMPT).toContain('When a command must be run by the user');
  });
});

describe('run it, don\'t relay it: tool and SessionStart prompts', () => {
  it('BASH_PASSTHROUGH_PROMPT says `!` is the user channel, not a hand-off target', () => {
    expect(BASH_PASSTHROUGH_PROMPT).toContain("The `!` prefix is the user's own channel");
    expect(BASH_PASSTHROUGH_PROMPT).toContain('Never tell the user to run something with `!`');
    expect(TOOL_SYSTEM_PROMPT).toContain(BASH_PASSTHROUGH_PROMPT);
  });

  it('placeholder-prevent note leads with running commands yourself', () => {
    const result = createPlaceholderPreventHook()({ event: 'SessionStart', sessionId: 'relay-policy-test' } as HookContext);
    const text = result.injectContext as string;
    expect(text.startsWith('[placeholder-prevent] Prefer running commands yourself')).toBe(true);
    expect(text).toContain('applies only to commands you must hand to the user');
  });
});

describe('run it, don\'t relay it: hook block messages', () => {
  it('shared safe-destruct context offers the safer alternative before the operator hand-off', () => {
    const ctx = SAFE_DESTRUCT_BLOCK_INJECT_CONTEXT;
    const alt = ctx.indexOf('use the safer alternative');
    const handoff = ctx.indexOf('ask the operator to run it manually');
    expect(alt).toBeGreaterThan(-1);
    expect(handoff).toBeGreaterThan(alt);
    expect(ctx).toContain('The block covers this command only');
    expect(ctx).toContain('do not reach the same destructive effect another way');
  });

  it('every block reason that offers an operator hand-off also scopes the block to this command', () => {
    const withHandoff = DESTRUCTIVE_PATTERNS.filter(
      (p) => p.tier === 'block' && p.blockReason.includes('ask the operator to run it'),
    );
    expect(withHandoff.length).toBeGreaterThan(0);
    for (const p of withHandoff) {
      if (p.tier !== 'block') continue;
      expect(p.blockReason, p.id).toContain('it blocks only this command');
      expect(p.blockReason, p.id).toContain('do not reach the same destructive effect another way');
      expect(p.blockReason, p.id).not.toContain('if the destruction is genuinely intended');
    }
  });
});

describe('run it, don\'t relay it: end-of-turn template', () => {
  it('Blocked unblock condition must not be a command the agent could run', () => {
    expect(END_OF_TURN_DIRECTIVE).toContain(
      '- What must change to unblock: <the unblock condition; never a command your own tools could have run',
    );
  });
});
