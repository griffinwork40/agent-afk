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
import type { ToolEvent } from '../../slash/types.js';
import type { TerminalState, TerminalKind } from './terminal-state.js';

/** Per-AFK-session push budget. Generous enough for a long autonomous run,
 *  low enough to bound notification flood if the model loops. */
export const MAX_PUSHES_PER_SESSION = 20;

/**
 * Maximum length (in characters) of the rawBody fallback used when no
 * structured terminal-state fields parsed. Caps the Telegram payload so an
 * oversized model body cannot carry unbounded prose into the push channel.
 * Any excess is replaced with a `[truncated]` sentinel.
 *
 * The structured-field path is always preferred; this limit only applies to
 * the last-resort rawBody fallback (see {@link formatTerminalStateForTelegram}).
 */
export const MAX_RAW_BODY_FALLBACK_CHARS = 500;

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

// ---------------------------------------------------------------------------
// "Done" verification (opt-in via telegram.verifyDone)
// ---------------------------------------------------------------------------

// Contract: tools whose SUCCESSFUL invocation is observable corroboration that
// real work happened this turn — a file mutation or an executed command. A
// `Done` turn with none of these may be a self-certified completion with no
// artifact behind it. Read-only tools (read_file/grep/glob/list_directory/…)
// deliberately do NOT count: reading is not doing. Delegation tools
// (agent/compose/skill) also do NOT count: a subagent's internal write/command
// streams to the CHILD session and never reaches the parent's tool events (the
// `tool.use.start` → `tool_use_detail` emit in stream-consumer.ts is per-session),
// so a `Done` turn whose work happened entirely inside a subagent is flagged
// "unverified" by design — the parent has no observable artifact standing behind
// the claim. This is the conservative default; the operator can still confirm.
// Extend this set rather than loosening the success check.
export const DONE_EVIDENCE_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  'edit_file',
  'bash',
]);

/** Tools whose successful invocation constitutes a code mutation. */
const CODE_MUTATION_TOOLS: ReadonlySet<string> = new Set(['write_file', 'edit_file']);

/**
 * High-confidence verification command patterns. A bash command whose
 * flattened input matches one of these (after splitting on the first word
 * boundary) is classified as a verification step.
 *
 * Invariant: when uncertain, do NOT classify as verification. False negatives
 * (treating a real test run as non-verification) are safe — the gate fails
 * open. False positives (treating `ls` as verification) are dangerous — they
 * let unverified code reach Done.
 *
 * The patterns recognize:
 *   - Package-manager scripts named test/lint/check/typecheck/verify/build
 *     (pnpm, npm, yarn, bun, make, cargo, go)
 *   - Direct test runner invocations (vitest, jest, pytest, mocha, etc.)
 *   - Compiler/typechecker commands (tsc, gcc, rustc, javac, etc.)
 *
 * Commands that must NOT match: ls, cat, grep, git status, git diff, git log,
 * dependency installation, formatting only, starting a dev server, arbitrary
 * successful shell execution.
 */
const VERIFICATION_COMMANDS: readonly RegExp[] = [
  // Package-manager scripts: pnpm test, npm run lint, yarn check, bun test, etc.
  /^\s*(?:pnpm|npm|yarn|bun|npx)\s+(?:run\s+)?(?:test|lint|check|typecheck|type-check|verify|build)\b/,
  // Make targets: make test, make check, make lint
  /^\s*make\s+(?:test|check|lint|verify|build)\b/,
  // Cargo: cargo test, cargo check, cargo clippy, cargo build
  /^\s*cargo\s+(?:test|check|clippy|build)\b/,
  // Go: go test, go vet, go build
  /^\s*go\s+(?:test|vet|build)\b/,
  // Python: pytest, python -m pytest, python -m unittest
  /^\s*(?:pytest|python3?\s+-m\s+(?:pytest|unittest))\b/,
  // Direct test runners: vitest, jest, mocha, ava, tap
  /^\s*(?:vitest|jest|mocha|ava|tap)\b/,
  // pnpm exec / npx + test runner
  /^\s*(?:pnpm\s+exec|npx)\s+(?:vitest|jest|mocha|pytest|tsc)\b/,
  // TypeScript compiler: tsc (with or without flags)
  /^\s*tsc\b/,
  // Compilers: gcc, g++, rustc, javac, dotnet build
  /^\s*(?:gcc|g\+\+|clang|clang\+\+|rustc|javac|dotnet\s+(?:build|test))\b/,
  // Swift: swift build, swift test
  /^\s*swift\s+(?:build|test)\b/,
  // Ruby: rake test, bundle exec rspec
  /^\s*(?:rake\s+(?:test|spec)|bundle\s+exec\s+rspec)\b/,
];

/**
 * True when a bash command's flattened input looks like a verification step.
 * The input string is the `toolInput` summary from `summarizeToolInput` —
 * a flattened, redacted, space-prefixed command string.
 */
