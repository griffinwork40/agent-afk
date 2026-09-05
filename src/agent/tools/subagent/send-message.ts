import type { BackgroundAgentRegistry } from '../../background-registry.js';
import type { ToolCall, ToolResult } from '../types.js';

/**
 * Execute model-side steering of a running background subagent.
 *
 * This is the **model-owned** steering domain: the parent model sends
 * a redirect to a background child via `send_message_to_agent`. Foreground
 * subagents are steered by the **human** via the interrupt picker
 * (Ctrl+C → Steer → readline → next REPL turn), not through this tool.
 * See `interrupt-picker.ts` and `loop-iteration.ts` for that path.
 */
export async function sendMessageToAgent(
  registry: BackgroundAgentRegistry | undefined,
  call: ToolCall,
  callerSessionId?: string,
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
    const known = registry.list()
      .filter((item) => item.provenance === 'model')
      .map((item) => item.jobId);
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
  // Cross-session ownership check: in a multi-session process (concurrent
  // REPL + Telegram + daemon), prevent one session's model from steering
  // another session's background job by guessing the jobId.
  if (callerSessionId && job.parentSessionId && job.parentSessionId !== callerSessionId) {
    return {
      content: `Refused: background job ${jobId} belongs to a different session.`,
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
