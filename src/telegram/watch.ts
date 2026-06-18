/**
 * Live session watching for the Telegram bot.
 *
 * `/watch <session>` tails another process's durable event ledger
 * (`~/.afk/state/sessions/<id>/events.jsonl`, written by every top-level
 * `AgentSession`) and relays a compact rendering of each record to the chat.
 * This is the cross-surface AFK loop: start work in the CLI REPL, walk away,
 * watch it stream to your phone — no shared process, no daemon required.
 *
 * Design:
 *   - One active watch per chat (starting a new one replaces the old).
 *   - Records are batched on a short debounce window before sending, so a
 *     burst of tool events becomes one Telegram message instead of N rate-
 *     limited sends.
 *   - The tail ends when the watched session writes its terminal `closed`
 *     record, when the user sends `/unwatch`, or when the bot shuts down.
 *   - Watch targets resolve through the same store as CLI `--resume`:
 *     sidecar id, SDK session id, or human session name (`/name`).
 *
 * @module telegram/watch
 */

import { tailLedger, ledgerExists, SessionLedgerWriter, type LedgerRecord } from '../agent/session-ledger.js';
import { findSession, listSessions } from '../cli/session-store.js';
import { readPresenceFiles } from '../agent/awareness/presence.js';
import { readSessionKey, signElicitationResponse } from '../agent/afk-channel.js';
import { makeTelegramElicitationHandler } from './elicitation-handler.js';
import type { MessageHandler } from './handlers/message.js';
import type { Telegraf } from 'telegraf';

type SendFn = (text: string) => Promise<void>;
type LogFn = (...args: unknown[]) => void;

/** Debounce window for batching ledger records into one Telegram message. */
const FLUSH_INTERVAL_MS = 1_500;
/** Max characters of a user/assistant text shown per record. */
const WATCH_TEXT_PREVIEW = 700;
/** Max characters of a tool input preview shown per record. */
const WATCH_TOOL_PREVIEW = 160;

