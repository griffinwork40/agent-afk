/**
 * Topology spine data model — pure functions, no React.
 *
 * Builds a hierarchical SpineNode tree from a flat TranscriptItem array.
 * The tree mirrors what the TUI's topology spine renders: tool calls are
 * leaves; subagents that were dispatched by a tool call are children of that
 * tool node; top-level subagents (no parentToolUseId) and tool calls that
 * did not dispatch a subagent are roots.
 *
 * Invariant: `parentToolUseId` is the primary linkage. When it is absent (older
 * sessions), subagents fall back to parentId-only nesting (agent→agent), or
 * appear flat if neither link is present. Out-of-order SSE is handled by a
 * two-pass approach: first pass builds nodes, second pass re-parents orphans.
 */

import type { TranscriptItem, ToolCallItem, SubagentItem } from '@/lib/ledger-adapter';
import type { SpineNode, ToolCategory } from '@/lib/topology-types';

// ---------------------------------------------------------------------------
// Tool categorization
// ---------------------------------------------------------------------------

// Contract: every name in each set is lower-cased. Matching is exact (Map
// lookup), with a prefix check for 'mcp__' before falling through to 'other'.
const READ_TOOLS = new Set([
  'read_file', 'glob', 'grep', 'list_directory', 'json_query',
  'read_witness', 'search_witness', 'get_facet', 'clipboard_read',
]);

const WRITE_TOOLS = new Set([
  'write_file', 'edit_file', 'patch_apply', 'clipboard_write', 'procedure_write',
]);

const SHELL_TOOLS = new Set(['bash', 'test_run', 'wait_for']);

const AGENT_TOOLS = new Set(['agent', 'send_message_to_agent', 'cancel_background_job']);

const SKILL_TOOLS = new Set(['skill']);

const DAG_TOOLS = new Set(['compose']);

const WEB_TOOLS = new Set(['web_scrape', 'web_request']);

const BROWSER_TOOLS = new Set([
  'browser_open', 'browser_act', 'browser_observe', 'browser_screenshot', 'browser_close',
]);

// Storage tools — grouped under 'other' per spec.
const STORAGE_TOOLS = new Set([
  'memory_search', 'memory_update',
  'state_get', 'state_put', 'state_cas', 'state_delete', 'state_query',
  'workspace_publish', 'workspace_query',
]);

/**
 * Map a raw tool name to its display category.
 *
 * Contract: returns 'other' for any unrecognized name. MCP tools are
 * identified by the 'mcp__' prefix (two underscores) before the server name.
 */
export function categorizeToolName(name: string): ToolCategory {
  if (READ_TOOLS.has(name))    return 'read';
  if (WRITE_TOOLS.has(name))   return 'write';
  if (SHELL_TOOLS.has(name))   return 'shell';
  if (AGENT_TOOLS.has(name))   return 'agent';
  if (SKILL_TOOLS.has(name))   return 'skill';
  if (DAG_TOOLS.has(name))     return 'dag';
  if (WEB_TOOLS.has(name))     return 'web';
  if (BROWSER_TOOLS.has(name)) return 'browser';
  if (STORAGE_TOOLS.has(name)) return 'other';
  if (name.startsWith('mcp__')) return 'mcp';
  return 'other';
}

// ---------------------------------------------------------------------------
// Duration + cost formatters
// ---------------------------------------------------------------------------

/**
 * Format elapsed milliseconds in compact human-readable form.
 *
 * Contract: matches TUI spine format exactly.
 *   <1000 ms  -> "<1s"
 *   1-60 s    -> "X.Xs"
 *   60+ s     -> "Xm Xs"
 */
export function formatSpineDuration(ms: number): string {
  if (ms < 1000) return '<1s';
  const totalSec = ms / 1000;
  if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
  const minutes = Math.floor(totalSec / 60);
  const seconds = Math.floor(totalSec % 60);
  return `${minutes}m ${seconds}s`;
}

/**
 * Format a USD cost value for display in the spine.
 *
 * Contract: values below $0.001 show as "<$0.001"; others show 3 decimal
 * places (e.g. "$0.023").
 */
export function formatSpineCost(usd: number): string {
  if (usd < 0.001) return '<$0.001';
  return `$${usd.toFixed(3)}`;
}

// ---------------------------------------------------------------------------
// SpineNode factories
// ---------------------------------------------------------------------------

function toolNodeStatus(status: ToolCallItem['status']): SpineNode['status'] {
  if (status === 'error') return 'error';
  if (status === 'ok')    return 'ok';
  return 'running';
}

function subagentNodeStatus(status: string): SpineNode['status'] {
  if (status === 'succeeded') return 'ok';
  if (status === 'failed')    return 'error';
  if (status === 'cancelled') return 'cancelled';
  return 'running';
}

/** Build a SpineNode for a tool-call item. */
function makeToolNode(tool: ToolCallItem): SpineNode {
  const status = toolNodeStatus(tool.status);
  return {
    id: tool.id,
    kind: 'tool',
    label: tool.name,
    category: categorizeToolName(tool.name),
    status,
    preview: tool.inputPreview,
    durationMs: tool.durationMs,
    children: [],
    isActive: status === 'running',
    sourceId: tool.toolUseId,
  };
}

/** Build a SpineNode for a subagent item. */
function makeAgentNode(sub: SubagentItem): SpineNode {
  const status = subagentNodeStatus(sub.status);
  return {
    id: sub.id,
    kind: 'agent',
    label: sub.label,
    category: 'agent',
    status,
    preview: sub.promptHead,
    durationMs: sub.durationMs,
    costUsd: sub.totalCostUsd,
    model: sub.model,
    agentType: sub.agentType,
    turnCount: sub.turnCount,
    children: [],
    isActive: status === 'running',
    sourceId: sub.subagentId,
  };
}

