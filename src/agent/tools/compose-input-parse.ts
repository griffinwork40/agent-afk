/**
 * Input parsing and validation for the compose tool.
 *
 * Extracted from compose-executor.ts to stay under the 350-code-line ceiling.
 * The executor delegates all schema-level validation here; runtime validation
 * (root-breadth guards) remains in dag-subagent.ts's validateDagNodeRoots.
 *
 * @module agent/tools/compose-input-parse
 */

import type { DAGEdge } from '../dag.js';
import { parseComposeBudgets, parseToolRounds } from './compose-input-parse.budgets.js';
import { validateRootPath } from './subagent/root-validation.js';

export interface ComposeNodeInput {
  id: string;
  prompt: string;
  model?: string;
  /** Per-node working directory override. Same semantics as the agent tool's cwd. */
  cwd?: string;
  /** Per-node extra read roots. Same semantics as the agent tool's readRoots. */
  readRoots?: string[];
  /** Per-node extra write roots. Same semantics as the agent tool's writeRoots. */
  writeRoots?: string[];
  /** Per-node tool-use round budget. Overrides compose-level max_tool_rounds_per_node. */
  max_tool_rounds?: number;
  /** Per-node turn budget. Forwarded to the fork config as maxTurns. */
  max_turns?: number;
  /**
   * Named agent type for this node. When set, the compose executor resolves
   * the agent definition from the registry and applies its system prompt,
   * tool allowlist, and model defaults — identical to the `agent` tool's
   * `agent_type` resolution. An unknown type fails the entire compose call
   * with a clear error naming the available types.
   */
  agent_type?: string;
  /**
   * Optional inbound image ids or absolute image paths to attach to this
   * node's initial prompt. Same semantics as the `agent` tool's attachments
   * field: image IDs are resolved against the session's inbound attachment
   * registry; absolute paths are read under the parent's read-root policy.
   * Resolved to `ImageBlockAttachment[]` in compose-executor.ts and injected
   * as multimodal `ContentBlockParam[]` blocks via `appendImageBlocks`.
   */
  attachments?: string[];
  /**
   * Filesystem isolation for this node. "none" (default) runs the node in
   * the shared parent tree. "worktree" creates a fresh managed git worktree
   * for this node so its writes/tests never collide with sibling nodes.
   * Mutually exclusive with cwd — the worktree path IS the node's cwd.
   */
  isolation?: 'none' | 'worktree';
}

export interface ComposeInput {
  nodes: ComposeNodeInput[];
  edges?: DAGEdge[];
  fail_fast?: boolean;
  node_timeout_ms?: number;
  /**
   * Per-node tool-use ROUND budget, normalized from either
   * `max_tool_rounds_per_node` (preferred) or the deprecated
   * `max_tool_calls_per_node` alias. Forwarded to each node's fork config as
   * `maxToolUseIterations` — see the budget note in ComposeExecutor.
   * Per-node `max_tool_rounds` overrides this.
   */
  max_tool_rounds_per_node?: number;
}

export interface ParseResult {
  parsed: ComposeInput;
  /** Human-readable warnings to surface in the compose result output. */
  warnings: string[];
}

/**
 * Parse and validate per-node path fields (cwd, readRoots, writeRoots).
 * Returns the validated values or throws on invalid input.
 *
 * Two layers of validation run here:
 *   1. Structural checks (absolute path, no ".." segments, non-empty string).
 *   2. Breadth guards (isTooBroadRoot, ungatedSensitiveRoot) applied inline as
 *      defense-in-depth. The same guards also run downstream in
 *      validateDagNodeRoots (dag-subagent.ts), but applying them here closes
 *      the architectural brittleness where the defense depends on a single
 *      downstream callsite.
 */
function parseNodePaths(n: Record<string, unknown>, id: string): {
  cwd?: string;
  readRoots?: string[];
  writeRoots?: string[];
} {
  const cwd = n['cwd'] === undefined ? undefined
    : validateRootPath(n['cwd'], 'cwd', { kind: 'compose', nodeId: id });

  const readRoots = parseRootArray(n, id, 'readRoots');
  const writeRoots = parseRootArray(n, id, 'writeRoots');

  return { cwd, readRoots, writeRoots };
}

