import { describe, it, expect, vi } from 'vitest';
import { runGlobalChatView, type GlobalChatViewDeps } from './global-chat-view.js';
import { stripAnsi } from '../../display.js';
import {
  FakeClient, FakeClock, FakeIdentity, FakeMutes, FakeStdin, FakeStdout, fakeGuards, tick, ME,
} from './global-chat-view.test-helpers.js';
import type { Msg } from '../../../global-chat/protocol.js';

function setup(over: { accepted?: boolean; identity?: typeof ME | null; pending?: () => boolean } = {}) {
  const log: string[] = [];
  const stdin = new FakeStdin();
  const stdout = new FakeStdout(log);
  const clock = new FakeClock();
  const client = new FakeClient();
  const identity = new FakeIdentity();
  if (over.accepted !== undefined) identity.accepted = over.accepted;
  if (over.identity !== undefined) identity.identity = over.identity;
  const mutes = new FakeMutes();
  const guards = fakeGuards();
  const compositor = {
    suspendInput: vi.fn(() => log.push('suspend')),
    resumeInput: vi.fn(() => log.push('resume')),
    repaint: vi.fn(() => log.push('repaint')),
  };
  const createClient = vi.fn(() => client);
  const deps: GlobalChatViewDeps = {
    compositor, stdin, stdout, clock, identity, mutes, guards, createClient,
    pauseRecording: vi.fn(() => log.push('pause')),
    resumeRecording: vi.fn(() => log.push('resumeRec')),
    ...(over.pending ? { hasPendingWork: over.pending } : {}),
  };
  return { log, stdin, stdout, clock, client, identity, mutes, guards, compositor, deps, createClient };
}
async function open(over: Parameters<typeof setup>[0] = {}) {
  const h = setup(over);
  const done = runGlobalChatView(h.deps);
  await tick();
  return { ...h, done };
}
function screen(h: { clock: FakeClock; stdout: FakeStdout }): string {
  h.stdout.writes = [];
  h.clock.flush();
  return stripAnsi(h.stdout.text());
}
let n = 0;
function msg(text: string, pubkey = 'a'.repeat(64)): Msg {
  n++;
  return { id: n.toString(16).padStart(32, '0'), ts: 1, pubkey, name: 'alice', text, sig: 'f'.repeat(128) };
}

