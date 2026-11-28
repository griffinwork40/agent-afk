/**
 * Done-evidence classification — agent-layer home.
 *
 * Pure functions extracted from `src/cli/commands/interactive/afk-push.ts`
 * so the session layer and daemon can compute evidence signals without importing
 * from the cli layer (layering invariant: `src/agent/` must not import from
 * `src/cli/`).
 *
 * The originals in `src/cli/commands/interactive/afk-push.ts` re-export
 * everything from here so all existing importers remain unaffected.
 *
 * @module agent/done-evidence
 */

import { classifyBashCommand } from './tools/readonly-bash.js';

// Contract: SHELL_WRITE_OPERATOR is used ONLY inside the isVerificationCommand
// branch to detect whether a verification command also writes to disk (e.g.
// `pnpm test > results.txt`, `pnpm test 2>&1 | tee log.txt`). It must NOT use
// the broad FS_MUTATING word-boundary regexes from classifyBashCommand, which
// match path tokens such as `src/rm.test.ts` (via \brm\b) and would incorrectly
// mark a clean `pnpm test src/rm.test.ts` as mutating. Instead it checks only
// genuine shell write operators: output redirection (`>` / `>>`) and piped tee.
// The non-verification else-if branch continues to use classifyBashCommand so
// that broad shell mutations (sed -i, rm, git commit, …) are still caught.
const SHELL_WRITE_OPERATOR = /(?:\s>>?\s+\S|\|\s*tee\s+\S)/;

/**
 * Minimal tool-event shape. The session layer supplies
 * `successfulToolNames` from `ResponseMetadata`; the REPL supplies full
 * `ToolEvent` objects. Both satisfy this interface.
 */
export interface ToolEventMin {
  toolName: string;
  /** Flattened bash command string (used by `isVerificationCommand`). */
  input: string;
  /**
   * JSON-serialized raw tool input (from `extractRawToolInput`). Present for
   * `patch_apply` events so the dry-run guard can read the `dry_run` boolean
   * without relying on the lossy flattened `input` summary string.
   */
  inputRaw?: string;
  isError?: boolean;
  /**
   * Pre-classified from the FULL bash command before the 160-char `toolInput`
   * summary is applied. When present, `classifyDoneEvidence` uses these booleans
   * directly instead of re-classifying the truncated `input` string — fixing the
   * false-positive and false-negative classes caused by mid-command truncation.
   * Absent for non-bash tools and for events constructed without pre-classification
   * (e.g. unit-test fixtures that only supply `input`).
   */
  isMutatingBash?: boolean;
  isVerificationBash?: boolean;
}

/**
 * True when a `patch_apply` event writes nothing to disk and must not count
 * as either a mutation or done-evidence. Two cases:
 *
 *   1. `dry_run: true` — a preview that never touches files.
 *   2. `changes: []` — an empty change list; the handler returns a synthetic
 *      `'applied'` success but no file is actually written, so the event must
 *      not advance `lastMutationIndex` or satisfy `doneHasCorroboratingEvidence`.
 *
 * Parses the JSON `inputRaw` field if present; falls back to `false` (treats
 * as a real write) when the field is absent or unparseable — the conservative
 * direction (a real write is always counted, a spurious no-op skip is safe).
 */
export function isPatchApplyDryRun(e: ToolEventMin): boolean {
  if (!e.inputRaw) return false;
  try {
    const parsed: unknown = JSON.parse(e.inputRaw);
    if (parsed === null || typeof parsed !== 'object') return false;
    const p = parsed as Record<string, unknown>;
    if (p['dry_run'] === true) return true;
    if (p['changes_empty'] === true) return true;
    return false;
  } catch {
    return false;
  }
}