/** Shared parser for readRoots / writeRoots array fields. */
function parseRootArray(
  n: Record<string, unknown>,
  id: string,
  field: 'readRoots' | 'writeRoots',
): string[] | undefined {
  if (n[field] === undefined) return undefined;
  if (!Array.isArray(n[field])) {
    throw new Error(`Node "${id}" ${field} must be an array`);
  }
  const roots = Array.from(n[field] as unknown[], (entry) =>
    validateRootPath(entry, field, { kind: 'compose', nodeId: id }),
  );
  return roots.length > 0 ? roots : undefined;
}

/** Validate nodes in input order, sharing only the explicitly supplied ID set. */
function parseComposeNodes(nodes: unknown, seenIds: Set<string>): ComposeNodeInput[] {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new Error('Compose tool requires a non-empty "nodes" array');
  }

  const MAX_NODES = 20;
  if (nodes.length > MAX_NODES) {
    throw new Error(
      `Compose tool supports at most ${MAX_NODES} nodes (got ${nodes.length}). ` +
      `Split into multiple compose calls for larger workloads.`,
    );
  }

  const parsed: ComposeNodeInput[] = [];
  for (const node of nodes) {
    parsed.push(parseComposeNode(node, seenIds));
  }
  return parsed;
}

/** Preserve field-validation precedence within each node. */
function parseComposeNode(node: unknown, seenIds: Set<string>): ComposeNodeInput {
  if (typeof node !== 'object' || node === null) {
    throw new Error('Each node must be an object');
  }
  const n = node as Record<string, unknown>;
  const id = n['id'];
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new Error('Each node must have a non-empty "id" string');
  }
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    // Strip control chars + truncate in the error itself so it cannot
    // become a log-forge vector even on the error path.
    const safeId = id.replace(/[\x00-\x1f\x7f]/g, '?').slice(0, 32);
    throw new Error(
      `Node id "${safeId}" must match /^[A-Za-z0-9_-]+$/ (alphanumeric, underscore, hyphen)`,
    );
  }
  if (seenIds.has(id)) {
    throw new Error(`Duplicate node ID: ${id}`);
  }
  seenIds.add(id);

  const prompt = n['prompt'];
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw new Error(`Node "${id}" must have a non-empty "prompt" string`);
  }

  let model: string | undefined;
  if (n['model'] !== undefined) {
    if (typeof n['model'] !== 'string') {
      throw new Error(`Node "${id}" model must be a string`);
    }
    model = n['model'];
  }

  const { cwd, readRoots, writeRoots } = parseNodePaths(n, id);

  let nodeMaxToolRounds: number | undefined;
  if (n['max_tool_rounds'] !== undefined) {
    nodeMaxToolRounds = parseToolRounds(n['max_tool_rounds'], `node "${id}" max_tool_rounds`);
  }

  let nodeMaxTurns: number | undefined;
  if (n['max_turns'] !== undefined) {
    const val = n['max_turns'];
    if (typeof val !== 'number' || !Number.isFinite(val) || !Number.isInteger(val) || val <= 0) {
      throw new Error(`Node "${id}" max_turns must be a positive integer`);
    }
    nodeMaxTurns = val;
  }

  let nodeAgentType: string | undefined;
  if (n['agent_type'] !== undefined) {
    if (typeof n['agent_type'] !== 'string' || n['agent_type'].trim().length === 0) {
      throw new Error(`Node "${id}" agent_type must be a non-empty string`);
    }
    nodeAgentType = n['agent_type'];
  }

  let nodeAttachments: string[] | undefined;
  if (n['attachments'] !== undefined) {
    if (!Array.isArray(n['attachments'])) {
      throw new Error(`Node "${id}" attachments must be an array`);
    }
    const atts: string[] = [];
    for (const a of n['attachments'] as unknown[]) {
      if (typeof a !== 'string' || a.trim().length === 0) {
        throw new Error(`Node "${id}" attachments entries must be non-empty strings`);
      }
      atts.push(a);
    }
    if (atts.length > 0) nodeAttachments = atts;
  }

  let nodeIsolation: 'none' | 'worktree' | undefined;
  if (n['isolation'] !== undefined) {
    if (n['isolation'] !== 'none' && n['isolation'] !== 'worktree') {
      throw new Error(`Node "${id}" isolation must be "none" or "worktree" (got ${JSON.stringify(n['isolation'])})`);
    }
    nodeIsolation = n['isolation'];
    // isolation:"worktree" is mutually exclusive with cwd — the worktree
    // path IS the node's cwd. Allowing both would ambiguously combine an
    // explicit cwd pin with worktree creation, making the effective cwd
    // unpredictable. Callers that need a specific directory should omit
    // isolation and manage their own worktree, or use isolation and let
    // the runtime derive the worktree path automatically.
    if (nodeIsolation === 'worktree' && cwd !== undefined) {
      throw new Error(
        `Node "${id}" cannot set both cwd and isolation:"worktree". ` +
        `The worktree path IS the node's cwd — omit cwd to use isolation, ` +
        `or omit isolation to pin a specific cwd.`,
      );
    }
    if (nodeIsolation === 'worktree' && writeRoots !== undefined) {
      throw new Error(
        `Node "${id}" cannot set both writeRoots and isolation:"worktree". ` +
        `Isolation confines writes to the worktree; explicit writeRoots would ` +
        `punch holes in that boundary.`,
      );
    }
    // Normalize isolation:"none" to undefined so the output interface is
    // consistent with the agent-tool parser, which never emits isolation:"none".
    if (nodeIsolation === 'none') nodeIsolation = undefined;
  }

  return {
    id,
    prompt,
    model,
    ...(cwd !== undefined ? { cwd } : {}),
    ...(readRoots !== undefined ? { readRoots } : {}),
    ...(writeRoots !== undefined ? { writeRoots } : {}),
    ...(nodeMaxToolRounds !== undefined ? { max_tool_rounds: nodeMaxToolRounds } : {}),
    ...(nodeMaxTurns !== undefined ? { max_turns: nodeMaxTurns } : {}),
    ...(nodeAgentType !== undefined ? { agent_type: nodeAgentType } : {}),
    ...(nodeAttachments !== undefined ? { attachments: nodeAttachments } : {}),
    ...(nodeIsolation !== undefined ? { isolation: nodeIsolation } : {}),
  };
}

