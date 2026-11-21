/**
 * Full-screen global chat view: one terminal takeover covering the first-run
 * notice, the name screen, and the chat room, then one exact restore.
 *
 * External constraint: the REPL compositor owns stdin and the main screen.
 * `suspendInput()` yields both; the view paints on the alternate screen and
 * must leave it before `resumeInput()` (see `global-chat-terminal.ts`).
 *
 * Contract: nothing shown here goes to `ctx.out`, the transcript, or any REPL
 * output path. Typed text reaches only `client.post`.
 *
 * @module cli/commands/interactive/global-chat-view
 */

import { NOTICE_VERSION } from '../../../global-chat/client-types.js';
import type { ChatClient, ChatIdentity, IdentityStore, MuteStore } from '../../../global-chat/client-types.js';
import {
  addMessage, addSystem, appendInput, applyWelcome, backspace, clampScroll, clearInput, createChatState,
  deleteMessage, mute, scrollDown, scrollUp, setMode, setOnline, setStatus, tagForPubkey, type ChatViewState,
} from './global-chat-model.js';
import { renderChat } from './global-chat-render.js';
import { parseKeys, splitPending, type ChatKey } from './global-chat-keys.js';
import { relayErrorLine, submitLine, type ActionContext } from './global-chat-actions.js';
import { renderNameScreen, renderNotice } from './global-chat-onboarding.js';
import { explainIdentityFailure } from './global-chat-messages.js';
import {
  defaultGuards, paintFrame, takeTerminal, type ChatCompositor, type ChatStdin, type ChatStdout, type ChatTeardownGuards,
} from './global-chat-terminal.js';

export interface ChatClock {
  /** Schedule `fn` after `ms`; returns a cancel function. */
  schedule(fn: () => void, ms: number): () => void;
}
export const realClock: ChatClock = {
  schedule: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); },
};

export interface GlobalChatViewDeps {
  compositor: ChatCompositor;
  stdin: ChatStdin;
  stdout: ChatStdout;
  /** Called once an identity exists (after onboarding when needed). */
  createClient: (identity: ChatIdentity) => ChatClient;
  identity: IdentityStore;
  mutes: MuteStore;
  clock: ChatClock;
  pauseRecording: () => void;
  resumeRecording: () => void;
  /** Optional: true when the agent has background results or peer messages waiting. */
  hasPendingWork?: () => boolean;
  guards?: ChatTeardownGuards;
}
export type GlobalChatOutcome = 'left' | 'declined';

const PAINT_DELAY_MS = 16;
const PENDING_POLL_MS = 1000;
/** How long a trailing ESC (or an unfinished paste) waits for the rest of its sequence. */
const ESC_WAIT_MS = 50;
const PASTE_WAIT_MS = 500;
const PENDING_BANNER = 'Your agent has results waiting. Esc to return.';
const NAME_CHARS = /[^a-z0-9_-]/g;

type Phase = { kind: 'notice' } | { kind: 'name'; input: string; error: string | null; busy: boolean } | { kind: 'chat' };

/** Run the view. Resolves after the terminal is restored. */
export async function runGlobalChatView(deps: GlobalChatViewDeps): Promise<GlobalChatOutcome> {
  // Storage is read before the takeover so a slow or failing disk never
  // leaves the user staring at a blank alternate screen.
  const accepted = await deps.identity.isNoticeAccepted(NOTICE_VERSION);
  const existing = await deps.identity.load();
  const muted = await deps.mutes.list().catch(() => []);
  return new Promise<GlobalChatOutcome>((resolve) => {
    startSession(deps, { accepted, existing, muted }, resolve);
  });
}

interface Preload { accepted: boolean; existing: ChatIdentity | null; muted: Array<{ pubkey: string; name: string }> }

