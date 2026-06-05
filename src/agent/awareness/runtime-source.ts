/**
 * Constructs a {@link RuntimeStateSource} from the provider's per-query state.
 *
 * Shared by both `anthropic-direct` and `openai-compatible` providers so the
 * resulting snapshot shape is provider-agnostic. The provider supplies live
 * accessors (lambdas), not snapshots, so subsequent `get_runtime_state` calls
 * see up-to-date subagent and MCP tool counts.
 *
 * @module agent/awareness/runtime-source
 */

import type { AnthropicToolDef } from '../tools/types.js';
import type {
  RuntimeStateSource,
  RuntimeSelf,
  RuntimeTools,
  RuntimeSubagents,
  RuntimeWorkspace,
  Surface,
  PhaseRole,
  McpServerSummary,
} from './types.js';
import { gatherWorkspace } from './workspace-source.js';

export interface RuntimeSourceDeps {
  /** Stable session UUID (may be undefined for pre-init sessions). */
  sessionId?: string | undefined;
  /** Provider-level surface tag (e.g. 'cli', 'daemon', 'telegram'). */
  surface: string;
  /** Working directory at query time. */
  cwd: string;
  /** Resolved model identifier the SDK will be called with. */
  modelName: string;
  /** Provider name — e.g. 'anthropic-direct' or 'openai-compatible'. */
  providerName: string;
  /** Permission mode active for this query. */
  permissionMode: string;
  /** Parent session ID when this is a forked subagent; undefined at top level. */
  parentSessionId?: string | undefined;
  /** Nesting depth from AgentConfig; undefined at top level. */
  depth?: number | undefined;
  /** Max nesting depth from AgentConfig; undefined when unset. */
  maxDepth?: number | undefined;
  /** Phase role from AgentConfig; undefined when not enforced. */
  phaseRole?: PhaseRole | undefined;

  /**
   * Live accessor for the enabled tool names. Called on every `get_runtime_state`
   * tool dispatch so MCP `notifications/tools/list_changed` refreshes show up
   * without restart.
   */
  getEnabledToolNames: () => string[];

  /**
   * Live accessor for MCP tool defs. Returns whatever the manager currently
   * advertises (or `[]` when no manager is wired). Used to derive per-server
   * tool counts via the `mcp__<server>__<tool>` naming convention.
   */
  getMcpTools: () => readonly AnthropicToolDef[];

  /**
   * Live accessor for the active foreground subagents + background jobs.
   * Returns `{ active: [], backgroundJobs: [] }` when no executor is wired.
   */
  getSubagents: () => RuntimeSubagents;
}

/**
 * Builds a {@link RuntimeStateSource} that pulls fresh data on every call.
 *
 * Note: `getSelf()` returns a fresh object literal each call, but the values
 * inside are captured by reference at source-construction time except for
 * those exposed as live accessors. For Phase 1 this is fine — identity fields
 * (`sessionId`, `depth`, `parentSessionId`, etc.) do not change mid-session.
 *
 * Phase 2: `getWorkspace()` returns the git baseline captured once via
 * `gatherWorkspace(deps.cwd)` at construction time. Git state changes rarely
 * and the model only needs orientation — a session-start snapshot is enough.
 * Callers that need a fresher snapshot should construct a new source.
 */
export function buildRuntimeStateSource(deps: RuntimeSourceDeps): RuntimeStateSource {
  // Gather the workspace baseline once, synchronously, at construction time.
  // `gatherWorkspace` runs 4 spawnSync git calls but the result is stable for
  // the session lifetime. Caching it here means every `get_runtime_state`
  // call returns the same object without re-spawning.
  const workspace: RuntimeWorkspace = gatherWorkspace(deps.cwd);

  return {
    getSelf(): RuntimeSelf {
      return {
        sessionId: deps.sessionId ?? null,
        surface: coerceSurface(deps.surface),
        parentSessionId: deps.parentSessionId ?? null,
        depth: deps.depth ?? null,
        maxDepth: deps.maxDepth ?? null,
        phaseRole: deps.phaseRole ?? null,
        cwd: deps.cwd,
        model: {
          provider: deps.providerName,
          name: deps.modelName,
        },
        permissionMode: bucketPermissionMode(deps.permissionMode),
      };
    },
    getTools(): RuntimeTools {
      return {
        enabled: deps.getEnabledToolNames(),
        mcpServers: summarizeMcpServers(deps.getMcpTools()),
      };
    },
    getSubagents(): RuntimeSubagents {
      return deps.getSubagents();
    },
    getWorkspace(): RuntimeWorkspace {
      return workspace;
    },
  };
}

/**
 * Bucket the raw SDK {@link PermissionMode} to the coarse snapshot field.
 *
 * Auto-accept / bypass variants collapse to `elevated`. Everything else —
 * including the literal `default`, `plan` (read-only intent), and any
 * unrecognised future value — collapses to `default`. This hides the raw
 * `bypassPermissions` token from a prompt-injection attacker who triggers
 * `get_runtime_state`, while preserving the coarse "elevated vs not" signal
 * the model legitimately needs for orientation.
 *
 * Invariant: never returns the raw input string. The snapshot is a typed
 * surface — callers downstream rely on the two-value union.
 */
function bucketPermissionMode(raw: string): 'elevated' | 'default' {
  switch (raw) {
    case 'bypassPermissions':
    case 'acceptEdits':
    case 'dontAsk':
    case 'auto':
      return 'elevated';
    default:
      // `default`, `plan`, and any unrecognised value fall through here.
      // Plan mode is restrictive, not elevated — the model observes its
      // restrictions through real-time tool denials, not through this field.
      return 'default';
  }
}

/** Map free-form provider `surface` string to the typed `Surface` union. */
function coerceSurface(raw: string): Surface {
  switch (raw) {
    case 'cli':
    case 'repl':
    case 'daemon':
    case 'telegram':
    case 'subagent':
      return raw;
    default:
      return 'unknown';
  }
}

/**
 * Group MCP tools by server name using the `mcp__<server>__<tool>` convention.
 * Robust to unexpected formats — tools that don't parse cleanly are skipped
 * silently rather than counted under a synthetic server name.
 */
function summarizeMcpServers(tools: readonly AnthropicToolDef[]): McpServerSummary[] {
  const counts = new Map<string, number>();
  for (const t of tools) {
    if (!t.name.startsWith('mcp__')) continue;
    // `mcp__server__tool` — split into at most 3 parts; server is index 1.
    const parts = t.name.split('__');
    if (parts.length < 3) continue;
    const server = parts[1];
    if (typeof server !== 'string' || server.length === 0) continue;
    counts.set(server, (counts.get(server) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, toolCount]) => ({ name, toolCount }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
