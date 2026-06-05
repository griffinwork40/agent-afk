/**
 * Trusted-skill ledger — per-session accumulator for skill run statistics.
 * Class-based: no module-level state; each instance is independent.
 */

import type { TrustedSkillResult } from '../agent/trusted-skill-result.js';

export interface LedgerEntry {
  skillName: string;
  runs: number;
  totalDurationMs: number;
  totalClaims?: number;
  totalConfirmed?: number;
  totalRefuted?: number;
  totalInconclusive?: number;
}

export class TrustedSkillLedger {
  private entries = new Map<string, LedgerEntry>();

  /**
   * Record a skill completion result into the ledger.
   * Upserts into the map — adds optional claim fields only when present.
   */
  record(result: TrustedSkillResult): void {
    const existing = this.entries.get(result.skillName);
    if (!existing) {
      this.entries.set(result.skillName, {
        skillName: result.skillName,
        runs: 1,
        totalDurationMs: result.durationMs,
        ...(result.claimsTotal !== undefined ? { totalClaims: result.claimsTotal } : {}),
        ...(result.claimsConfirmed !== undefined ? { totalConfirmed: result.claimsConfirmed } : {}),
        ...(result.claimsRefuted !== undefined ? { totalRefuted: result.claimsRefuted } : {}),
        ...(result.claimsInconclusive !== undefined ? { totalInconclusive: result.claimsInconclusive } : {}),
      });
    } else {
      existing.runs += 1;
      existing.totalDurationMs += result.durationMs;
      if (result.claimsTotal !== undefined) {
        existing.totalClaims = (existing.totalClaims ?? 0) + result.claimsTotal;
      }
      if (result.claimsConfirmed !== undefined) {
        existing.totalConfirmed = (existing.totalConfirmed ?? 0) + result.claimsConfirmed;
      }
      if (result.claimsRefuted !== undefined) {
        existing.totalRefuted = (existing.totalRefuted ?? 0) + result.claimsRefuted;
      }
      if (result.claimsInconclusive !== undefined) {
        existing.totalInconclusive = (existing.totalInconclusive ?? 0) + result.claimsInconclusive;
      }
    }
  }

  /**
   * Returns null when no runs have been recorded, else a shallow copy of the
   * entries map. Returns a copy so callers cannot corrupt internal ledger state.
   */
  summary(): Map<string, LedgerEntry> | null {
    return this.entries.size === 0 ? null : new Map(this.entries);
  }

  /**
   * Clear all entries (e.g. on /clear).
   */
  clear(): void {
    this.entries = new Map();
  }
}
