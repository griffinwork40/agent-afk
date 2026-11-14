import type { SubagentDAGNode } from '../dag-subagent.js';

type BuildResult = SubagentDAGNode | { attachmentError: true; nodeId: string; error: Error } | { usageBlocked: true; nodeId: string; notice: string };

/** Preserve build-time attachment failures and usage blocks separately from runnable nodes. */
export function splitComposeNodeResults(results: BuildResult[]): {
  dagNodes: SubagentDAGNode[];
  attachmentErrors: Array<{ id: string; error: Error }>;
  usageBlocks: Array<{ id: string; notice: string }>;
} {
  const dagNodes: SubagentDAGNode[] = [];
  const attachmentErrors: Array<{ id: string; error: Error }> = [];
  const usageBlocks: Array<{ id: string; notice: string }> = [];
  for (const result of results) {
    if ('attachmentError' in result) attachmentErrors.push({ id: result.nodeId, error: result.error });
    else if ('usageBlocked' in result) usageBlocks.push({ id: result.nodeId, notice: result.notice });
    else dagNodes.push(result);
  }
  return { dagNodes, attachmentErrors, usageBlocks };
}
