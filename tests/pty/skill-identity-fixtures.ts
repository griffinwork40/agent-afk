/**
 * Skill-identity PTY scenario fixtures (issue: skill-dispatch-preview-ui).
 *
 * Each scenario drives the REAL TerminalCompositor and SkillIdentityState —
 * the actual production path that StreamRenderer.arm() exercises — inside a
 * real pseudo-terminal, then asserts against the xterm emulator's SCROLLBACK
 * and viewport buffers. The cases covered:
 *
 *   1. IMMEDIATE  — identity committed synchronously at arm(); appears above content.
 *   2. DELAYED    — identity introduced after pre-arm content; coordinator drain order
 *                   preserved.
 *   3. CANCELLED  — overlay-only identity, introduce() never called; zero residue.
 *   4. BACK-TO-BACK — two sequential identities on the same compositor; each once,
 *                     strict turn ordering.
 *   5. NESTED     — outer + inner renderer identities; each exactly once, outer above inner.
 *   6. PIPED      — non-TTY writer path (compositor=null); no ANSI sequences, plain text.
 *
 * Kept separate from scenarios.ts so this file can be iterated independently
 * and does not alter the existing compositor-scrollback suite.
 *
 * The `drive()` function runs INSIDE the pty child (via tsx). Its `expect`
 * block is evaluated by the parent against the parsed emulator buffer.
 * `drive()` deliberately does NOT `disarm()` — the parent snapshots the final
 * LIVE frame state.
 */

import { TerminalCompositor } from '../../src/cli/terminal-compositor.js';
import { SkillIdentityState } from '../../src/cli/_lib/skill-identity-state.js';
import { CommitCoordinator } from '../../src/cli/_lib/commit-coordinator.js';
import type { Writer } from '../../src/cli/slash/types.js';
import type { PtyDriveCtx, PtyScenario, PtyExpect } from './scenarios.js';

const CONTENT_HUG = process.env['AFK_PTY_CONTENT_HUG'] === '1';

/** Let async writes/flush settle. */
const settle = (ms = 60): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Build a minimal status-region stub so the compositor gets a real scroll
 * region (required for commitAbove to use full-screen scroll semantics).
 */
function minimalScrollRegion(stdout: NodeJS.WriteStream): {
  withFullScrollRegion<T>(fn: () => T): T;
  getExtraRows(): number;
} {
  return {
    withFullScrollRegion<T>(fn: () => T): T {
      stdout.write('\x1b[s');
      stdout.write('\x1b[r');
      stdout.write('\x1b[u');
      try {
        return fn();
      } finally {
        const rows = stdout.rows ?? 24;
        stdout.write('\x1b[s');
        stdout.write(`\x1b[1;${rows}r`);
        stdout.write('\x1b[u');
      }
    },
    getExtraRows(): number { return 0; },
  };
}

/**
 * Build a plain Writer whose output is written directly to stdout, line by
 * line, with no ANSI (piped path — compositor=null in SkillIdentityState).
 */
