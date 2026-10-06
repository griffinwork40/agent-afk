/**
 * Zod schemas for the `subagent_lifecycle` trace event payload — extracted from
 * `events.ts` to keep that file within the 350-code-line ceiling.
 *
 * `events.ts` re-exports all schemas from here for backward compatibility.
 *
 * @module agent/trace/events.subagent-lifecycle
 */

import { z } from 'zod';
import { TOOL_FAILURE_CLASSES } from './types.js';

export const ToolFailureClassSchema = z.enum(TOOL_FAILURE_CLASSES);

// ---------------------------------------------------------------------------
// subagent_lifecycle
// ---------------------------------------------------------------------------

export const SubagentStartedPayloadSchema = z.object({
  transition: z.literal('started'),
  subagentId: z.string(),
  parentId: z.string(),
  model: z.string(),
  allowedTools: z.array(z.string()).readonly().optional(),
  systemPromptHash: z.string().optional(),
  promptHead: z.string().optional(),
  agentType: z.string().optional(),
  resolvedAgentType: z.string().optional(),
  maxToolUseIterations: z.number().int().nonnegative().optional(),
});

export const SubagentSucceededPayloadSchema = z.object({
  transition: z.literal('succeeded'),
  subagentId: z.string(),
  durationMs: z.number().nonnegative(),
  turnCount: z.number().int().nonnegative(),
  totalCostUsd: z.number().nonnegative().optional(),
  outputBytes: z.number().int().nonnegative(),
  stopReason: z.string().optional(),
});

export const SubagentFailedPayloadSchema = z.object({
  transition: z.literal('failed'),
  subagentId: z.string(),
  errorClass: z.string(),
  errorMessage: z.string(),
  partialOutputBytes: z.number().int().nonnegative(),
  failureClass: ToolFailureClassSchema.optional(),
});

export const SubagentCancelledPayloadSchema = z.object({
  transition: z.literal('cancelled'),
  subagentId: z.string(),
  source: z.enum(['cascade', 'explicit']),
  timeout: z.boolean().optional(),
});

export const SubagentLifecyclePayloadSchema = z.discriminatedUnion('transition', [
  SubagentStartedPayloadSchema,
  SubagentSucceededPayloadSchema,
  SubagentFailedPayloadSchema,
  SubagentCancelledPayloadSchema,
]);
