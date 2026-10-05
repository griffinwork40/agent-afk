/** Deterministic continuation tests for resume/reset/dispose races. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PeerInboxNotifier } from './peer-inbox-notifier.js';
import { scanPeerInbox } from './peer-inbox-scan.js';
import { listHeld, releaseHeld, claimPending } from '../../../agent/peer/inbox-store.js';
import { mkdir, watch } from 'fs/promises';
import type { PeerEnvelope } from '../../../agent/peer/envelope.js';

vi.mock('./peer-inbox-scan.js', () => ({ scanPeerInbox: vi.fn() }));
vi.mock('../../../agent/peer/inbox-store.js', () => ({ listHeld: vi.fn(), releaseHeld: vi.fn(), claimPending: vi.fn() }));
vi.mock('fs/promises', () => ({ mkdir: vi.fn(), watch: vi.fn() }));
vi.mock('../../../agent/awareness/presence.peer.js', () => ({
  setPresencePeerInbox: vi.fn(), setPresenceName: vi.fn(),
  resolveTmuxLabel: vi.fn(), setPresenceNameIfUnset: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
const envelope: PeerEnvelope = { v: 1, messageId: 'old', to: 'A', from: { id: 'sender' }, hop: 0, ts: '2026-10-02T00:00:00.000Z', body: 'old body' };
function harness() {
  let id = 'A';
  const line = vi.fn();
  const notifier = new PeerInboxNotifier({ getSessionId: () => id, writeLine: line, mode: () => 'accept', pollMs: 100_000 });
  notifier.onInjectable = vi.fn();
  return { notifier, line, setId: (value: string) => { id = value; } };
}
afterEach(() => vi.resetAllMocks());

function invalidate(h: ReturnType<typeof harness>, kind: string) {
  if (kind === 'dispose') h.notifier.dispose();
  else if (kind === 'id-change') h.setId('B');
  else {
    h.setId('B'); h.notifier.resetForNewSession();
    h.setId('A'); h.notifier.resetForNewSession();
  }
}

describe('stale scan results', () => {
  it.each(['dispose', 'id-change', 'A-B-A'])('rejects claimed and held results after %s', async (kind) => {
    const gate = deferred<Awaited<ReturnType<typeof scanPeerInbox>>>();
    vi.mocked(scanPeerInbox).mockReturnValueOnce(gate.promise);
    const h = harness();
    const running = h.notifier.scan();
    invalidate(h, kind);
    gate.resolve({ claimed: [envelope], held: [{ envelope, reason: 'inbound-hold' }] });
    await running;
    expect(h.notifier.drainInjections()).toBe('');
    expect(h.line).not.toHaveBeenCalled();
    expect(h.notifier.onInjectable).not.toHaveBeenCalled();
  });
});

describe('forceAccept continuations', () => {
  it.each(['listHeld', 'releaseHeld', 'claimPending'])('A-B-A reset while %s awaits discards outgoing work', async (stage) => {
    const listed = [{ file: 'old.json', envelope }];
    vi.mocked(listHeld).mockResolvedValue(listed);
    vi.mocked(releaseHeld).mockResolvedValue(true);
    vi.mocked(claimPending).mockResolvedValue(envelope);
    const gate = deferred<unknown>();
    if (stage === 'listHeld') vi.mocked(listHeld).mockReturnValueOnce(gate.promise as Promise<typeof listed>);
    if (stage === 'releaseHeld') vi.mocked(releaseHeld).mockReturnValueOnce(gate.promise as Promise<boolean>);
    if (stage === 'claimPending') vi.mocked(claimPending).mockReturnValueOnce(gate.promise as Promise<PeerEnvelope>);
    const h = harness();
    const running = h.notifier.forceAccept('all');
    await vi.waitFor(() => expect(stage === 'listHeld' ? listHeld : stage === 'releaseHeld' ? releaseHeld : claimPending).toHaveBeenCalledOnce());
    invalidate(h, 'A-B-A');
    gate.resolve(stage === 'listHeld' ? listed : stage === 'releaseHeld' ? true : envelope);
    expect(await running).toBe(0);
    expect(h.notifier.drainInjections()).toBe('');
    expect(h.line).not.toHaveBeenCalled();
    expect(h.notifier.onInjectable).not.toHaveBeenCalled();
    if (stage === 'listHeld') expect(releaseHeld).not.toHaveBeenCalled();
    if (stage !== 'claimPending') expect(claimPending).not.toHaveBeenCalled();
  });

  it.each(['dispose', 'id-change'])('rejects a deferred claimed envelope after %s', async (kind) => {
    vi.mocked(listHeld).mockResolvedValue([{ file: 'old.json', envelope }]);
    vi.mocked(releaseHeld).mockResolvedValue(true);
    const gate = deferred<PeerEnvelope>();
    vi.mocked(claimPending).mockReturnValue(gate.promise);
    const h = harness();
    const running = h.notifier.forceAccept('all');
    await vi.waitFor(() => expect(claimPending).toHaveBeenCalledOnce());
    invalidate(h, kind);
    gate.resolve(envelope);
    expect(await running).toBe(0);
    expect(h.line).not.toHaveBeenCalled();
    expect(h.notifier.onInjectable).not.toHaveBeenCalled();
  });
});

it.each(['dispose', 'id-change', 'A-B-A'])('%s during watcher setup cannot resurrect the old watcher', async (kind) => {
  const gate = deferred<void>();
  vi.mocked(mkdir).mockReturnValueOnce(gate.promise as Promise<undefined>);
  vi.mocked(mkdir).mockResolvedValue(undefined);
  vi.mocked(scanPeerInbox).mockResolvedValue({ claimed: [], held: [] });
  const h = harness();
  h.notifier.start();
  invalidate(h, kind);
  gate.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(watch).not.toHaveBeenCalled();
  h.notifier.dispose();
});
