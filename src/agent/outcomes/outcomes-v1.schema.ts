/**
 * Zod schema for OutcomesV1 — the structured "what changed in the world"
 * record computed from a session's raw signals (git range, effect ledger,
 * tool events, final assistant message). Built by `computeOutcomes`
 * (compute-outcomes.ts); this module is pure data definition.
 *
 * Wiring into the receipt / outcomes store is deliberately NOT done here.
 */

import { z } from 'zod';

/** Caps enforced by computeOutcomes; the schema rejects anything larger. */
export const OUTCOMES_COMMITS_CAP = 200;
export const OUTCOMES_PRS_CAP = 50;
export const OUTCOMES_FILES_CAP = 500;

/** Git SHA: 40 hex preferred, a 7+ hex abbreviation accepted. */
export const ShaSchema = z.string().regex(/^[0-9a-f]{7,40}$/);

export const OutcomeCommitSchema = z.object({
  sha: ShaSchema,
  /** Absolute path of the repo (or worktree) the commit was made in. */
  repo: z.string(),
  /** First line of the commit message. */
  subject: z.string(),
  source: z.enum(['git_log', 'effect_ledger', 'tool_result']),
});
export type OutcomeCommit = z.infer<typeof OutcomeCommitSchema>;

export const PrActionSchema = z.enum(['create', 'merge', 'update', 'unknown']);
export type PrAction = z.infer<typeof PrActionSchema>;

export const OutcomePrSchema = z.object({
  url: z.string().regex(/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/),
  action: PrActionSchema,
});
export type OutcomePr = z.infer<typeof OutcomePrSchema>;

export const OutcomeScheduleSchema = z.object({
  id: z.string(),
  action: z.enum(['create', 'update', 'cancel']),
});
export type OutcomeSchedule = z.infer<typeof OutcomeScheduleSchema>;

export const OutcomeServiceSchema = z.object({
  name: z.string(),
  action: z.string(),
});
export type OutcomeService = z.infer<typeof OutcomeServiceSchema>;

export const OutcomesV1Schema = z.object({
  schemaVersion: z.literal(1),
  cwd: z.string(),
  startHead: z.string().nullable(),
  endHead: z.string().nullable(),
  commits: z.array(OutcomeCommitSchema).max(OUTCOMES_COMMITS_CAP),
  prs: z.array(OutcomePrSchema).max(OUTCOMES_PRS_CAP),
  /** Absolute paths written/edited during the session. */
  filesChanged: z.array(z.string()).max(OUTCOMES_FILES_CAP),
  /** True when more than OUTCOMES_FILES_CAP distinct paths were seen. */
  filesChangedTruncated: z.boolean(),
  schedules: z.array(OutcomeScheduleSchema),
  services: z.array(OutcomeServiceSchema),
  terminalState: z.enum(['done', 'blocked', 'asking', 'interrupted']).nullable(),
});

export type OutcomesV1 = z.infer<typeof OutcomesV1Schema>;
