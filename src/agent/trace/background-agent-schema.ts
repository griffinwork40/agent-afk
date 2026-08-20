import { z } from 'zod';

export const BackgroundAgentCancelledPayloadSchema = z.object({
  transition: z.literal('cancelled'),
  jobId: z.string(),
  subagentId: z.string(),
  source: z.enum(['explicit', 'cascade']),
  cancelledBy: z.literal('model').optional(),
  reason: z.string().optional(),
});