function preview(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Render one ledger record as a compact plain-text line (or null to skip). */
export function renderLedgerRecord(rec: LedgerRecord): string | null {
  switch (rec.kind) {
    case 'meta':
      return `📡 Watching session ${rec.sessionId}\nmodel: ${rec.model}${rec.cwd ? `\ncwd: ${rec.cwd}` : ''}`;
    case 'user':
      return `👤 ${preview(rec.text, WATCH_TEXT_PREVIEW)}`;
    case 'assistant':
      return `🤖 ${preview(rec.text, WATCH_TEXT_PREVIEW)}`;
    case 'tool':
      return `🔧 ${rec.toolName}(${preview(rec.input, WATCH_TOOL_PREVIEW)})`;
    case 'tool_error':
      return `⚠️ tool failed: ${preview(rec.content, WATCH_TOOL_PREVIEW)}`;
    case 'done': {
      const parts: string[] = [];
      if (typeof rec.durationMs === 'number') parts.push(`${(rec.durationMs / 1000).toFixed(1)}s`);
      if (typeof rec.costUsd === 'number') parts.push(`$${rec.costUsd.toFixed(4)}`);
      return `✅ turn done${parts.length ? ` (${parts.join(', ')})` : ''}`;
    }
    case 'error':
      return `❌ error: ${preview(rec.message, WATCH_TOOL_PREVIEW)}`;
    case 'paused':
      return `⏸️ paused on usage limit${rec.resetsAt ? ` (resets ${rec.resetsAt})` : ''}`;
    case 'resumed':
      return '▶️ resumed';
    case 'closed':
      return `🏁 session closed${rec.reason ? ` (${rec.reason})` : ''} — watch ended`;
    default:
      return null;
  }
}

/**
 * Resolve a user-supplied watch target to a ledger session id.
 *
 * Resolution order:
 *   1. Session-store lookup (sidecar id / SDK id / name / unique name
 *      prefix) — the same path CLI `--resume` uses. The sidecar's SDK
 *      `sessionId` is the ledger key.
 *   2. Raw id with an existing ledger file (covers sessions that have not
 *      persisted a sidecar yet).
 *
 * Returns null when nothing matches.
 */
export async function resolveWatchTarget(input: string): Promise<string | null> {
  const found = findSession(input);
  if (found?.data.sessionId && (await ledgerExists(found.data.sessionId))) {
    return found.data.sessionId;
  }
  if (await ledgerExists(input)) return input;
  return null;
}

/**
 * Build the `/watch` no-argument listing: live sessions first (presence
 * files), then the most recent saved sessions that have ledgers.
 */
export async function listWatchableSessions(): Promise<string> {
  const lines: string[] = [];

  const presence = await readPresenceFiles();
  const live = presence.filter((p) => p.surface !== 'telegram');
  if (live.length > 0) {
    lines.push('🟢 Live sessions:');
    for (const p of live) {
      lines.push(`  ${p.sessionId}  (${p.surface}, ${p.cwd})`);
    }
  }

  const saved = listSessions()
    .filter((s) => s.source !== 'telegram')
    .slice(0, 8);
  const withLedger: string[] = [];
  for (const s of saved) {
    if (s.sessionId && (await ledgerExists(s.sessionId))) {
      withLedger.push(`  ${s.name ?? s.id}  (${s.model})`);
    }
  }
  if (withLedger.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('💾 Recent sessions with activity logs:', ...withLedger);
  }

  if (lines.length === 0) {
    return 'No watchable sessions found. Start one with `afk i` on your machine, then /watch <session-id-or-name>.';
  }
  lines.push('', 'Watch one with /watch <session-id-or-name>.');
  return lines.join('\n');
}

interface ActiveWatch {
  sessionId: string;
  abort: AbortController;
  finished: Promise<void>;
}

// Invariant: SessionWatchManager holds a reference to the daemon's SOLE Telegraf
// instance and the MessageHandler. These are used only to render elicitation
// records interactively via makeTelegramElicitationHandler — never to create a
// second poller. bot and messageHandler may be undefined (e.g. in tests that do
// not exercise the elicitation path) — the watch loop degrades gracefully by
// skipping the write-back rather than throwing.

/**
 * Per-chat watch registry. Owns the tail loops and their teardown.
 */
export class SessionWatchManager {
  private readonly watches = new Map<number, ActiveWatch>();
  private readonly log: LogFn;
  private readonly bot: Telegraf | undefined;
  private readonly messageHandler: MessageHandler | undefined;

  constructor(log: LogFn = () => {}, bot?: Telegraf, messageHandler?: MessageHandler) {
    this.log = log;
    this.bot = bot;
    this.messageHandler = messageHandler;
  }

  /** The session id this chat is watching, if any. */
  watching(chatId: number): string | undefined {
    return this.watches.get(chatId)?.sessionId;
  }

  /**
   * Start watching `sessionId` for `chatId`, replacing any existing watch.
   * `send` delivers rendered batches to the chat; failures are logged and
   * the watch continues (a transient Telegram error must not kill the tail).
   */
  start(chatId: number, sessionId: string, send: SendFn): void {
    this.stop(chatId);
    const abort = new AbortController();
    const finished = this._run(chatId, sessionId, send, abort.signal).catch((err) => {
      this.log('watch loop error:', err);
    });
    this.watches.set(chatId, { sessionId, abort, finished });
  }

  /** Stop the chat's active watch. Returns the watched id, if there was one. */
  stop(chatId: number): string | undefined {
    const active = this.watches.get(chatId);
    if (!active) return undefined;
    this.watches.delete(chatId);
    active.abort.abort();
    return active.sessionId;
  }

  /** Tear down all watches (bot shutdown). */
  async stopAll(): Promise<void> {
    const all = [...this.watches.values()];
    this.watches.clear();
    for (const w of all) w.abort.abort();
    await Promise.allSettled(all.map((w) => w.finished));
  }

  private async _run(
    chatId: number,
    sessionId: string,
    send: SendFn,
    signal: AbortSignal,
  ): Promise<void> {
    let batch: string[] = [];
    let flushTimer: NodeJS.Timeout | null = null;
    let sending = Promise.resolve();

    // Contract: build a per-run elicitation handler only when bot + messageHandler
    // are available (they are injected from bot.ts but absent in legacy tests).
    // The handler is created lazily once and reused across multiple elicitation
    // records in the same watch run so the wildcard bot.action dispatch table
    // is only registered once.
    // ledgerOriginated:true tells the handler to register the chatId in
    // messageHandler.ledgerOriginatedPendingChats alongside pendingElicitations,
    // so the message-handler idle-guard fires the resolver even with no active
    // AgentSession for this chat (the REPL runs in a separate process).
    const elicitHandler =
      this.bot !== undefined && this.messageHandler !== undefined
        ? makeTelegramElicitationHandler(this.messageHandler, this.bot, chatId, { ledgerOriginated: true })
        : undefined;

    const flush = (): void => {
      flushTimer = null;
      if (batch.length === 0) return;
      const text = batch.join('\n');
      batch = [];
      // Serialize sends so batches arrive in order even when Telegram is slow.
      sending = sending
        .then(() => send(text))
        .catch((err) => this.log('watch send error:', err));
    };

    try {
      for await (const rec of tailLedger(sessionId, { signal })) {
        // Invariant: elicitation records are handled interactively — the phone
        // renders the question and the signed response is written back to the
        // ledger. They are NOT forwarded as push lines; the normal render path
        // returns null for unknown kinds so elicitation/elicitation_response
        // and abort_request records are already invisible to the push branch.
        if (rec.kind === 'elicitation' && elicitHandler !== undefined) {
          // Flush any accumulated push lines before blocking on the question
          // so the operator sees prior context before the prompt appears.
          if (flushTimer) clearTimeout(flushTimer);
          flush();
          await sending;

          // Await the operator's answer (or abort). The per-run signal bounds
          // the wait: if the user /unwatches or the bot shuts down, the abort
          // propagates through the handler and we get { action: 'decline' }.
          const result = await elicitHandler(rec.request, { signal });

          // Invariant: write-back MUST be HMAC-signed (invariant #4). If the
          // key is absent (REPL has not enabled AFK mode), skip silently — an
          // unsigned elicitation_response would be ignored by the REPL anyway.
          const key = readSessionKey(sessionId);
          if (key !== null) {
            const hmac = signElicitationResponse(key, sessionId, rec.reqId, result);
            // A single-record writer is sufficient; we do not own the session
            // lifecycle. The writer opens, appends, and can be GC'd.
            new SessionLedgerWriter(sessionId).record({
              kind: 'elicitation_response',
              reqId: rec.reqId,
              result,
              hmac,
            });
          } else {
            this.log('[watch] no session key for', sessionId, '— skipping elicitation write-back');
          }
          // Do not add a push line for elicitation records.
          continue;
        }

        const line = renderLedgerRecord(rec);
        if (!line) continue;
        batch.push(line);
        if (rec.kind === 'closed') {
          flush();
          break;
        }
        if (!flushTimer) {
          flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS);
          // Don't hold the process open for a pending flush.
          flushTimer.unref?.();
        }
      }
      // Tail ended (closed record or abort) — deliver anything still queued.
      if (flushTimer) clearTimeout(flushTimer);
      flush();
      await sending;
    } finally {
      if (flushTimer) clearTimeout(flushTimer);
      // Only delete if we're still the registered watch (a replacement may
      // have been installed by a newer start()).
      const current = this.watches.get(chatId);
      if (current && current.sessionId === sessionId && current.abort.signal === signal) {
        this.watches.delete(chatId);
      }
    }
  }
}
