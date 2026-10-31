/**
 * Contract: one per-command analysis, with lazy, independently memoized facets.
 * Consumers select policy, not another command table. There is no global cache
 * or retained command data. The positional mutation pass shares this token view.
 *
 * Migration deliberately preserves the legacy raw/data-masked views: replacing
 * them with quote-removed tokens would hide executable interpreter payloads or
 * change calibrated hook blocks. Risk tiers, mutation, and hook pattern matches
 * are DIFFERENT axes. `readOnly` means no KNOWN mutation (default allow), NOT
 * proof of harmless execution. Never use it as a sandbox or polling allowlist.
 * Network egress and resolved write paths are not inferred by this partial API.
 */
import { classifyCommandRisk } from './command-classifier.risk.js';
import { classifyCommandMutation } from './tools/readonly-bash.mutation.js';
import { tokenizeSegments } from './tools/readonly-bash.tokenizer.js';
import { maskHookCommandData } from './hook-command-data.js';
import { DESTRUCTIVE_PATTERNS, type DestructivePattern } from './safe-destruct-patterns.js';
import { RELEASE_BOUNDARY_PATTERNS, type ReleaseBoundaryPattern } from './release-boundary-patterns.js';
import type { RiskVerdict } from './risk-classifier.js';

export interface MutationVerdict {
  readonly mutating: boolean;
  readonly reason?: string;
}

export interface CommandAnalysis {
  readonly segments: readonly (readonly string[])[];
  readonly mutation: MutationVerdict;
  /** No known mutation; not a fail-closed read-only guarantee. */
  readonly readOnly: boolean;
  readonly risk: RiskVerdict;
  /** Ordered matches; callers retain cwd-scoped tier policy. */
  readonly destructive: readonly DestructivePattern[];
  /** Ordered matches; callers retain dry-run and precedence policy. */
  readonly releaseBoundary: readonly ReleaseBoundaryPattern[];
}

/** No eager parsing: hook-only callers do not run mutation or risk rules. */
export function analyzeCommand(command: string): CommandAnalysis {
  // Normally raw and approval views are identical and share one parse. Neutral
  // redirects are removed ONLY for approval matching; preserve that distinct view
  // rather than feeding its sanitized tokens into the mutation rules.
  const tokenViews = new Map<string, CommandAnalysis['segments']>();
  const tokensFor = (view: string): CommandAnalysis['segments'] => {
    let tokens = tokenViews.get(view);
    if (tokens === undefined) {
      tokens = tokenizeSegments(view);
      tokenViews.set(view, tokens);
    }
    return tokens;
  };
  let mutation: MutationVerdict | undefined;
  let risk: RiskVerdict | undefined;
  let destructive: CommandAnalysis['destructive'] | undefined;
  let releaseBoundary: CommandAnalysis['releaseBoundary'] | undefined;
  const analysis: CommandAnalysis = {
    get segments() { return tokensFor(command); },
    get mutation() {
      return mutation ??= classifyCommandMutation(command, () => analysis.segments);
    },
    get readOnly() { return !analysis.mutation.mutating; },
    get risk() { return risk ??= classifyCommandRisk(command, () => analysis.mutation, tokensFor); },
    get destructive() {
      return destructive ??= command
        ? DESTRUCTIVE_PATTERNS.filter(({ re }) => re.test(maskedDestructive())) : [];
    },
    get releaseBoundary() {
      return releaseBoundary ??= command
        ? RELEASE_BOUNDARY_PATTERNS.filter(({ re }) => re.test(maskedRelease())) : [];
    },
  };
  // Separate masking modes are intentional, not equivalent parse results.
  let destructiveView: string | undefined;
  let releaseView: string | undefined;
  const maskedDestructive = (): string => destructiveView ??= maskHookCommandData(command);
  const maskedRelease = (): string => releaseView ??= maskHookCommandData(command, true);
  return analysis;
}
