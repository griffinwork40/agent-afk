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

import { tailLedger, ledgerExists, type LedgerRecord } from '../agent/session-ledger.js';
import { findSession, listSessions } from '../cli/session-store.js';
import { readPresenceFiles } from '../agent/awareness/presence.js';

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

/**
 * Per-chat watch registry. Owns the tail loops and their teardown.
 */
export class SessionWatchManager {
  private readonly watches = new Map<number, ActiveWatch>();
  private readonly log: LogFn;

  constructor(log: LogFn = () => {}) {
    this.log = log;
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
