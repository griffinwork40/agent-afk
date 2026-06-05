/**
 * Shared record type emitted at the end of every `afk farm` run.
 *
 * Consumed by:
 *   - `memory-write.ts` — persists a `farm-run` fact to cross-session memory
 *   - `digest.ts`       — formats a Telegram digest
 *   - integration tests in `cli/commands/farm.test.ts`
 *
 * Both consumers historically defined this shape locally; centralizing it
 * here so the integration site in `runFarm()` constructs it once and passes
 * the same object to every consumer.
 *
 * @module skills/score/farm-run-record
 */

import type { BranchScore } from './index.js';

export interface FarmBranchRecord {
  index: number;
  branch: string;
  label?: string;
  ok: boolean;
  commitCount: number;
  error?: string;
  /** From src/skills/score/index.ts. May be null/undefined if scoring was skipped. */
  score?: BranchScore | null;
}

export interface FarmRunRecord {
  taskName: string;
  taskSlug: string;
  baseSha: string;
  /** ISO timestamp when the farm was created. */
  startedAt: string;
  /** ISO timestamp when scoring (or the final escape check) finished. */
  completedAt: string;
  branches: FarmBranchRecord[];
  /** Index of the #1-ranked branch from `rankBranches()`, or undefined if no successful branches. */
  winner?: number;
  /** Optional decision recorded after user resolves the farm via Telegram or CLI. */
  human_decision?: 'approved' | 'rejected' | 'edited_then_merged';
}
