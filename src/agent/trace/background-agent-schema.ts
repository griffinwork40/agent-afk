import { z } from 'zod';

export const BackgroundAgentStartedPayloadSchema = z.object({
  transition: z.literal('started'),
  jobId: z.string(),
  subagentId: z.string(),
  label: z.string(),
  model: z.string(),
});

export const BackgroundAgentCompletedPayloadSchema = z.object({
  transition: z.literal('completed'),
  jobId: z.string(),
  subagentId: z.string(),
  durationMs: z.number().nonnegative(),
  outputBytes: z.number().int().nonnegative(),
});

export const BackgroundAgentFailedPayloadSchema = z.object({
  transition: z.literal('failed'),
  jobId: z.string(),
  subagentId: z.string(),
  durationMs: z.number().nonnegative(),
  errorClass: z.string(),
  errorMessage: z.string(),
});

export const BackgroundAgentCancelledPayloadSchema = z.object({
  transition: z.literal('cancelled'),
  jobId: z.string(),
  subagentId: z.string(),
  source: z.enum(['explicit', 'cascade']),
  cancelledBy: z.literal('model').optional(),
  reason: z.string().optional(),
});

export const BackgroundAgentJoinedPayloadSchema = z.object({
  transition: z.literal('joined'),
  jobId: z.string(),
  subagentId: z.string(),
  jobStatus: z.enum(['completed', 'failed', 'cancelled']),
});

export const BackgroundAgentDeliveredPayloadSchema = z.object({
  transition: z.literal('delivered'),
  jobId: z.string(),
  subagentId: z.string(),
  jobStatus: z.enum(['completed', 'failed', 'cancelled']),
});

export const BackgroundAgentPayloadSchema = z.discriminatedUnion('transition', [
  BackgroundAgentStartedPayloadSchema,
  BackgroundAgentCompletedPayloadSchema,
  BackgroundAgentFailedPayloadSchema,
  BackgroundAgentCancelledPayloadSchema,
  BackgroundAgentJoinedPayloadSchema,
  BackgroundAgentDeliveredPayloadSchema,
]);
