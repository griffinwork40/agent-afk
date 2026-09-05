import type { BackgroundAgentRegistry } from '../../background-registry.js';
import type { ToolCall, ToolResult } from '../types.js';

/** Execute model-side steering of a running background subagent. */
export async function sendMessageToAgent(
  registry: BackgroundAgentRegistry | undefined,
  call: ToolCall,
): Promise<ToolResult> {
  const input = call.input as Record<string, unknown>;
  const jobId = typeof input['jobId'] === 'string' ? input['jobId'].trim() : '';
  const message = typeof input['message'] === 'string' ? input['message'].trim() : '';

  if (!jobId || !message) {
    return {
      content: 'send_message_to_agent requires non-empty jobId and message strings.',
      isError: true,
    };
  }
  if (!registry) {
    return {
      content: 'Background mode is not available in this session — no BackgroundAgentRegistry is wired.',
      isError: true,
    };
  }

  const job = registry.get(jobId);
  if (!job) {
    const known = registry.list().map((item) => item.jobId);
    return {
      content: `Background job not found: "${jobId}". Currently-known job ids: ${known.length > 0 ? known.join(', ') : '(none)'}.`,
      isError: true,
    };
  }
  if (job.provenance !== 'model') {
    return {
      content: `Refused: background job ${jobId} was backgrounded by the user. Only model-created background jobs can be steered this way.`,
      isError: true,
    };
  }
  if (job.status !== 'running') {
    return {
      content: `Background job ${jobId} is already ${job.status}; steering message was not delivered.`,
    };
  }

  const handle = registry.getHandle(jobId);
  if (!handle) {
    return {
      content: `Handle for job "${jobId}" is not available.`,
      isError: true,
    };
  }

  handle.steer(message);
  return { content: `Steering message queued for background job ${jobId}.` };
}
