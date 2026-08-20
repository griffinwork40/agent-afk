import type { BackgroundAgentRegistry } from '../../background-registry.js';
import type { ToolCall, ToolResult } from '../types.js';

/** Execute model cancellation while preserving the user-owned provenance boundary. */
export async function cancelBackgroundJob(
  registry: BackgroundAgentRegistry | undefined,
  call: ToolCall,
): Promise<ToolResult> {
  const input = call.input as Record<string, unknown>;
  const jobId = typeof input['jobId'] === 'string' ? input['jobId'].trim() : '';
  const reason = typeof input['reason'] === 'string' ? input['reason'].trim() : '';
  if (!jobId || !reason) {
    return { content: 'cancel_background_job requires non-empty jobId and reason strings.', isError: true };
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
  if (job.status !== 'running') {
    return { content: `Background job ${jobId} is already ${job.status}; nothing to cancel.` };
  }
  if (job.provenance !== 'model') {
    return {
      content: `Refused: background job ${jobId} was backgrounded by the user. Ask the user to run /bgsub:cancel ${jobId}.`,
      isError: true,
    };
  }
  const issued = await registry.cancelModelJob(jobId, reason);
  return issued
    ? { content: `Cancellation requested for background job ${jobId} (${job.label}).` }
    : { content: `Background job ${jobId} became terminal before cancellation was issued.` };
}
