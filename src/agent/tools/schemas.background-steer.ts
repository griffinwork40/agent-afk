import type { AnthropicToolDef } from './types.js';

export const sendMessageToAgentTool: AnthropicToolDef = {
  name: 'send_message_to_agent',
  category: 'subagent',
  concurrencySafe: false,
  description:
    'Deliver a steering message to a running background subagent at its next tool-call boundary. ' +
    'Only works for jobs started by the model in mode="background" (not user-backgrounded jobs — those are user-owned and this tool will refuse). ' +
    'The message is injected as a user turn before the child\'s next tool round. ' +
    'Use to redirect, correct, or update context in a running child.',
  input_schema: {
    type: 'object',
    properties: {
      jobId: {
        type: 'string',
        description: 'The background job id returned by an earlier agent call in background mode.',
      },
      message: {
        type: 'string',
        description:
          'The steering text to inject into the child agent at its next tool-call boundary. Prefer concise directives; a long essay is fine but arrives as a single user turn.',
      },
    },
    required: ['jobId', 'message'],
  },
};