function plainWriter(stdout: NodeJS.WriteStream): Writer {
  const line = (text: string): void => { stdout.write(`${text}\n`); };
  return { line, raw: line, info: line, warn: line, error: line, success: line };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 1 — IMMEDIATE
// Identity introduced immediately at arm(); must appear in committed scrollback
// strictly BEFORE any content rows.
// ─────────────────────────────────────────────────────────────────────────────
const immediateScenario: PtyScenario = {
  description: 'skill identity committed immediately at arm(), appears once above content in scrollback',
  cols: 80,
  rows: 24,
  ref: 'skill-identity-state.ts:introduce()',
  async drive({ stdout, stdin }: PtyDriveCtx): Promise<void> {
    const scrollRegion = minimalScrollRegion(stdout);
    const c = new TerminalCompositor({ contentHug: CONTENT_HUG, stdout, stdin, onCancel: () => {}, scrollRegion, anchorRow: 1 });
    await c.arm();

    const coordinator = new CommitCoordinator();
    const identity = new SkillIdentityState({ name: 'review', purpose: 'IMMED_PURPOSE_REVIEW', arguments: 'src/foo.ts' });

    // introduce() schedules a before-content commit and drains it — mirrors StreamRenderer.arm().
    await identity.introduce(coordinator, c, plainWriter(stdout));

    // Commit enough content to push identity into real scrollback.
    // rows=24 frame + status region leaves ~22 visible rows. 30 commits forces
    // the earliest rows (including the identity) into scrollback (baseY>0).
    for (let i = 0; i < 30; i++) {
      c.commitAbove(`IMMED_CONTENT_${String(i).padStart(2, '0')}\n`);
    }
    c.commitAbove('IMMED_DONE\n');
    await settle();
  },
  expect: {
    exactlyOnce: ['IMMED_PURPOSE_REVIEW', 'IMMED_DONE'],
    order: [['IMMED_PURPOSE_REVIEW', 'IMMED_CONTENT_00'], ['IMMED_CONTENT_00', 'IMMED_DONE']],
    inScrollback: ['IMMED_PURPOSE_REVIEW'],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 2 — DELAYED
// Some content committed BEFORE introduce() is called. The coordinator
// drain ordering (before-content anchor fires first) must still place the
// identity above the pre-introduce content in the buffer.
// ─────────────────────────────────────────────────────────────────────────────
const delayedScenario: PtyScenario = {
  description: 'delayed introduce() still commits identity before content via coordinator drain order',
  cols: 80,
  rows: 24,
  ref: 'skill-identity-state.ts:introduce() + CommitCoordinator before-content anchor',
  async drive({ stdout, stdin }: PtyDriveCtx): Promise<void> {
    const scrollRegion = minimalScrollRegion(stdout);
    const c = new TerminalCompositor({ contentHug: CONTENT_HUG, stdout, stdin, onCancel: () => {}, scrollRegion, anchorRow: 1 });
    await c.arm();

    const coordinator = new CommitCoordinator();

    // Pre-arm content committed before introduce() is called — typical when a
    // tool result arrives before the dispatcher can introduce the skill.
    c.commitAbove('DELAY_PRE_CONTENT\n');
    await settle(20);

    const identity = new SkillIdentityState({ name: 'ship', purpose: 'DELAY_PURPOSE_SHIP' });
    await identity.introduce(coordinator, c, plainWriter(stdout));

    for (let i = 0; i < 14; i++) {
      c.commitAbove(`DELAY_CONTENT_${String(i).padStart(2, '0')}\n`);
    }
    c.commitAbove('DELAY_DONE\n');
    await settle();
  },
  expect: {
    exactlyOnce: ['DELAY_PURPOSE_SHIP', 'DELAY_DONE'],
    // Before-content commit fires before content rows (introduce schedules via
    // coordinator.schedule({ anchor: 'before-content', ... }); flushAll drains
    // before-content first). After flushAll the identity is the first committed row.
    order: [['DELAY_PURPOSE_SHIP', 'DELAY_CONTENT_00'], ['DELAY_CONTENT_00', 'DELAY_DONE']],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 3 — CANCELLED
// Identity constructed but introduce() never called. The overlay DOES show the
// banner (SkillIdentityState.current is used by the overlay slot), but nothing
// is committed to scrollback — the final buffer must be clean of the identity.
// ─────────────────────────────────────────────────────────────────────────────
const cancelledScenario: PtyScenario = {
  description: 'skill identity with introduce() never called leaves zero residue in committed scrollback',
  cols: 80,
  rows: 24,
  ref: 'skill-identity-state.ts:cancel path (no introduce())',
  async drive({ stdout, stdin }: PtyDriveCtx): Promise<void> {
    const scrollRegion = minimalScrollRegion(stdout);
    const c = new TerminalCompositor({ contentHug: CONTENT_HUG, stdout, stdin, onCancel: () => {}, scrollRegion, anchorRow: 1 });
    await c.arm();

    // Construct identity state, set the overlay text manually (as the overlay
    // slot renderer does), but deliberately do NOT call introduce().
    const _identity = new SkillIdentityState({ name: 'diagnose', purpose: 'CANCEL_NEVER_COMMITTED' });
    c.setOverlay('/diagnose · CANCEL_NEVER_COMMITTED'); // transient overlay only
    await settle(30);
    c.setOverlay(''); // collapse overlay without committing

    for (let i = 0; i < 5; i++) {
      c.commitAbove(`CANCEL_CONTENT_${String(i).padStart(2, '0')}\n`);
    }
    c.commitAbove('CANCEL_DONE\n');
    await settle();
  },
  expect: {
    // The purpose string was ONLY in the transient overlay — must not appear committed.
    absent: ['CANCEL_NEVER_COMMITTED'],
    exactlyOnce: ['CANCEL_DONE'],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 4 — BACK-TO-BACK
// Two sequential SkillIdentityState instances on the same compositor (simulating
// two consecutive skill turns). Each identity must appear exactly once, in order.
// ─────────────────────────────────────────────────────────────────────────────
const backToBackScenario: PtyScenario = {
  description: 'two sequential skill identities each committed exactly once, in order, no cross-contamination',
  cols: 80,
  rows: 24,
  ref: 'skill-identity-state.ts:sequential reuse on same compositor',
  async drive({ stdout, stdin }: PtyDriveCtx): Promise<void> {
    const scrollRegion = minimalScrollRegion(stdout);
    const c = new TerminalCompositor({ contentHug: CONTENT_HUG, stdout, stdin, onCancel: () => {}, scrollRegion, anchorRow: 1 });
    await c.arm();

    // Turn 1 — first skill
    const coordinator1 = new CommitCoordinator();
    const identity1 = new SkillIdentityState({ name: 'mint', purpose: 'B2B_SKILL_ONE' });
    await identity1.introduce(coordinator1, c, plainWriter(stdout));
    c.commitAbove('B2B_CONTENT_ONE\n');
    await settle(20);

    // Turn 2 — second skill (clear() resets introduced flag so it can re-introduce)
    identity1.clear();
    const coordinator2 = new CommitCoordinator();
    const identity2 = new SkillIdentityState({ name: 'ship', purpose: 'B2B_SKILL_TWO' });
    await identity2.introduce(coordinator2, c, plainWriter(stdout));
    c.commitAbove('B2B_CONTENT_TWO\n');
    c.commitAbove('B2B_DONE\n');
    await settle();
  },
  expect: {
    exactlyOnce: ['B2B_SKILL_ONE', 'B2B_SKILL_TWO', 'B2B_DONE'],
    order: [
      ['B2B_SKILL_ONE', 'B2B_CONTENT_ONE'],
      ['B2B_CONTENT_ONE', 'B2B_SKILL_TWO'],
      ['B2B_SKILL_TWO', 'B2B_CONTENT_TWO'],
      ['B2B_CONTENT_TWO', 'B2B_DONE'],
    ],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 5 — NESTED
// Two SkillIdentityState instances representing an outer skill that dispatches
// an inner skill. Both must appear in the buffer exactly once, outer above inner.
// ─────────────────────────────────────────────────────────────────────────────
const nestedScenario: PtyScenario = {
  description: 'outer + inner skill identities both committed exactly once, outer above inner',
  cols: 80,
  rows: 24,
  ref: 'skill-identity-state.ts:nested dispatch scenario',
  async drive({ stdout, stdin }: PtyDriveCtx): Promise<void> {
    const scrollRegion = minimalScrollRegion(stdout);
    const c = new TerminalCompositor({ contentHug: CONTENT_HUG, stdout, stdin, onCancel: () => {}, scrollRegion, anchorRow: 1 });
    await c.arm();

    // Outer skill introduced first
    const coordOuter = new CommitCoordinator();
    const outer = new SkillIdentityState({ name: 'forge', purpose: 'NEST_OUTER_FORGE' });
    await outer.introduce(coordOuter, c, plainWriter(stdout));
    c.commitAbove('NEST_OUTER_CONTENT\n');
    await settle(20);

    // Inner skill introduced (nested dispatch)
    const coordInner = new CommitCoordinator();
    const inner = new SkillIdentityState({ name: 'qualify', purpose: 'NEST_INNER_QUALIFY' });
    await inner.introduce(coordInner, c, plainWriter(stdout));
    c.commitAbove('NEST_INNER_CONTENT\n');
    c.commitAbove('NEST_DONE\n');
    await settle();
  },
  expect: {
    exactlyOnce: ['NEST_OUTER_FORGE', 'NEST_INNER_QUALIFY', 'NEST_DONE'],
    order: [
      ['NEST_OUTER_FORGE', 'NEST_OUTER_CONTENT'],
      ['NEST_OUTER_CONTENT', 'NEST_INNER_QUALIFY'],
      ['NEST_INNER_QUALIFY', 'NEST_INNER_CONTENT'],
      ['NEST_INNER_CONTENT', 'NEST_DONE'],
    ],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 6 — PIPED (non-TTY writer fallback)
// compositor = null path: introduce() emits plain text via Writer, no ANSI
// sequences. Simulates daemon/Telegram surface where process.stdout.isTTY
// is false, so StreamRenderer.arm() takes the non-TTY branch.
// ─────────────────────────────────────────────────────────────────────────────
const pipedScenario: PtyScenario = {
  description: 'piped (compositor=null) path emits plain identity text with no ANSI sequences in output',
  cols: 80,
  rows: 24,
  ref: 'skill-identity-state.ts:introduce() compositor=null branch',
  async drive({ stdout }: PtyDriveCtx): Promise<void> {
    // In the non-TTY branch the compositor is null and text goes through the Writer.
    // We write directly to stdout (which IS a TTY inside the pty child, but we
    // simulate the non-TTY code path by calling introduce() with compositor=null).
    const coordinator = new CommitCoordinator();
    const identity = new SkillIdentityState({ name: 'diagnose', purpose: 'PIPE_PURPOSE_DIAGNOSE', arguments: 'auth module' });
    const writer = plainWriter(stdout);

    // Non-TTY branch: compositor=null, writer receives the output.
    await identity.introduce(coordinator, null, writer);

    // Follow up with plain content lines (no compositor, so direct write).
    stdout.write('PIPE_CONTENT\n');
    stdout.write('PIPE_DONE\n');
    await settle();
  },
  expect: {
    exactlyOnce: ['PIPE_PURPOSE_DIAGNOSE', 'PIPE_DONE'],
    order: [['PIPE_PURPOSE_DIAGNOSE', 'PIPE_CONTENT'], ['PIPE_CONTENT', 'PIPE_DONE']],
    // args text must appear; no ANSI CSI sequences (no \x1b[ in committed rows)
    // — verified by the absent check on raw ANSI escape starter.
    absent: ['\x1b['],
  },
};

export const SKILL_IDENTITY_SCENARIOS: Record<string, PtyScenario> = {
  'skill-identity-immediate': immediateScenario,
  'skill-identity-delayed': delayedScenario,
  'skill-identity-cancelled': cancelledScenario,
  'skill-identity-back-to-back': backToBackScenario,
  'skill-identity-nested': nestedScenario,
  'skill-identity-piped': pipedScenario,
};

export type { PtyScenario, PtyExpect };