export function isVerificationCommand(input: string): boolean {
  const trimmed = input.trim();
  return VERIFICATION_COMMANDS.some((re) => re.test(trimmed));
}

/**
 * Classify a turn's tool events into one of three evidence states:
 *
 * - `'no-code-changes'` — no successful `edit_file` or `write_file` this turn;
 *   verification is not required.
 * - `'verified'` — code changed AND a verification-shaped bash command
 *   succeeded AFTER the last code mutation.
 * - `'unverified'` — code changed but no verification succeeded after the
 *   most recent mutation.
 *
 * Event ordering is index-based: verification only counts if its position in
 * the `toolEvents` array is strictly after the last successful code mutation.
 * This catches stale verification (test ran before the edit, or code changed
 * again after the test).
 */
export function classifyDoneEvidence(
  toolEvents: readonly ToolEvent[],
): 'no-code-changes' | 'verified' | 'unverified' {
  let lastMutationIndex = -1;
  let lastVerificationIndex = -1;

  for (let i = 0; i < toolEvents.length; i++) {
    const e = toolEvents[i]!;
    if (e.isError === true) continue; // failed calls do not count

    if (CODE_MUTATION_TOOLS.has(e.toolName)) {
      lastMutationIndex = i;
    } else if (e.toolName === 'bash' && isVerificationCommand(e.input)) {
      lastVerificationIndex = i;
    }
  }

  if (lastMutationIndex < 0) return 'no-code-changes';
  if (lastVerificationIndex > lastMutationIndex) return 'verified';
  return 'unverified';
}

/**
 * True when at least one of this turn's tool events is a successful
 * ({@link ToolEvent.isError} not `true`) corroborating tool call — see
 * {@link DONE_EVIDENCE_TOOLS}. Pure: the caller owns the policy decision of
 * whether to act on the result (gated behind `telegram.verifyDone`).
 *
 * Implemented in terms of {@link classifyDoneEvidence}: code changes with no
 * verification are NOT corroborated; no-code-change turns and verified turns
 * are. This is a behavior change from the original binary check — `bash: ls`
 * after `edit_file` no longer counts as corroborating evidence.
 */
export function doneHasCorroboratingEvidence(toolEvents: readonly ToolEvent[]): boolean {
  return classifyDoneEvidence(toolEvents) !== 'unverified';
}

/**
 * Format a parsed terminal state into a compact, scannable Telegram message
 * built strictly from structured fields, then scrub secrets. Returns the
 * ready-to-send string (the caller decides whether to send).
 *
 * When `opts.unverified` is true AND the kind is `done`, the header is
 * downgraded to "⚠️ Done (unverified)" and a trailing caveat line is appended —
 * the caller sets this only when `telegram.verifyDone` is on and the turn
 * produced no corroborating evidence ({@link doneHasCorroboratingEvidence}).
 */
export function formatTerminalStateForTelegram(
  state: TerminalState,
  opts: { unverified?: boolean } = {},
): string {
  const downgraded = state.kind === 'done' && opts.unverified === true;
  const kindLabel = downgraded ? '⚠️ Done (unverified)' : KIND_LABEL[state.kind];
  const header = `🤖 AFK · ${kindLabel}`;
  const lines: string[] = [];
  for (const [label, field] of KIND_FIELDS[state.kind]) {
    const value = state[field];
    if (typeof value === 'string' && value.trim().length > 0) {
      lines.push(label ? `• ${label}: ${value.trim()}` : `• ${value.trim()}`);
    }
  }
  // Fallback: nothing structured parsed, but the parser found a verdict block.
  // Use the model's own terminal-state body (not tool output) as a last resort.
  // Clip to MAX_RAW_BODY_FALLBACK_CHARS so an oversized model body cannot carry
  // unbounded prose into the Telegram push channel.
  if (lines.length === 0 && state.rawBody.trim().length > 0) {
    const raw = state.rawBody.trim();
    lines.push(
      raw.length > MAX_RAW_BODY_FALLBACK_CHARS
        ? `${raw.slice(0, MAX_RAW_BODY_FALLBACK_CHARS)}… [truncated]`
        : raw,
    );
  }
  if (downgraded) {
    lines.push(
      '• ⚠️ Unverified: no file write/edit or successful command recorded this turn — confirm before relying on this.',
    );
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
 * `pushImpl` is injectable for tests; defaults to `pushIfConfigured`. `opts`
 * forwards the (opt-in) verification flag to the formatter — see
 * `formatTerminalStateForTelegram`.
 */
export async function pushTerminalStateToTelegram(
  state: TerminalState,
  pushImpl: typeof pushIfConfigured = pushIfConfigured,
  opts: { unverified?: boolean } = {},
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
    await pushImpl(formatTerminalStateForTelegram(state, opts));
  } catch {
    // Outbound notification is best-effort; never let it break the turn.
  }
}
