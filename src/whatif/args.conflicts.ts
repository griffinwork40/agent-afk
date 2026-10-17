/**
 * Cross-flag conflict checks for `parseWhatifArgs`.
 *
 * Runs after every token has been consumed, so it sees the final flag set
 * regardless of argv order. Extracted from args.ts to keep that file within
 * the 350-code-line ceiling.
 *
 * @module whatif/args.conflicts
 */

import { WHATIF_USAGE } from './args.usage.js';

/** The parsed facts the conflict rules depend on. */
export interface FlagConflictInput {
  specFile: string | undefined;
  changeFlagCount: number;
  text: string | undefined;
  aaMode: boolean;
  verify: boolean;
}

/**
 * Contract: returns an error string (usage appended) for the first violated
 * rule, or `null` when the combination is valid. Rule order is the order the
 * user is told about problems; keep the "nothing to predict" rule last.
 */
export function checkFlagConflicts(input: FlagConflictInput): string | null {
  const { specFile, changeFlagCount, text, aaMode, verify } = input;

  if (specFile && (changeFlagCount > 0 || text || aaMode)) {
    return `--spec cannot be combined with change flags, plain-text, or --aa\n\n${WHATIF_USAGE}`;
  }

  if (aaMode && (changeFlagCount > 0 || text)) {
    return `--aa cannot be combined with change flags or plain-text (A/A mode uses no changes)\n\n${WHATIF_USAGE}`;
  }

  // Contract: --aa compares the two arms' structural snapshots only. run.ts
  // returns through runAaPhase before the predict and verify phases, so
  // --verify was silently ignored and "no decisive verdicts" held trivially
  // (zero predictions). Reject the pair so nobody budgets a paid A/A run that
  // never runs an episode. A verdict-level null test is a no-op change run
  // through --verify.
  if (aaMode && verify) {
    return (
      '--aa cannot be combined with --verify: A/A mode compares structural snapshots only ' +
      'and runs no episodes or predictions. For a verdict-level null test, run --verify ' +
      `with a change that has no behavioral effect.\n\n${WHATIF_USAGE}`
    );
  }

  if (!text && !specFile && changeFlagCount === 0 && !aaMode) {
    return `whatif: nothing to predict — provide a description, flags, or --spec\n\n${WHATIF_USAGE}`;
  }

  return null;
}
