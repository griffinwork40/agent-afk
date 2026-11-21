/**
 * PTY driver for the global chat view. Runs INSIDE a real pty: arms a real
 * TerminalCompositor (with a ticking StatusLine footer, the periodic writer the
 * REPL suspends), commits some main-screen content, then runs the REAL /global
 * slash handler against an in-memory scripted ChatClient. Spawned by
 * tests/pty/global-chat.pty.test.ts as:
 *
 *     node --import tsx tests/pty/global-chat-driver.ts <scenario>
 *
 * Side channel: events (posts, identity creates, lifecycle) are appended as
 * JSON lines to the file named by GC_LOG so the parent can assert on calls
 * without writing markers into the terminal stream. SIGUSR2 delivers the next
 * queued live message (the parent decides WHEN a message arrives).
 */
import { appendFileSync } from 'node:fs';
import { TerminalCompositor } from '../../src/cli/terminal-compositor.js';
import { StatusLine } from '../../src/cli/status-line.js';
import { createGlobalCommand } from '../../src/cli/slash/commands/global.js';
import type { SlashContext } from '../../src/cli/slash/types.js';
import type { ChatPostResult } from '../../src/global-chat/client-types.js';
import type { Msg } from '../../src/global-chat/protocol.js';
import { runCleanupFunctions } from '../../src/utils/cleanupRegistry.js';
import {
  FakeClient, FakeIdentity, FakeMutes, ME,
} from '../../src/cli/commands/interactive/global-chat-view.test-helpers.js';
import { PTY_DONE_SENTINEL } from './constants.js';

const LOG = process.env['GC_LOG'] ?? '';
function log(ev: Record<string, unknown>): void {
  if (LOG) appendFileSync(LOG, `${JSON.stringify(ev)}\n`);
}
const settle = (ms = 60): Promise<void> => new Promise((r) => setTimeout(r, ms));

let idc = 0;
function msg(name: string, text: string, pubkey = 'a'.repeat(64)): Msg {
  idc++;
  return { id: idc.toString(16).padStart(32, '0'), ts: 1_700_000_000_000 + idc, pubkey, name, text, sig: 'f'.repeat(128) };
}

/** Text a hostile peer could send: OSC 52 clipboard write, title set, cursor moves, bidi override. */
export const HOSTILE_TEXT =
  'HOSTILE_A\x1b]52;c;cHduZWQ=\x07\x1b]0;PWNED_TITLE\x07\x1b[2;2H\x1b[1A\u202eHOSTILE_B';

class ScriptedClient extends FakeClient {
  live: Msg[] = [];
  constructor(private readonly backlog: Msg[]) { super(); }
  override async connect(): Promise<void> {
    this.connected++;
    log({ ev: 'connect' });
    setTimeout(() => {
      this.emit('onStatus', 'open');
      this.emit('onWelcome', { online: 3, mode: 'open', backlog: this.backlog, you: { ...ME } });
    }, 20);
  }
  override async post(text: string): Promise<ChatPostResult> {
    this.posts.push(text);
    log({ ev: 'post', text });
    await settle(20);
    if (text.includes('refuseme')) return { ok: false, code: 'rate_limited', message: 'slow down', retryAfterMs: 5000 };
    const echo = msg(ME.name, text, ME.pubkey);
    setTimeout(() => this.emit('onMessage', echo), 40);
    return { ok: true, id: echo.id };
  }
  override close(): void { this.closed++; log({ ev: 'close' }); }
  deliverNext(): void {
    const m = this.live.shift();
    if (m) { log({ ev: 'deliver', text: m.text }); this.emit('onMessage', m); }
  }
}

function backlog(n: number): Msg[] {
  return Array.from({ length: n }, (_, i) => msg('alice', `BACKLOG_${String(i).padStart(2, '0')} hello`));
}

async function main(): Promise<void> {
  const scenario = process.argv[2] ?? 'chat';
  const { stdout, stdin } = process;
  if (!stdout.isTTY) { process.stderr.write('global-chat-driver: not a TTY\n'); process.exit(66); }

  // Periodic footer writer: the real REPL's StatusLine ticks; ticking at 50ms
  // makes any paint over the alternate screen visible within the test window.
  const statusLine = new StatusLine({ stream: stdout, force: true, throttleMs: 0, tickMs: 50 });
  statusLine.start();
  statusLine.repaint({ model: 'FOOTERMODEL', cost: 0, tokens: 0, contextPct: 0 });
  let submitted: string | null = null;
  const c = new TerminalCompositor({
    stdout, stdin, onCancel: () => {}, scrollRegion: statusLine, anchorRow: 1,
    onSubmit: (p) => { submitted = p.text; log({ ev: 'submit', text: p.text }); },
  });
  await c.arm();
  c.setInputMode('idle'); // the REPL between turns: the prompt accepts typing
  for (let i = 0; i < 3; i++) c.commitAbove(`MAINSCREEN_LINE_${i}\n`);
  await settle();

  const identity = new FakeIdentity();
  if (scenario === 'onboard') { identity.accepted = false; identity.identity = null; }
  const origCreate = identity.create.bind(identity);
  identity.create = async (name: string) => { log({ ev: 'create', name }); return origCreate(name); };
  const client = new ScriptedClient(backlog(scenario === 'onboard' ? 2 : 30));
  client.live.push(msg('bob', 'LIVE_WHILE_SCROLLED from bob'), msg('mallory', HOSTILE_TEXT, 'e'.repeat(64)));
  process.on('SIGUSR2', () => client.deliverNext());
  // Mirror interactive.signal-handlers.ts makeTermHupHandler: run the cleanup
  // registry, then exit.
  process.on('SIGTERM', () => { log({ ev: 'sigterm' }); void runCleanupFunctions().finally(() => process.exit(0)); });

  const cmd = createGlobalCommand({
    relayUrl: 'wss://relay.invalid', isInteractiveTerminal: () => true,
    createIdentityStore: () => identity, createMuteStore: () => new FakeMutes(),
    createClient: () => client,
    pauseRecording: () => log({ ev: 'pauseRec' }), resumeRecording: () => log({ ev: 'resumeRec' }),
  });
  const out = { line: (t = '') => c.commitAbove(`${t}\n`), raw: (t: string) => c.commitAbove(t) };
  const ctx = {
    out: { ...out, success: out.line, info: out.line, warn: out.line, error: out.line },
    getCompositor: () => c,
    suspendFooter: () => { log({ ev: 'suspendFooter' }); statusLine.stop(); },
    resumeFooter: () => { log({ ev: 'resumeFooter' }); statusLine.start(); statusLine.repaint({ model: 'FOOTERMODEL', cost: 0, tokens: 0, contextPct: 0 }); },
  } as unknown as SlashContext;

  log({ ev: 'open' });
  if (scenario !== 'control') await cmd.handler(ctx, '');
  log({ ev: 'closed', posts: client.posts, closed: client.closed, createCalls: identity.calls });
  c.commitAbove('AFTER_VIEW_MARKER\n');

  // The REPL prompt must be live again: wait for the parent to type + Enter.
  const deadline = Date.now() + 8000;
  while (submitted === null && Date.now() < deadline) await settle(30);
  log({ ev: 'done', submitted });
  await settle(120);
  stdout.write(PTY_DONE_SENTINEL);
  await settle(60);
  process.exit(0);
}

void main().catch((err) => { process.stderr.write(`global-chat-driver: ${(err as Error)?.stack ?? String(err)}\n`); process.exit(1); });
