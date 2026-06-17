/**
 * AFK-mode terminal-state push.
 *
 * In AFK mode (`permissionMode === 'autonomous'`) the operator is away from
 * keyboard and the transcript is unwatched. At the end of each turn the REPL
 * pushes the turn's parsed terminal state to Telegram so the operator can
 * review asynchronously. This module owns the *formatting*, *scrubbing*, and
 * *rate-limiting* of that push; the trigger lives in `turn-handler.ts`.
 *
 * Two safety properties, both required by design (see `.afk/plans/afk-mode.md`):
 *
 *   1. Allowlist by construction. The message is built ONLY from the structured
 *      fields of the parsed {@link TerminalState} (the Done/Blocked/Asking/
 *      Interrupted bullets the model emitted). Raw tool output, full turn text,
 *      logs, and file contents never enter the payload because this formatter
 *      never reads them — it only ever sees the parsed verdict struct.
 *   2. Secondary secret scrub. Even the structured fields are passed through
 *      `redactInlineSecrets` before sending, so an API key the model happened to
 *      echo into a bullet is masked before it leaves the machine over HTTPS.
 *
 * Rate limiting: at most one push per turn (one terminal state per turn) plus a
 * per-AFK-session cap (`MAX_PUSHES_PER_SESSION`). On hitting the cap a single
 * "further pushes muted" notice is sent, then pushes stop until the budget is
 * reset (the `/afk` toggle resets it whenever AFK mode is switched ON, so each
 * AFK session gets a fresh budget).
 *
 * @module cli/commands/interactive/afk-push
 */

import { redactInlineSecrets } from '../../../agent/session/prompt-dump.js';
import { pushIfConfigured } from '../../../telegram/push.js';
import type { TerminalState, TerminalKind } from './terminal-state.js';

/** Per-AFK-session push budget. Generous enough for a long autonomous run,
 *  low enough to bound notification flood if the model loops. */
export const MAX_PUSHES_PER_SESSION = 20;

const KIND_LABEL: Record<TerminalKind, string> = {
  done: '✅ Done',
  blocked: '⛔ Blocked',
  asking: '❓ Asking',
  interrupted: '⏸️ Interrupted',
};

// Ordered (label, field) pairs per kind. Only these structured fields are ever
// read — this is the allowlist. `rawBody` is a last-resort fallback used only
// when none of the structured fields were parsed.
const KIND_FIELDS: Record<TerminalKind, ReadonlyArray<readonly [string, keyof TerminalState]>> = {
  done: [
    ['', 'whatWasDone'],
    ['Evidence', 'evidence'],
    ['Pending', 'deferred'],
  ],
  blocked: [
    ['Blocked by', 'whatBlocks'],
    ['Unblock', 'unblockCondition'],
    ['Done so far', 'alreadyDone'],
  ],
  asking: [
    ['', 'question'],
    ['Resolves', 'assumption'],
    ['Then', 'followup'],
  ],
  interrupted: [
    ['', 'whatWasInProgress'],
    ['State saved', 'stateLocation'],
    ['Resume needs', 'resumeRequires'],
  ],
};

/**
 * Format a parsed terminal state into a compact, scannable Telegram message
 * built strictly from structured fields, then scrub secrets. Returns the
 * ready-to-send string (the caller decides whether to send).
 */
export function formatTerminalStateForTelegram(state: TerminalState): string {
  const header = `🤖 AFK · ${KIND_LABEL[state.kind]}`;
  const lines: string[] = [];
  for (const [label, field] of KIND_FIELDS[state.kind]) {
    const value = state[field];
    if (typeof value === 'string' && value.trim().length > 0) {
      lines.push(label ? `• ${label}: ${value.trim()}` : `• ${value.trim()}`);
    }
  }
  // Fallback: nothing structured parsed, but the parser found a verdict block.
  // Use the model's own terminal-state body (not tool output) as a last resort.
  if (lines.length === 0 && state.rawBody.trim().length > 0) {
    lines.push(state.rawBody.trim());
  }

  const body = lines.length > 0 ? lines.join('\n') : '(no detail)';
  // Secondary scrub over the assembled message — masks any secret the model
  // echoed into a bullet before it leaves the machine.
  return redactInlineSecrets(`${header}\n${body}`);
}

// ---------------------------------------------------------------------------
// Rate limiting (per AFK session)
// ---------------------------------------------------------------------------

let pushCount = 0;
let mutedNoticeSent = false;

/** Reset the per-session push budget. Called when AFK mode is toggled ON so
 *  each AFK session starts with a fresh budget. */
export function resetAfkPushBudget(): void {
  pushCount = 0;
  mutedNoticeSent = false;
}

/** Test/inspection helper: current push count this AFK session. */
export function afkPushCount(): number {
  return pushCount;
}

/**
 * Push the terminal state to Telegram if under budget. No-ops silently when
 * Telegram is unconfigured (`pushIfConfigured` returns null). On reaching the
 * cap, sends one "muted" notice then stops. Best-effort — never throws.
 *
 * `pushImpl` is injectable for tests; defaults to `pushIfConfigured`.
 */
export async function pushTerminalStateToTelegram(
  state: TerminalState,
  pushImpl: typeof pushIfConfigured = pushIfConfigured,
): Promise<void> {
  try {
    if (pushCount >= MAX_PUSHES_PER_SESSION) {
      if (!mutedNoticeSent) {
        mutedNoticeSent = true;
        await pushImpl(
          `🤖 AFK · reached ${MAX_PUSHES_PER_SESSION} updates this session — ` +
          `further terminal-state pushes muted. Run /afk off then /afk on to resume.`,
        );
      }
      return;
    }
    pushCount += 1;
    await pushImpl(formatTerminalStateForTelegram(state));
  } catch {
    // Outbound notification is best-effort; never let it break the turn.
  }
}
