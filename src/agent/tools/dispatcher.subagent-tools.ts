import type { SubagentExecutor } from './subagent-executor.js';
import type { ToolCall, ToolResult } from './types.js';

export function isSubagentProviderTool(name: string): boolean {
  return name === 'agent' || name === 'cancel_background_job' || name === 'send_message_to_agent';
}

export interface SubagentProviderToolOutcome {
  result: ToolResult;
  thrownMessage?: string;
}

export async function executeSubagentProviderTool(
  executor: SubagentExecutor | undefined,
  call: ToolCall,
): Promise<SubagentProviderToolOutcome> {
  if (!executor) {
    return { result: {
      content: call.name === 'agent'
        ? 'Agent tool is not available in this session configuration'
        : 'Background mode is not available in this session configuration',
      isError: true,
    } };
  }
  try {
    const result = call.name === 'agent'
      ? await executor.execute(call)
      : call.name === 'send_message_to_agent'
        ? await executor.sendMessageToAgent(call)
        : await executor.cancelBackgroundJob(call);
    return { result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      result: {
        content: `${call.name === 'agent' ? 'Agent' : call.name === 'send_message_to_agent' ? 'Steering' : 'Background cancellation'} tool error: ${message}`,
        isError: true,
      },
      thrownMessage: message,
    };
  }
}
