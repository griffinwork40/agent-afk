/** Tool category for icon + color mapping. */
export type ToolCategory =
  | 'read'
  | 'write'
  | 'shell'
  | 'agent'
  | 'skill'
  | 'dag'
  | 'mcp'
  | 'web'
  | 'browser'
  | 'plan'
  | 'other';

/**
 * A node in the topology spine tree.
 *
 * Invariant: `children` contains only nodes that were dispatched by this node.
 * The primary linkage is parentToolUseId (subagent → tool node that called
 * agent/compose). The secondary linkage is parentId (subagent → parent
 * subagent, agent→agent nesting). Root-level nodes have no such link. Tool
 * nodes that did not dispatch a subagent appear as standalone leaves.
 */
export interface SpineNode {
  /** Stable unique id for React keys. */
  id: string;
  kind: 'tool' | 'agent' | 'root';
  /** Tool name or agent label. */
  label: string;
  category: ToolCategory;
  status: 'running' | 'ok' | 'error' | 'cancelled';
  /**
   * For tool nodes: inputPreview of the tool call.
   * For agent nodes: promptHead of the subagent.
   */
  preview?: string;
  /** Elapsed milliseconds. */
  durationMs?: number;
  /** USD cost (agent nodes only). */
  costUsd?: number;
  /** Model used (agent nodes only). */
  model?: string;
  /** Agent type resolved label (agent nodes only, e.g. "research"). */
  agentType?: string;
  /** Number of conversation turns the subagent ran (agent nodes only). */
  turnCount?: number;
  /** Child nodes dispatched by this node. */
  children: SpineNode[];
  /** True when this node has no terminal status yet. */
  isActive: boolean;
  /**
   * The toolUseId if this is a tool node, or subagentId if an agent node.
   * Used as the linkage key between parent tools and child agents.
   */
  sourceId?: string;
}
