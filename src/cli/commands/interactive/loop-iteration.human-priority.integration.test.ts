import { afterEach, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { InputSurface } from '../../input/input-surface.js';
import { runInputLoop } from './loop-iteration.js';
import { waitForHandler } from '../../../agent/tools/handlers/wait-for.js';
import type { InteractiveCtx } from './shared.js';
import type { FooterSubsystems } from './footer-subsystems.js';

const execute = vi.hoisted(() => vi.fn());
vi.mock('./turn-handler.js', () => ({ runTurn: execute }));
vi.mock('../../../agent/tools/handlers/wait-for-conditions.js', () => ({
  evaluateCommand: () => ({ met: false, detail: 'command exited 1' }),
}));
vi.mock('./momentum-ticker.js', () => ({ MomentumTicker: class { start() {} stop() {} update() {} } }));
vi.mock('./loop-iteration.drain.js', () => ({ drainLoopNotifications: vi.fn() }));
vi.mock('./loop-iteration.first-turn.js', () => ({ runFirstTurnHookIfNeeded: vi.fn() }));
vi.mock('./loop-iteration.hooks.js', () => ({
  dispatchUserPromptSubmit: async (runText: string) => ({ runText }),
}));
vi.mock('./version-notice.js', () => ({ createVersionNotice: () => () => undefined }));
vi.mock('../../slash/plugin-skills.js', () => ({
  autoRegisterPluginPassthroughs: vi.fn(), getPluginShadowingNoticeLines: () => [],
}));
vi.mock('./loop-iteration.slash-branch.js', () => ({
  handleSlashCommand: async (text: string) => text === '/queued'
    ? { action: 'submit', message: 'H1' } : { action: 'exit' },
}));

function source(pending = '') {
  return {
    pending, onInjectable: null as (() => void) | null,
    hasPendingInjections() { return this.pending.length > 0; },
    drainInjections() { const out = this.pending; this.pending = ''; return out; },
    peekEnvelopes() { return this.pending ? [{ envelope: { v: 1, messageId: 'peer-id',
      from: { id: 'sender' }, to: 'receiver', ts: '2026-10-04T00:00:00Z', hop: 0, body: 'peer body' } }] : []; },
    consumeEnvelopes: vi.fn(),
  };
}
const surfaces: InputSurface[] = [];
afterEach(async () => { execute.mockReset(); await Promise.all(surfaces.splice(0).map(s => s.dispose())); });

async function harness() {
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode: vi.fn() });
  const history = { back: () => null, forward: () => null, resetRecall() {}, inRecall: false };
  const surface = new InputSurface({ rl: {} as never, history });
  surfaces.push(surface);
  await surface.armCompositor({ promptFn: () => 'afk › ', onCancel() {}, stdout: stdout as never, stdin: stdin as never });
  const compositor = surface.getCompositor()!;
  const submit = (text: string) => {
    for (const ch of text) stdin.emit('keypress', ch, { name: ch, sequence: ch });
    stdin.emit('keypress', undefined, { name: 'return' });
  };
  let boundary: (() => string | undefined) | undefined;
  const peer = source(), bg = source(), shell = source();
  const ctx = {
    options: { maxTurns: '10' }, stats: { permissionMode: 'default' },
    session: { current: { waitForInitialization: async () => ({}),
      takePendingPlanExitSeed: async () => undefined,
      setBeforeNextRound: (cb: typeof boundary) => { boundary = cb; },
    } }, replRenderer: { writeLine: vi.fn() }, statusLine: { rearm: vi.fn(), repaint: vi.fn() },
  } as unknown as InteractiveCtx;
  const run = () => runInputLoop(ctx, {} as never, {} as never, vi.fn(), surface, vi.fn(),
    { peerNotifier: peer, bgResultNotifier: bg, shellPassthrough: shell } as unknown as FooterSubsystems,
    { push: vi.fn() } as never);
  return { run, surface, compositor, submit, peer, bg, shell, boundary: () => boundary?.() };
}

it.each(['H1', '/queued'])('keeps %s and H2 ahead of peer context through routing and execution', async first => {
  const h = await harness();
  h.compositor.setInputMode('streaming');
  h.submit(first); h.submit('H2');
  h.peer.pending = '<peer-context/>\n\n';
  h.bg.pending = '<bg-context/>\n\n';
  h.shell.pending = '<shell-context/>\n\n';
  const prompts: string[] = [];
  execute.mockImplementation(async ({ text }: { text: string }) => {
    prompts.push(text);
    if (prompts.length <= 2) {
      expect(h.boundary()).toBeUndefined();
      expect(h.peer.pending).toBe('<peer-context/>\n\n');
      expect(h.peer.consumeEnvelopes).not.toHaveBeenCalled();
      expect(h.compositor.getPendingCount()).toBe(prompts.length === 1 ? 1 : 0);
    } else {
      expect(h.peer.pending).toBe('');
      h.submit('/exit');
    }
    h.compositor.setInputMode('idle');
  });
  await h.run();
  expect(prompts).toHaveLength(3);
  expect(prompts[0]).toBe('<bg-context/>\n\n<shell-context/>\n\nH1');
  expect(prompts[1]).toBe('H2');
  expect(prompts[2]?.match(/<peer-context\/>/g)).toHaveLength(1);
});

it('wait_for yields without consuming humans; the yielded human executes without peers', async () => {
  const h = await harness();
  h.compositor.setInputMode('streaming'); h.submit('H1');
  h.peer.pending = '<peer-context/>\n\n';
  const yielded = await waitForHandler({ type: 'command', command: 'false' }, new AbortController().signal,
    { userAttention: { hasPendingUserMessage: () => h.compositor.hasPendingSubmission() } });
  expect(yielded.content).toContain('Wait yielded_to_user');
  expect(yielded.content).toContain('End your turn now');
  expect(h.compositor.getPendingCount()).toBe(1);
  const prompts: string[] = [];
  execute.mockImplementation(async ({ text }: { text: string }) => {
    prompts.push(text);
    if (prompts.length === 1) { expect(h.boundary()).toBeUndefined(); expect(h.peer.pending).not.toBe(''); }
    else h.submit('/exit');
    h.compositor.setInputMode('idle');
  });
  await h.run();
  expect(prompts[0]).toBe('H1');
  expect(prompts[1]).toContain('<peer-context/>');
});
