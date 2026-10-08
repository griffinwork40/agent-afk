import type { SubagentDAGNode } from '../dag-subagent.js';

type BuildResult = SubagentDAGNode | { attachmentError: true; nodeId: string; error: Error };

/** Preserve build-time attachment failures separately from runnable nodes. */
export function splitComposeNodeResults(results: BuildResult[]): {
  dagNodes: SubagentDAGNode[]; attachmentErrors: Array<{ id: string; error: Error }>;
} {
  const dagNodes: SubagentDAGNode[] = [];
  const attachmentErrors: Array<{ id: string; error: Error }> = [];
  for (const result of results) {
    if ('attachmentError' in result) attachmentErrors.push({ id: result.nodeId, error: result.error });
    else dagNodes.push(result);
  }
  return { dagNodes, attachmentErrors };
}