/** Validate edge endpoints against the IDs collected while parsing nodes. */
function parseComposeEdges(obj: Record<string, unknown>, seenIds: Set<string>): DAGEdge[] | undefined {
  let edges: DAGEdge[] | undefined;
  if (obj['edges'] !== undefined) {
    if (!Array.isArray(obj['edges'])) {
      throw new Error('"edges" must be an array');
    }
    edges = [];
    for (const edge of obj['edges']) {
      if (typeof edge !== 'object' || edge === null) {
        throw new Error('Each edge must be an object');
      }
      const e = edge as Record<string, unknown>;
      if (typeof e['from'] !== 'string' || typeof e['to'] !== 'string') {
        throw new Error('Each edge must have "from" and "to" strings');
      }
      if (!seenIds.has(e['from'])) {
        throw new Error(`Edge references non-existent node: ${e['from']}`);
      }
      if (!seenIds.has(e['to'])) {
        throw new Error(`Edge references non-existent node: ${e['to']}`);
      }
      edges.push({ from: e['from'], to: e['to'] });
    }
  }

  return edges;
}

export function parseComposeInput(input: unknown): ParseResult {
  if (typeof input !== 'object' || input === null) {
    throw new Error('Compose tool input must be an object');
  }

  const obj = input as Record<string, unknown>;
  const seenIds = new Set<string>();
  // Invariant: nodes, edges, fail_fast, timeout, then round-budget aliases.
  const parsed = parseComposeNodes(obj['nodes'], seenIds);
  const edges = parseComposeEdges(obj, seenIds);

  let failFast: boolean | undefined;
  if (obj['fail_fast'] !== undefined) {
    if (typeof obj['fail_fast'] !== 'boolean') {
      throw new Error('"fail_fast" must be a boolean');
    }
    failFast = obj['fail_fast'];
  }

  const { nodeTimeoutMs, maxToolRoundsPerNode, warnings } = parseComposeBudgets(obj);

  return {
    parsed: {
      nodes: parsed,
      edges,
      fail_fast: failFast,
      node_timeout_ms: nodeTimeoutMs,
      max_tool_rounds_per_node: maxToolRoundsPerNode,
    },
    warnings,
  };
}