// ---------------------------------------------------------------------------
// Main tree builder
// ---------------------------------------------------------------------------

/**
 * Build the topology spine tree from a flat TranscriptItem list.
 *
 * Algorithm:
 *   1. Separate items into tool items and subagent items; record input position
 *      for each (used to sort roots into SSE arrival order at the end).
 *   2. Build lookup maps: toolUseId → ToolCallItem (toolByUseId) and
 *      item.id → SpineNode for tool nodes (nodeByToolId).
 *   3. Create SpineNodes for all tools and subagents.
 *   4. Link subagent nodes via parentToolUseId → tool node (primary). When the
 *      tool node is found it is promoted to kind='agent' and the subagent
 *      becomes its child; the tool is marked as "claimed".
 *   5. Fallback: parentId → nest under a parent subagent node (agent→agent).
 *   6. Second pass: re-parent any orphaned nodes using the same two-step logic.
 *   7. Pass 5: add ONLY unclaimed tool nodes as roots.
 *   8. Sort all roots by input position to preserve SSE arrival order.
 *
 * Invariant: parentToolUseId is the primary linkage mechanism. When absent
 * (older sessions), parentId is the secondary linkage. When neither is present
 * the subagent appears as a flat root item.
 *
 * Contract: items are processed in order — tools before subagents that
 * reference them is the common case (SSE order). Out-of-order items are
 * handled by the second pass.
 */
export function buildSpineTree(items: TranscriptItem[]): SpineNode[] {
  // --- Pass 1: collect raw items + track input positions ---
  const toolItems: ToolCallItem[] = [];
  const subagentItems: SubagentItem[] = [];
  // Track input position for SSE-order root sorting.
  const inputPosition = new Map<string, number>();

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item === undefined) continue;
    if (item.kind === 'tool') {
      toolItems.push(item);
      inputPosition.set(item.id, i);
    }
    if (item.kind === 'subagent') {
      subagentItems.push(item);
      inputPosition.set(item.id, i);
    }
  }

  // Build lookup maps for O(1) linking.
  const toolByUseId = new Map<string, ToolCallItem>();
  for (const t of toolItems) {
    if (t.toolUseId) toolByUseId.set(t.toolUseId, t);
  }

  // --- Pass 2: build SpineNodes ---
  const nodeByToolId = new Map<string, SpineNode>();
  const nodeBySubId = new Map<string, SpineNode>();
  const toolClaimedByAgent = new Set<string>();

  for (const t of toolItems) {
    nodeByToolId.set(t.id, makeToolNode(t));
  }
  for (const s of subagentItems) {
    nodeBySubId.set(s.subagentId, makeAgentNode(s));
  }

  // --- Pass 3: link subagents to parent tool or parent subagent ---
  const roots: SpineNode[] = [];
  const orphanedAgentNodes: SpineNode[] = [];

  for (const s of subagentItems) {
    const agentNode = nodeBySubId.get(s.subagentId);
    if (!agentNode) continue;

    // Primary link: parentToolUseId → find the tool node that dispatched this.
    if (s.parentToolUseId) {
      const parentTool = toolByUseId.get(s.parentToolUseId);
      if (parentTool) {
        const parentToolNode = nodeByToolId.get(parentTool.id);
        if (parentToolNode) {
          parentToolNode.kind = 'agent';
          parentToolNode.children.push(agentNode);
          toolClaimedByAgent.add(parentTool.id);
          continue;
        }
      }
      orphanedAgentNodes.push(agentNode);
      continue;
    }

    // Secondary link: parentId → nest under a parent subagent node.
    if (s.parentId) {
      const parentSubNode = nodeBySubId.get(s.parentId);
      if (parentSubNode) {
        parentSubNode.children.push(agentNode);
        continue;
      }
      orphanedAgentNodes.push(agentNode);
      continue;
    }

    // No link: flat root agent.
    roots.push(agentNode);
  }

  // --- Pass 4: re-parent orphaned agent nodes ---
  // Handles out-of-order SSE where a subagent arrived before its parent node.
  const stillOrphaned: SpineNode[] = [];
  for (const agentNode of orphanedAgentNodes) {
    const s = subagentItems.find((x) => x.subagentId === agentNode.sourceId);
    if (!s) { roots.push(agentNode); continue; }

    let placed = false;

    if (s.parentToolUseId) {
      const parentTool = toolByUseId.get(s.parentToolUseId);
      if (parentTool) {
        const parentToolNode = nodeByToolId.get(parentTool.id);
        if (parentToolNode) {
          parentToolNode.kind = 'agent';
          parentToolNode.children.push(agentNode);
          toolClaimedByAgent.add(parentTool.id);
          placed = true;
        }
      }
    }

    if (!placed && s.parentId) {
      const parentSubNode = nodeBySubId.get(s.parentId);
      if (parentSubNode) {
        parentSubNode.children.push(agentNode);
        placed = true;
      }
    }

    if (!placed) stillOrphaned.push(agentNode);
  }

  for (const node of stillOrphaned) {
    roots.push(node);
  }

  // --- Pass 5: add unclaimed tool nodes as roots ---
  // Only tool nodes that were NOT claimed by a subagent appear as standalone
  // roots. Claimed nodes are already nested under their dispatching subagent.
  for (const t of toolItems) {
    if (!toolClaimedByAgent.has(t.id)) {
      const toolNode = nodeByToolId.get(t.id);
      if (toolNode) roots.push(toolNode);
    }
  }

  // Sort roots by input position to preserve SSE arrival order.
  roots.sort((a, b) => (inputPosition.get(a.id) ?? 0) - (inputPosition.get(b.id) ?? 0));

  return roots;
}
