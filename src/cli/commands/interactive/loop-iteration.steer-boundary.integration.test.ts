/**
 * PTY integration tests for AFK_STEER_MODE=boundary mid-turn steering (#3897).
 *
 * Satisfies the "PTY test covering type-during-tool-round" acceptance criterion
 * from issue #3897. Uses a REAL InputSurface + compositor so that keypress events
 * flow through the actual peekQueuedText / dropQueued path that setupPeerBoundary
 * relies on in boundary mode.
 *
 * No paid model calls — providers are faked with in-process callbacks, matching
 * the pattern in loop-iteration.human-priority.integration.test.ts.
 *
 * Acceptance criteria verified here:
 *   ✓ Text typed during a multi-round turn is visible to the model at the next
 *     boundary (boundary() returns the text mid-turn for the provider to inject).
 *   ✓ No phantom turn: dropQueued fires before idle drain, so the drained text
 *     does NOT reappear as a new turn.
 *   ✓ Slash commands typed mid-turn are NOT drained (REPL dispatch preserved).
 *   ✓ Default (turn-end) mode is unchanged: boundary returns undefined.
 *
 * Implementation note: inside the execute mock the compositor is in 'idle' mode
 * (the loop transitions to idle to drain a turn). To simulate mid-turn keypress
 * (user typing while a tool round runs), call compositor.setInputMode('streaming')
 * before submit(), then verify the boundary callback. This matches the real
 * scenario where the provider loop keeps the compositor in streaming during tool
 * rounds and the user types a correction.
 */