describe('runGlobalChatView lifecycle', () => {
  it('enters, pauses recording, and on Esc leaves the alt screen before resumeInput', async () => {
    const h = await open();
    expect(h.log.slice(0, 3)).toEqual(['suspend', 'pause', 'write:ENTER']);
    expect(h.stdin.raw).toEqual([true]);
    expect(h.client.connected).toBe(1);
    h.stdin.type('\x1b'); h.clock.flush();
    expect(await h.done).toBe('left');
    const tail = h.log.slice(h.log.indexOf('write:LEAVE'));
    expect(tail).toEqual(['write:LEAVE', 'resumeRec', 'resume', 'repaint']);
    expect(h.stdin.raw.at(-1)).toBe(false);
    expect(h.stdin.listenerCount('data')).toBe(0);
    expect(h.stdout.listenerCount('resize')).toBe(0);
    expect(h.client.closed).toBe(1);
    expect(h.client.subs).toHaveLength(0);
    expect(h.guards.cleanups.size).toBe(0);
    expect(h.guards.exits.size).toBe(0);
    expect(h.clock.pending()).toBe(0);
  });

  it('Ctrl+C exits too', async () => {
    const h = await open();
    h.stdin.type('\x03');
    expect(await h.done).toBe('left');
    expect(h.compositor.resumeInput).toHaveBeenCalledOnce();
  });

  it('crash path restores the terminal exactly once and resumes recording', async () => {
    const h = await open();
    const [cleanup] = [...h.guards.cleanups];
    const [exit] = [...h.guards.exits];
    await cleanup!();
    exit!();
    expect(h.log.filter((l) => l === 'write:LEAVE')).toHaveLength(1);
    expect(h.log.filter((l) => l === 'resumeRec')).toHaveLength(1);
    expect(h.client.closed).toBe(1);
    expect(h.stdin.listenerCount('data')).toBe(0);
    // compositor is tearing down on this path; the view does not resume it
    expect(h.compositor.resumeInput).not.toHaveBeenCalled();
  });

  it('typed text goes only to client.post, and the message appears only on broadcast', async () => {
    const h = await open();
    let release!: (v: { ok: true; id: string }) => void;
    h.client.nextPost = new Promise((r) => { release = r; });
    h.stdin.type('hello world');
    h.stdin.type('\r');
    await tick();
    expect(h.client.posts).toEqual(['hello world']);
    expect(screen(h)).toContain('sending: hello world');
    release({ ok: true, id: 'x' });
    await tick();
    const after = screen(h);
    expect(after).not.toContain('hello world');
    h.client.emit('onMessage', { ...msg('hello world', ME.pubkey), name: 'me' });
    expect(screen(h)).toContain('hello world');
    expect(h.client.reports).toEqual([]);
    expect(h.client.admins).toEqual([]);
  });

  it('a failed post restores the input and explains why', async () => {
    const h = await open();
    h.client.nextPost = { ok: false, code: 'rate_limited', message: 'x', retryAfterMs: 2500 };
    h.stdin.type('again');
    h.stdin.type('\r');
    await tick();
    const s = screen(h);
    expect(s).toContain('post again in 3 seconds');
    expect(s).toContain('> again');
    h.client.nextPost = { ok: false, code: 'secret_detected', message: 'x', spans: [{ kind: 'github', start: 0, end: 4 }] };
    h.stdin.type('\r');
    await tick();
    expect(screen(h)).toContain('a GitHub token');
  });

  it('slash lines are view commands and never posted', async () => {
    const h = await open();
    h.client.emit('onMessage', msg('spam'));
    h.stdin.type('/mute 1');
    h.stdin.type('\r');
    await tick();
    expect(h.client.posts).toEqual([]);
    expect(h.mutes.items.map((m) => m.pubkey)).toEqual(['a'.repeat(64)]);
    expect(screen(h)).not.toContain('spam');
    h.stdin.type('/nope');
    h.stdin.type('\r');
    await tick();
    expect(screen(h)).toContain('Unknown command /nope');
    h.stdin.type('/report 1\r');
    await tick();
    expect(h.client.posts).toEqual([]);
  });

  it('coalesces a burst of messages into one paint', async () => {
    const h = await open();
    h.clock.flush();
    for (let i = 0; i < 20; i++) h.client.emit('onMessage', msg(`m${i}`));
    expect(h.clock.pending()).toBe(1);
  });

  it('repaints on resize at the new size', async () => {
    const h = await open();
    h.clock.flush();
    h.stdout.writes = [];
    h.stdout.columns = 30;
    h.stdout.rows = 8;
    h.stdout.emit('resize');
    expect(h.stdout.text()).toContain('\x1b[8;1H');
    expect(h.stdout.text()).not.toContain('\x1b[9;1H');
  });

  it('shows header state, scrolls with PgUp, and pastes flatten to one line', async () => {
    const h = await open();
    h.client.emit('onStatus', 'open');
    h.client.emit('onPresence', 7);
    expect(screen(h)).toContain('7 online');
    for (let i = 0; i < 40; i++) h.client.emit('onMessage', msg(`line${i}`));
    h.stdin.type('\x1b[5~');
    h.client.emit('onMessage', msg('newest'));
    expect(screen(h)).toContain('new messages below');
    h.stdin.type('\x1b[200~a\nb\x1b[201~');
    expect(screen(h)).toContain('> a b');
  });

  it('shows the waiting-results banner when the host reports pending work', async () => {
    let pending = false;
    const h = await open({ pending: () => pending });
    pending = true;
    h.stdout.writes = [];
    h.clock.flush();
    h.clock.flush();
    expect(stripAnsi(h.stdout.text())).toContain('results waiting');
  });
});

describe('runGlobalChatView onboarding', () => {
  it('declining the notice stores nothing and restores', async () => {
    const h = await open({ accepted: false, identity: null });
    expect(screen(h)).toContain('Messages are public');
    h.stdin.type('n');
    expect(await h.done).toBe('declined');
    expect(h.identity.calls).toEqual([]);
    expect(h.createClient).not.toHaveBeenCalled();
    expect(h.log).toContain('resumeRec');
  });

  it('accepting leads to the name screen with validation, then chat', async () => {
    const h = await open({ accepted: false, identity: null });
    h.stdin.type('y');
    expect(screen(h)).toContain('Pick a display name');
    h.stdin.type('A');
    expect(screen(h)).toContain('2 to 16');
    h.stdin.type('dmin');
    expect(screen(h)).toContain('reserved');
    h.stdin.type('\r');
    await tick();
    expect(h.identity.calls).toEqual(['create:admin']);
    h.stdin.type('\x15');
    h.stdin.type('neo');
    h.stdin.type('\r');
    await tick(); await tick();
    expect(h.identity.calls).toEqual(['create:admin', 'create:neo', 'accept']);
    expect(h.createClient).toHaveBeenCalledWith(expect.objectContaining({ name: 'neo' }));
    h.stdin.type('\x1b'); h.clock.flush();
    expect(await h.done).toBe('left');
  });

  it('an existing identity that turned chat off only re-accepts', async () => {
    const h = await open({ accepted: false });
    h.stdin.type('y');
    await tick(); await tick();
    expect(h.identity.calls).toEqual(['accept']);
    expect(h.createClient).toHaveBeenCalledOnce();
    h.stdin.type('\x03');
    await h.done;
  });

  it('an Esc split from the rest of a PgUp or paste is not read as leave', async () => {
    const h = await open();
    h.stdin.type('\x1b');
    h.stdin.type('[5~');
    h.stdin.type('\x1b');
    h.stdin.type('[200~split paste\x1b[201~');
    expect(screen(h)).toContain('> split paste');
    expect(h.compositor.resumeInput).not.toHaveBeenCalled();
    h.stdin.type('\x1b'); h.clock.flush();
    expect(await h.done).toBe('left');
  });
});