// Contract: tools whose SUCCESSFUL invocation is observable corroboration that
// real work happened this turn — a file mutation or an executed command. A
// `Done` turn with none of these may be a self-certified completion with no
// artifact behind it. Read-only tools (read_file/grep/glob/list_directory/…)
// deliberately do NOT count: reading is not doing. Delegation tools
// (agent/compose/skill) also do NOT count: a subagent's internal write/command
// streams to the CHILD session and never reaches the parent's tool events.
// `patch_apply` with `dry_run: true` writes nothing and must not count — the
// dry-run check in classifyDoneEvidence gates on inputRaw before treating a
// patch_apply event as a mutation. Extend this set rather than loosening the
// success check.
export const DONE_EVIDENCE_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  'edit_file',
  'bash',
  'patch_apply',
]);

/** Tools whose successful invocation constitutes a code mutation. */
const CODE_MUTATION_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  'edit_file',
  'patch_apply',
]);

/**
 * High-confidence verification command patterns. A bash command whose
 * flattened input matches one of these (after splitting on the first word
 * boundary) is classified as a verification step.
 *
 * Invariant: when uncertain, do NOT classify as verification. False negatives
 * (treating a real test run as non-verification) are safe — the gate fails
 * open. False positives (treating `ls` as verification) are dangerous — they
 * let unverified code reach Done.
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

// Contract: ENV_ASSIGNMENT strips leading `KEY=value` pairs (e.g. `CI=1`,
// `NODE_ENV=test`) and the `time` / `command` no-op wrappers that agents
// prepend before the real command verb. This is applied segment-by-segment
// after splitting on `&&` / `;` so only the leading prefix of each segment
// is stripped, never an assignment that appears as an argument later.
const ENV_ASSIGNMENT = /^(?:[A-Z_][A-Z0-9_]*=\S*\s+)*/i;
// LEADING_WRAPPERS strips `time`, `command`, `exec` immediately before the
// real verb (after env-var stripping).
const LEADING_WRAPPERS = /^(?:time|command|exec)\s+/i;

/**
 * Split a compound shell command on `&&` and `;` boundaries (top-level only —
 * does not descend into subshells) and strip one level of wrapping parentheses
 * from each segment, then strip leading env assignments and no-op wrappers.
 * Returns the normalised segments so each can be tested against VERIFICATION_COMMANDS.
 */
function verificationSegments(input: string): string[] {
  // Strip one level of outer parens: `(cmd)` → `cmd`, `(cmd 2>&1 | tail)` → `cmd 2>&1 | tail`.
  const unwrapped = input.trim().replace(/^\((.*)\)\s*$/, '$1');
  // Split on && and ; — intentionally simple: does not parse quotes or subshells.
  // When unsure, do not classify as verification (false-negative is safe).
  const rawSegments = unwrapped.split(/&&|;/);
  return rawSegments.map((seg) => {
    // Strip leading `cd <dir>` navigation prefix — agents write `cd repo && pnpm test`.
    const withoutCd = seg.trim().replace(/^cd\s+\S+\s*/, '');
    // Strip leading env assignments (CI=1 pnpm test → pnpm test).
    const withoutEnv = withoutCd.replace(ENV_ASSIGNMENT, '');
    // Strip no-op wrappers: `time pnpm test` → `pnpm test`.
    return withoutEnv.replace(LEADING_WRAPPERS, '');
  });
}

/**
 * True when a bash command's flattened input looks like a verification step.
 *
 * Tests each `&&`/`;` segment of the command independently, after:
 *   1. Stripping one level of wrapping parentheses from the whole command.
 *   2. Stripping a leading `cd <dir>` navigation prefix from each segment.
 *   3. Stripping leading `KEY=value` env-var assignments from each segment.
 *   4. Stripping no-op wrappers (`time`, `command`, `exec`) from each segment.
 *
 * A command is considered a verification step when ANY segment matches.
 * Invariant: when uncertain, do NOT classify as verification — false negatives
 * (treating a real test run as non-verification) are safe; false positives
 * (treating a mutation as verification) are dangerous.
 */