function startSession(deps: GlobalChatViewDeps, pre: Preload, resolve: (o: GlobalChatOutcome) => void): void {
  const { stdin, stdout, clock } = deps;
  const state: ChatViewState = createChatState(pre.existing);
  for (const m of pre.muted) mute(state, m.pubkey, m.name, tagForPubkey(m.pubkey));
  let phase: Phase = !pre.accepted ? { kind: 'notice' } : pre.existing ? { kind: 'chat' } : { kind: 'name', input: '', error: null, busy: false };
  let open = true;
  let client: ChatClient | null = null;
  let unsubscribe: (() => void) | null = null;
  let cancelPaint: (() => void) | null = null;
  let cancelPoll: (() => void) | null = null;
  let pendingInput = '';
  let cancelPending: (() => void) | null = null;

  // Teardown is written before setup (ordered-sequence rule).
  const detach = (): void => {
    open = false;
    stdin.removeListener('data', onData);
    stdout.removeListener('resize', onResize);
    cancelPaint?.(); cancelPaint = null;
    cancelPoll?.(); cancelPoll = null;
    cancelPending?.(); cancelPending = null;
    try { unsubscribe?.(); } catch { /* ignore */ }
    try { client?.close(); } catch { /* ignore */ }
  };
  const finish = (outcome: GlobalChatOutcome): void => {
    if (!open) return;
    detach();
    takeover.restore();
    resolve(outcome);
  };

  const paintNow = (): void => {
    cancelPaint = null;
    if (!open) return;
    const cols = stdout.columns ?? 80;
    const rows = stdout.rows ?? 24;
    if (phase.kind === 'notice') return paintFrame(stdout, renderNotice(cols, rows));
    if (phase.kind === 'name') return paintFrame(stdout, renderNameScreen(phase.input, phase.error, phase.busy, cols, rows));
    let frame = renderChat(state, cols, rows);
    const before = state.scroll;
    clampScroll(state, frame.maxScroll);
    if (state.scroll !== before) frame = renderChat(state, cols, rows);
    paintFrame(stdout, frame.lines);
  };
  // Coalesce: a burst of incoming messages schedules one paint, not one each.
  const paint = (): void => {
    if (!open || cancelPaint) return;
    cancelPaint = clock.schedule(paintNow, PAINT_DELAY_MS);
  };
  const actions: ActionContext = { state, client: null as unknown as ChatClient, mutes: deps.mutes, paint, isOpen: () => open };

  const pollPending = (): void => {
    cancelPoll = null;
    if (!open || !deps.hasPendingWork) return;
    const banner = deps.hasPendingWork() ? PENDING_BANNER : null;
    if (banner !== state.banner) { state.banner = banner; paint(); }
    cancelPoll = clock.schedule(pollPending, PENDING_POLL_MS);
  };

  const startChat = (identity: ChatIdentity): void => {
    phase = { kind: 'chat' };
    if (!state.me) state.me = { ...identity };
    client = deps.createClient(identity);
    actions.client = client;
    unsubscribe = client.subscribe({
      onWelcome: (w) => { applyWelcome(state, w); paint(); },
      onMessage: (m) => { addMessage(state, m); paint(); },
      onPresence: (n) => { setOnline(state, n); paint(); },
      onDeleted: (id) => { deleteMessage(state, id); paint(); },
      onMode: (mode) => { setMode(state, mode); paint(); },
      onStatus: (s) => { setStatus(state, s); paint(); },
      onError: (e) => { const line = relayErrorLine(e); if (line) { addSystem(state, line, 'error'); paint(); } },
    });
    client.connect().catch(() => {
      if (open) { addSystem(state, 'Could not connect to the relay.', 'error'); paint(); }
    });
    pollPending();
    paint();
  };

  const submitName = async (p: Extract<Phase, { kind: 'name' }>): Promise<void> => {
    p.busy = true; p.error = null; paint();
    const result = await deps.identity.create(p.input).catch(() => null);
    if (!open) return;
    p.busy = false;
    if (!result || !result.ok) { p.error = result ? explainIdentityFailure(result) : 'Could not save your identity.'; paint(); return; }
    await deps.identity.acceptNotice(NOTICE_VERSION).catch(() => undefined);
    if (open) startChat(result.identity);
  };

  const onNoticeKey = (key: ChatKey): void => {
    if (key.kind === 'escape') return finish('declined');
    if (key.kind !== 'text') return;
    const c = key.text.toLowerCase();
    if (c === 'n') return finish('declined');
    if (c !== 'y') return;
    if (pre.existing) {
      const id = pre.existing;
      void deps.identity.acceptNotice(NOTICE_VERSION).catch(() => undefined).then(() => { if (open) startChat(id); });
      return;
    }
    phase = { kind: 'name', input: '', error: null, busy: false };
    paint();
  };

  const onNameKey = (p: Extract<Phase, { kind: 'name' }>, key: ChatKey): void => {
    if (key.kind === 'escape') return finish('declined');
    if (p.busy) return;
    if (key.kind === 'text') p.input = (p.input + key.text.toLowerCase().replace(NAME_CHARS, '')).slice(0, 16);
    else if (key.kind === 'backspace') p.input = p.input.slice(0, -1);
    else if (key.kind === 'clear') p.input = '';
    else if (key.kind === 'enter') { void submitName(p); return; }
    p.error = null;
    paint();
  };

  const onChatKey = (key: ChatKey): void => {
    const page = Math.max(1, (stdout.rows ?? 24) - 5);
    switch (key.kind) {
      case 'escape': return finish('left');
      case 'text': appendInput(state, key.text); break;
      case 'backspace': backspace(state); break;
      case 'clear': clearInput(state); break;
      case 'enter': void submitLine(actions); return;
      case 'pageUp': scrollUp(state, page); break;
      case 'pageDown': scrollDown(state, page); break;
      case 'lineUp': scrollUp(state, 1); break;
      case 'lineDown': scrollDown(state, 1); break;
      default: return;
    }
    paint();
  };

  function onData(data: Buffer | string): void {
    if (!open) return;
    cancelPending?.(); cancelPending = null;
    const chunk = pendingInput + (typeof data === 'string' ? data : data.toString('utf8'));
    pendingInput = '';
    const { ready, pending } = chunk.includes('\x03') ? { ready: chunk, pending: '' } : splitPending(chunk);
    if (pending) {
      pendingInput = pending;
      cancelPending = clock.schedule(() => {
        cancelPending = null;
        const held = pendingInput;
        pendingInput = '';
        dispatchKeys(held);
      }, pending === '\x1b' ? ESC_WAIT_MS : PASTE_WAIT_MS);
    }
    if (ready) dispatchKeys(ready);
  }
  function dispatchKeys(input: string): void {
    for (const key of parseKeys(input)) {
      if (!open) return;
      if (key.kind === 'interrupt') return finish(phase.kind === 'chat' ? 'left' : 'declined');
      if (phase.kind === 'notice') onNoticeKey(key);
      else if (phase.kind === 'name') onNameKey(phase, key);
      else onChatKey(key);
    }
  }
  function onResize(): void {
    if (!open) return;
    stdout.write('\x1b[2J');
    paintNow();
  }

  const takeover = takeTerminal({
    compositor: deps.compositor, stdin, stdout, guards: deps.guards ?? defaultGuards,
    afterEnter: deps.pauseRecording, afterLeave: deps.resumeRecording, onCrash: detach,
  });
  try {
    stdin.on('data', onData);
    stdout.on('resize', onResize);
    if (phase.kind === 'chat' && pre.existing) startChat(pre.existing);
    else paint();
  } catch {
    finish('left');
  }
}
