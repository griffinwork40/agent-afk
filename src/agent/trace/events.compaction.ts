/**
 * Zod schemas for `compaction` trace payloads (input + persisted forms),
 * extracted from {@link ./events} to keep that module under the 350-code-line
 * ceiling. Re-exported from `./events` — import from there.
 *
 * @module agent/trace/events.compaction
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// compaction — two schemas (input vs persisted)
// ---------------------------------------------------------------------------

export const CompactionTriggerSchema = z.enum([
  'manual',
  'token_threshold',
  'turn_count',
]);

export const CompactionSidecarRefSchema = z.object({
  path: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

/** Input form — accepts the inline message slice. The writer validates
 *  with this schema, then transforms to the persisted form. */
export const CompactionPayloadInputSchema = z.object({
  trigger: CompactionTriggerSchema,
  preCompactionMessages: z.array(z.unknown()),
  summary: z.string(),
  keptTailCount: z.number().int().nonnegative(),
  keepLastNConfig: z.number().int().nonnegative(),
  messagesBefore: z.number().int().nonnegative(),
  messagesAfter: z.number().int().nonnegative(),
  tokensSavedEstimate: z.number().nonnegative().optional(),
  summarizationTokens: z
    .object({
      input: z.number().int().nonnegative(),
      output: z.number().int().nonnegative(),
    })
    .optional(),
});

/** Persisted form — what readers parse. */
export const CompactionPayloadPersistedSchema = z.object({
  trigger: CompactionTriggerSchema,
  preCompactionMessagesRef: CompactionSidecarRefSchema,
  summary: z.string(),
  keptTailCount: z.number().int().nonnegative(),
  keepLastNConfig: z.number().int().nonnegative(),
  messagesBefore: z.number().int().nonnegative(),
  messagesAfter: z.number().int().nonnegative(),
  tokensSavedEstimate: z.number().nonnegative().optional(),
  summarizationTokens: z
    .object({
      input: z.number().int().nonnegative(),
      output: z.number().int().nonnegative(),
    })
    .optional(),
});