import { afterEach, expect, it } from 'vitest';
import { vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { InputSurface } from '../../input/input-surface.js';
import { runInputLoop } from './loop-iteration.js';
import type { InteractiveCtx } from './shared.js';
import type { FooterSubsystems } from './footer-subsystems.js';

// ── Module mocks ─────────────────────────────────────────────────────────────

const execute = vi.hoisted(() => vi.fn());
vi.mock('./turn-handler.js', () => ({ runTurn: execute }));
vi.mock('../../../agent/tools/handlers/wait-for-conditions.js', () => ({
  evaluateCommand: () => ({ met: false, detail: 'command exited 1' }),
}));
vi.mock('./momentum-ticker.js', () => ({
  MomentumTicker: class { start() {} stop() {} update() {} },
}));
vi.mock('./loop-iteration.drain.js', () => ({ drainLoopNotifications: vi.fn() }));
vi.mock('./loop-iteration.first-turn.js', () => ({ runFirstTurnHookIfNeeded: vi.fn() }));
vi.mock('./loop-iteration.hooks.js', () => ({
  dispatchUserPromptSubmit: async (runText: string) => ({ runText }),
}));
vi.mock('./version-notice.js', () => ({ createVersionNotice: () => () => undefined }));
vi.mock('../../slash/plugin-skills.js', () => ({
  autoRegisterPluginPassthroughs: vi.fn(),
  getPluginShadowingNoticeLines: () => [],
  setInitBarrier: vi.fn(),
}));
vi.mock('./loop-iteration.slash-branch.js', () => ({
  handleSlashCommand: async (text: string) =>
    text === '/queued-steer'
      ? { action: 'submit', message: 'queued-steer' }
      : { action: 'exit' },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function source(pending = '') {
  return {
    pending,
    onInjectable: null as (() => void) | null,
    hasPendingInjections() { return this.pending.length > 0; },
    drainInjections() { const out = this.pending; this.pending = ''; return out; },
    peekEnvelopes() {
      return this.pending
        ? [{ envelope: { v: 1 as const, messageId: 'peer-id', from: { id: 'sender' },
            to: 'receiver', ts: '2026-10-04T00:00:00Z', hop: 0, body: this.pending } }]
        : [];
    },
    consumeEnvelopes: vi.fn(),
  };
}

const surfaces: InputSurface[] = [];
afterEach(async () => {
  execute.mockReset();
  await Promise.all(surfaces.splice(0).map((s) => s.dispose()));
});

async function harness() {
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode: vi.fn() });
  const history = { back: () => null, forward: () => null, resetRecall() {}, inRecall: false };
  const surface = new InputSurface({ rl: {} as never, history });
  surfaces.push(surface);
  await surface.armCompositor({
    promptFn: () => 'afk › ',
    onCancel() {},
    stdout: stdout as never,
    stdin: stdin as never,
  });
  const compositor = surface.getCompositor()!;

  const submit = (text: string) => {
    for (const ch of text) stdin.emit('keypress', ch, { name: ch, sequence: ch });
    stdin.emit('keypress', undefined, { name: 'return' });
  };

  let boundary: (() => string | undefined) | undefined;
  const peer = source();
  const bg = source();
  const shell = source();

  const ctx = {
    options: { maxTurns: '10' },
    stats: { permissionMode: 'default' },
    session: {
      current: {
        waitForInitialization: async () => ({}),
        takePendingPlanExitSeed: async () => undefined,
        setBeforeNextRound: (cb: typeof boundary) => { boundary = cb; },
      },
    },
    replRenderer: { writeLine: vi.fn() },
    statusLine: { rearm: vi.fn(), repaint: vi.fn() },
  } as unknown as InteractiveCtx;

  const run = () =>
    runInputLoop(ctx, {} as never, {} as never, vi.fn(), surface, vi.fn(),
      { peerNotifier: peer, bgResultNotifier: bg, shellPassthrough: shell,
        mascotBar: { releaseBand: vi.fn() } } as unknown as FooterSubsystems,
      { push: vi.fn() } as never);

  return {
    run, surface, compositor, submit, peer,
    boundary: () => boundary?.(),
  };
}

// ── PTY tests: type-during-tool-round ────────────────────────────────────────

it('boundary mode: text typed mid-turn is delivered at the inter-round boundary (no phantom turn)', async () => {
  // Acceptance criteria:
  //   1. boundary() returns queued text so the provider can inject it mid-turn.
  //   2. dropQueued fires — queue empty after drain, no phantom turn on idle.
  const origMode = process.env['AFK_STEER_MODE'];
  process.env['AFK_STEER_MODE'] = 'boundary';
  try {
    const h = await harness();

    // Submit the first (and only) task before run().
    h.compositor.setInputMode('streaming');
    h.submit('initial-task');

    let steerCaptured: string | undefined;
    const prompts: string[] = [];

    execute.mockImplementation(async ({ text }: { text: string }) => {
      prompts.push(text);

      if (text === 'initial-task') {
        // Re-arm streaming to simulate "compositor is in streaming during a
        // tool round" — the real provider loop maintains this state.
        h.compositor.setInputMode('streaming');

        // Simulate mid-turn keypress: user types a correction while a tool runs.
        h.submit('focus on the auth module');

        // Real compositor must have queued the message.
        expect(h.compositor.hasPendingSubmission()).toBe(true);

        // Simulate inter-round boundary (Anthropic/OpenAI provider loops call
        // the beforeNextRound callback between tool rounds):
        const steer = h.boundary();
        steerCaptured = steer;

        // Criterion 1: boundary returns the text for the provider to inject.
        expect(steer).toBe('focus on the auth module');
        // Criterion 2: queue is empty — dropQueued fired, no phantom turn.
        expect(h.compositor.getPendingCount()).toBe(0);
      }
      // After drain the queue is empty; submit '/exit' for the loop to stop.
      h.submit('/exit');
      h.compositor.setInputMode('idle');
    });

    await h.run();

    expect(steerCaptured).toBe('focus on the auth module');
    // 'focus on the auth module' must NOT appear as a turn prompt — it was steered.
    expect(prompts.some((p) => p.includes('focus on the auth module'))).toBe(false);
    expect(prompts).toContain('initial-task');
  } finally {
    if (origMode === undefined) delete process.env['AFK_STEER_MODE'];
    else process.env['AFK_STEER_MODE'] = origMode;
  }
});

it('turn-end mode (default): boundary never drains; typed text runs as its own turn', async () => {
  // Guard rail: default mode must not change. boundary() returns undefined;
  // the correction arrives as a separate turn (turn-end semantics).
  const origMode = process.env['AFK_STEER_MODE'];
  delete process.env['AFK_STEER_MODE']; // default = 'turn-end'
  try {
    const h = await harness();

    h.compositor.setInputMode('streaming');
    h.submit('initial-task');

    const prompts: string[] = [];

    execute.mockImplementation(async ({ text }: { text: string }) => {
      prompts.push(text);

      if (text === 'initial-task') {
        h.compositor.setInputMode('streaming');
        // Type a correction mid-turn.
        h.submit('steer-queued-as-turn');

        // turn-end mode: boundary must NOT drain.
        expect(h.boundary()).toBeUndefined();
        // Queue intact — the typed text is still pending.
        expect(h.compositor.getPendingCount()).toBeGreaterThan(0);

        // In turn-end mode, the correction runs as its own separate turn when
        // the compositor transitions to idle. End this turn without pre-submitting
        // an exit, so the loop can drain 'steer-queued-as-turn' as the next turn.
        h.compositor.setInputMode('idle');
      } else if (text === 'steer-queued-as-turn') {
        // Correction ran as its own separate turn — turn-end semantics confirmed.
        h.submit('/exit');
        h.compositor.setInputMode('idle');
      } else {
        h.compositor.setInputMode('idle');
      }
    });

    await h.run();

    // The correction must have run as its own turn.
    expect(prompts).toContain('steer-queued-as-turn');
  } finally {
    if (origMode === undefined) delete process.env['AFK_STEER_MODE'];
    else process.env['AFK_STEER_MODE'] = origMode;
  }
});

it('boundary mode: slash command typed mid-turn is NOT drained (REPL dispatch path preserved)', async () => {
  // /cmd payloads require slash resolution / plugin forwarding. Draining them
  // mid-turn would send raw command text to the model, bypassing dispatch.
  const origMode = process.env['AFK_STEER_MODE'];
  process.env['AFK_STEER_MODE'] = 'boundary';
  try {
    const h = await harness();

    h.compositor.setInputMode('streaming');
    h.submit('initial-task');

    execute.mockImplementation(async ({ text }: { text: string }) => {
      if (text === 'initial-task') {
        h.compositor.setInputMode('streaming');
        h.submit('/queued-steer');

        // Boundary must NOT drain the slash command.
        expect(h.boundary()).toBeUndefined();
        // Slash still queued.
        expect(h.compositor.getPendingCount()).toBeGreaterThan(0);
      }
      h.submit('/exit');
      h.compositor.setInputMode('idle');
    });

    await h.run();
  } finally {
    if (origMode === undefined) delete process.env['AFK_STEER_MODE'];
    else process.env['AFK_STEER_MODE'] = origMode;
  }
});

it('boundary mode: peer deferred while human steer is consumed (human-first invariant)', async () => {
  // While the boundary drains a human message, peers must wait.
  const origMode = process.env['AFK_STEER_MODE'];
  process.env['AFK_STEER_MODE'] = 'boundary';
  try {
    const h = await harness();

    h.compositor.setInputMode('streaming');
    h.submit('initial-task');

    execute.mockImplementation(async ({ text }: { text: string }) => {
      if (text === 'initial-task') {
        h.compositor.setInputMode('streaming');
        h.submit('steer this round');
        h.peer.pending = 'peer-wants-in\n\n';

        // Human wins; boundary returns human text, not peer.
        const steer = h.boundary();
        expect(steer).toBe('steer this round');
        // Peer still in notifier buffer.
        expect(h.peer.pending).toBe('peer-wants-in\n\n');
      }
      h.submit('/exit');
      h.compositor.setInputMode('idle');
    });

    await h.run();
  } finally {
    if (origMode === undefined) delete process.env['AFK_STEER_MODE'];
    else process.env['AFK_STEER_MODE'] = origMode;
  }
});
