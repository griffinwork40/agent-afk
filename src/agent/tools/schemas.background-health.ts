/**
 * Tool schema for `get_background_job_health`.
 *
 * Exposes coarse health signals — status, elapsed time, idle-since duration,
 * pending steering message count, and recent progress events — for a running
 * background subagent job created by the calling session.
 *
 * @module agent/tools/schemas.background-health
 */

import type { AnthropicToolDef } from './types.js';

export const getBackgroundJobHealthTool: AnthropicToolDef = {
  name: 'get_background_job_health',
  category: 'subagent',
  concurrencySafe: true,
  description:
    'Inspect the health and activity state of a running background subagent job. ' +
    'Returns status, elapsed time, time since last activity, pending steering message count, ' +
    'and recent progress events. Only works for jobs created by this session. ' +
    'Use before send_message_to_agent to understand what the child is doing, ' +
    'or to check whether a long-running job is still making progress.',
  input_schema: {
    type: 'object',
    properties: {
      jobId: {
        type: 'string',
        description: 'The background job id returned by an earlier agent call in background mode.',
      },
    },
    required: ['jobId'],
  },
};
