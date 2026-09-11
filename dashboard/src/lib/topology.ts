/**
 * Topology spine data model — pure functions, no React.
 *
 * Builds a hierarchical SpineNode tree from a flat TranscriptItem array.
 * The tree mirrors what the TUI's topology spine renders: tool calls are
 * leaves; subagents are nested under their parent subagent node via parentId;
 * top-level subagents (no parentId) appear as roots alongside standalone
 * tool leaves.
 *
 * Invariant: `parentId` is the sole linkage mechanism. When it is absent,
 * the subagent appears as a flat root item. Out-of-order SSE is handled by
 * a two-pass approach: first pass builds nodes, second pass re-parents orphans.
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
 *   1. Separate items into tool items and subagent items.
 *   2. Build a lookup map: subagentId → SubagentItem.
 *   3. Create SpineNodes for all tools and subagents.
 *   4. Link subagent nodes to their parent subagent node via parentId.
 *      Subagents with no parentId are roots.
 *   5. Tool nodes appear as standalone leaves (they are never parents of
 *      agents in this data model — there is no parentToolUseId field).
 *   6. Second pass: re-parent any orphaned nodes whose parent appeared later.
 *   7. Return root nodes (no parent link, or parent not found after both passes).
 *
 * Invariant: parentId is the sole linkage mechanism. When absent, the
 * subagent appears as a flat root item.
 *
 * Contract: items are processed in order — tools before subagents that
 * reference them is the common case (SSE order). Out-of-order items are
 * handled by the second pass.
 */
export function buildSpineTree(items: TranscriptItem[]): SpineNode[] {
  // --- Pass 1: collect raw items ---
  const toolItems: ToolCallItem[] = [];
  const subagentItems: SubagentItem[] = [];

  for (const item of items) {
    if (item.kind === 'tool')     toolItems.push(item);
    if (item.kind === 'subagent') subagentItems.push(item);
  }

  // --- Pass 2: build SpineNodes ---
  // nodeBySubId: spine node for each subagent (keyed by subagentId)
  const nodeBySubId = new Map<string, SpineNode>();

  for (const t of toolItems) {
    // Tool nodes are roots by default; we'll add them in pass 5.
    // Build them here so nodeByToolId is available if needed in future passes.
    void t; // tool nodes handled in pass 5
  }
  for (const s of subagentItems) {
    nodeBySubId.set(s.subagentId, makeAgentNode(s));
  }

  // --- Pass 3: link subagents to parent subagent via parentId ---
  const roots: SpineNode[] = [];
  const orphanedAgentNodes: SpineNode[] = []; // may be re-parented in pass 4

  for (const s of subagentItems) {
    const agentNode = nodeBySubId.get(s.subagentId);
    if (!agentNode) continue;

    // Link: parentId → nest under a parent subagent node.
    if (s.parentId) {
      const parentSubNode = nodeBySubId.get(s.parentId);
      if (parentSubNode) {
        parentSubNode.children.push(agentNode);
        continue;
      }
      // Parent subagent not yet seen — defer to pass 4.
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
    // Find the original SubagentItem to re-read its link fields.
    const s = subagentItems.find((x) => x.subagentId === agentNode.sourceId);
    if (!s) { roots.push(agentNode); continue; }

    let placed = false;

    if (s.parentId) {
      const parentSubNode = nodeBySubId.get(s.parentId);
      if (parentSubNode) {
        parentSubNode.children.push(agentNode);
        placed = true;
      }
    }

    if (!placed) stillOrphaned.push(agentNode);
  }

  // Remaining orphans become roots.
  for (const node of stillOrphaned) {
    roots.push(node);
  }

  // --- Pass 5: add all tool nodes as roots ---
  // Tool nodes are standalone leaves — they are not parents of agents in this
  // data model (there is no parentToolUseId field on SubagentItem).
  for (const t of toolItems) {
    roots.push(makeToolNode(t));
  }

  return roots;
}
