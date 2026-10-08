import type { AnthropicToolDef } from './types.js';

export const cancelBackgroundJobTool: AnthropicToolDef = {
  name: 'cancel_background_job',
  category: 'subagent',
  concurrencySafe: false,
  description:
    'Cancel a running background subagent job that this model created with the agent tool in mode="background". ' +
    'Use when new context makes an in-flight model-dispatched job obsolete or harmful to continue. ' +
    'Also stops a background process (a proc- id from bash run_in_background): SIGTERM to its process group, SIGKILL after a grace period; returns the final status. ' +
    'Do not use for jobs backgrounded by the user with Ctrl+B: those are user-owned and this tool will refuse; ask the user to run /bgsub:cancel instead. ' +
    'A concrete reason is required and is recorded in the witness trace. Completed, failed, or already-cancelled jobs return an informative non-error result.',
  input_schema: {
    type: 'object',
    properties: {
      jobId: {
        type: 'string',
        description: 'The background job id returned by an earlier agent call in background mode, or a proc- id from bash run_in_background.',
      },
      reason: {
        type: 'string',
        description: 'Required explanation of why the running job is now obsolete or should stop.',
      },
    },
    required: ['jobId', 'reason'],
  },
};