export function isVerificationCommand(input: string): boolean {
  const segments = verificationSegments(input);
  return segments.some((seg) => VERIFICATION_COMMANDS.some((re) => re.test(seg)));
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
  toolEvents: readonly ToolEventMin[],
): 'no-code-changes' | 'verified' | 'unverified' {
  let lastMutationIndex = -1;
  let lastVerificationIndex = -1;

  for (let i = 0; i < toolEvents.length; i++) {
    const e = toolEvents[i]!;
    if (e.isError === true) continue; // failed calls do not count

    if (CODE_MUTATION_TOOLS.has(e.toolName)) {
      // patch_apply with dry_run: true writes nothing — skip it.
      if (e.toolName === 'patch_apply' && isPatchApplyDryRun(e)) continue;
      lastMutationIndex = i;
    } else if (e.toolName === 'bash') {
      // Prefer pre-classified booleans (computed from the FULL command before
      // the 160-char summary truncation). Fall back to classifying the truncated
      // `e.input` only when the booleans are absent (legacy paths, test fixtures).
      const isVerification = e.isVerificationBash ?? isVerificationCommand(e.input);
      const isMutating = e.isMutatingBash ?? (!isVerification && classifyBashCommand(e.input).mutating);

      // Verification check takes priority: a command that matches a verification
      // pattern (pnpm test, cargo check, …) counts as verification. Only when it
      // is NOT a verification command do we check whether it contains a shell write
      // operator; a mutating bash call (output redirect, tee) advances
      // lastMutationIndex so a verification that ran BEFORE it is not counted as
      // post-mutation confirmation.
      if (isVerification) {
        lastVerificationIndex = i;
        // A bash command can match a verification pattern AND also write to disk
        // (e.g. `pnpm test > results.txt`, `pnpm test 2>&1 | tee log.txt`).
        // When the command contains a shell write operator, advance lastMutationIndex
        // too — so the verification no longer counts as post-mutation confirmation.
        // Invariant: only genuine shell write operators (output redirection `>`/`>>`,
        // piped `tee <file>`) are checked here — NOT the broad FS_MUTATING regexes
        // from classifyBashCommand, which match path tokens such as `src/rm.test.ts`
        // and would incorrectly mark a clean `pnpm test src/rm.test.ts` as mutating.
        if (SHELL_WRITE_OPERATOR.test(e.input)) {
          lastMutationIndex = i;
        }
      } else if (isMutating) {
        lastMutationIndex = i;
      }
    }
  }

  if (lastMutationIndex < 0) return 'no-code-changes';
  if (lastVerificationIndex > lastMutationIndex) return 'verified';
  return 'unverified';
}

/**
 * True when this turn has observable evidence supporting the Done claim.
 *
 * Two concepts are checked independently:
 *
 *   1. **General corroboration** — did observable work happen at all? A turn
 *      with zero tool events from {@link DONE_EVIDENCE_TOOLS} (no successful
 *      write, edit, or executed command) has no artifact backing the claim.
 *
 *   2. **Code verification** — if code was changed, was it verified afterward?
 *      Delegated to {@link classifyDoneEvidence}: an `'unverified'` result
 *      means code mutated without a post-mutation verification step.
 *
 * Returns `false` when EITHER check fails: no evidence at all, or unverified
 * code changes. Returns `true` only when the turn has evidence tools AND is
 * not in the `'unverified'` code state.
 */
export function doneHasCorroboratingEvidence(toolEvents: readonly ToolEventMin[]): boolean {
  const hasAnyEvidence = toolEvents.some(
    (e) =>
      e.isError !== true &&
      DONE_EVIDENCE_TOOLS.has(e.toolName) &&
      !(e.toolName === 'patch_apply' && isPatchApplyDryRun(e)),
  );
  if (!hasAnyEvidence) return false;
  return classifyDoneEvidence(toolEvents) !== 'unverified';
}
