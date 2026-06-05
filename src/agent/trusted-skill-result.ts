/**
 * Typed result emitted when a trusted skill completes.
 * Pure type module — no imports, no logic.
 */

export interface TrustedSkillResult {
  skillName: string;
  durationMs: number;
  claimsTotal?: number;
  claimsConfirmed?: number;
  claimsRefuted?: number;
  claimsInconclusive?: number;
  /** True when the skill handler threw an error. Status bar / ledger can use this to distinguish error completions. */
  isError?: boolean;
}
