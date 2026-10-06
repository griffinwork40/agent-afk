import { beforeEach, expect, it, vi } from 'vitest';
import { runInputLoop } from './loop-iteration.js';
import { renderPeerMessageBlock, type PeerEnvelope } from '../../../agent/peer/envelope.js';
import type { InteractiveCtx } from './shared.js';
import type { InputSurface } from '../../input/input-surface.js';
import type { FooterSubsystems } from './footer-subsystems.js';

const turn = vi.hoisted(() => vi.fn(async () => ({ kind: 'done' })));
vi.mock('./loop-iteration.turn-run.js', () => ({ runOneTurn: turn }));
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
  handleSlashCommand: async (text: string) => text === '/seed'
    ? { action: 'submit', message: '[auto-resume] genuine slash text' } : { action: 'exit' },
  runPluginPreflight: vi.fn(),
}));
const peerDirective = '[auto-resume] A message from another afk session arrived above. Handle it per the peer-message rules; reply with send_to_session only if a reply is useful.';
const bgDirective = '[auto-resume] The background task above has finished. Continue the work it was dispatched for.';
const envelope: PeerEnvelope = {
  v: 1, messageId: 'message-id', from: { id: 'sender-id', name: 'A < B' },
  to: 'receiver', ts: '2026-10-03T00:00:00Z', hop: 1, replyTo: 'prior-id', body: 'full <body> &\nsecond line',
};
const peerContext = renderPeerMessageBlock(envelope) + '\n\n';
function source() {
  return {
    pending: '', onInjectable: null as (() => void) | null,
    hasPendingInjections() { return this.pending !== ''; },
    drainInjections() { const value = this.pending; this.pending = ''; return value; },
  };
}
function harness(opts: { peer?: boolean; bg?: boolean; typed?: string; initial?: string; plan?: string; slash?: boolean } = {}) {
  const peer = source(), bg = source(), shell = source();
  const writes = vi.fn();
  let awaiting = false, buffer = opts.typed ?? '', reads = 0;
  let resolveRead: ((value: { text: string; attachments: [] }) => void) | undefined;
  const surface = {
    getCompositor: () => null,
    onAwaitingInput: undefined as (() => void) | undefined,
    isAwaitingInput: () => awaiting, bufferIsEmpty: () => buffer === '',
    abortPendingRead: vi.fn(() => { awaiting = false; resolveRead?.({ text: '', attachments: [] }); }),
    readLine: vi.fn(() => {
      reads++;
      if (reads > 1 || (!opts.peer && !opts.bg)) {
        return Promise.resolve({ text: reads === 1 && opts.slash ? '/seed' : '/exit', attachments: [] });
      }
      return new Promise<{ text: string; attachments: [] }>((resolve) => {
        resolveRead = resolve; awaiting = true;
        if (opts.peer) peer.pending = peerContext;
        if (opts.bg) bg.pending = '<background-result/>\n\n';
        shell.pending = '<shell-output/>\n\n';
        peer.onInjectable?.(); bg.onInjectable?.(); surface.onAwaitingInput?.();
        if (opts.typed) {
          expect(surface.abortPendingRead).not.toHaveBeenCalled();
          expect(buffer).toBe(opts.typed);
          expect(turn).not.toHaveBeenCalled();
          awaiting = false;
          resolve({ text: buffer, attachments: [] });
          buffer = '';
        }
      });
    }),
  };
  const ctx = {
    initialInput: opts.initial, options: { maxTurns: '10' }, stats: { permissionMode: 'default' },
    session: { current: { waitForInitialization: async () => ({}),
      takePendingPlanExitSeed: vi.fn().mockResolvedValueOnce(opts.plan ? { message: opts.plan, mode: 'default' } : undefined),
    } }, replRenderer: { writeLine: writes }, statusLine: { rearm: vi.fn() },
  } as unknown as InteractiveCtx;
  const run = () => runInputLoop(ctx, {} as never, {} as never, vi.fn(), surface as unknown as InputSurface,
    vi.fn(), { peerNotifier: peer, bgResultNotifier: bg, shellPassthrough: shell } as unknown as FooterSubsystems,
    { push: vi.fn() } as never);
  return { run, writes, surface, peer, bg };
}
beforeEach(() => turn.mockClear());
it.each([{ peer: true }, { bg: true }, { peer: true, bg: true }])('silences automatic wake %j without changing model inputs', async (opts) => {
  const h = harness(opts);
  await h.run();
  expect(turn).toHaveBeenCalledTimes(1);
  const args = turn.mock.calls[0] as unknown as unknown[];
  const directive = opts.bg ? bgDirective : peerDirective;
  expect(args[0]).toBe((opts.peer ? peerContext : '') + (opts.bg ? '<background-result/>\n\n' : '') + '<shell-output/>\n\n' + directive);
  expect(args[10]).toBe(directive);
  expect(h.writes).not.toHaveBeenCalled();
  expect(h.peer.pending + h.bg.pending).toBe('');
  expect(h.surface.abortPendingRead).toHaveBeenCalled();
});
it('protects half-typed input and preserves injections until submission', async () => {
  const h = harness({ peer: true, bg: true, typed: '[auto-resume] human text' });
  await h.run();
  expect(h.surface.abortPendingRead).not.toHaveBeenCalled();
  expect((turn.mock.calls[0] as unknown as unknown[])[0]).toBe(peerContext + '<background-result/>\n\n<shell-output/>\n\n[auto-resume] human text');
});
it.each([
  { initial: '[auto-resume] genuine initial text', expected: '[auto-resume] genuine initial text' },
  { plan: 'implement plan', expected: 'implement plan' },
  { slash: true, expected: '[auto-resume] genuine slash text' },
])('keeps ordinary seed echo: %j', async ({ expected, ...opts }) => {
  const h = harness(opts);
  await h.run();
  expect(h.writes.mock.calls.some(([line]) => String(line).includes(expected))).toBe(true);
  expect((turn.mock.calls[0] as unknown as unknown[])[0]).toBe(expected);
});
