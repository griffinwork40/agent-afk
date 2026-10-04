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

/**
 * Minimal tool-event shape. The session layer supplies
 * `successfulToolNames` from `ResponseMetadata`; the REPL supplies full
 * `ToolEvent` objects. Both satisfy this interface.
 */
export interface ToolEventMin {
  toolName: string;
  /** Flattened bash command string (used by `isVerificationCommand`). */
  input: string;
  isError?: boolean;
}

// Contract: tools whose SUCCESSFUL invocation is observable corroboration that
// real work happened this turn — a file mutation or an executed command. A
// `Done` turn with none of these may be a self-certified completion with no
// artifact behind it. Read-only tools (read_file/grep/glob/list_directory/…)
// deliberately do NOT count: reading is not doing. Delegation tools
// (agent/compose/skill) also do NOT count: a subagent's internal write/command
// streams to the CHILD session and never reaches the parent's tool events.
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
  toolEvents: readonly ToolEventMin[],
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
    (e) => e.isError !== true && DONE_EVIDENCE_TOOLS.has(e.toolName),
  );
  if (!hasAnyEvidence) return false;
  return classifyDoneEvidence(toolEvents) !== 'unverified';
}
