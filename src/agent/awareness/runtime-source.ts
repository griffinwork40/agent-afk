/**
 * Constructs a {@link RuntimeStateSource} from the provider's per-query state.
 *
 * Shared by both `anthropic-direct` and `openai-compatible` providers so the
 * resulting snapshot shape is provider-agnostic. Providers supply callbacks so
 * subsequent `get_runtime_state` calls can see up-to-date subagent counts, MCP
 * tool counts, and git workspace state; openai-compatible's cwd callback is a
 * known per-query snapshot until #876.
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
  RuntimeUsageEntry,
  Surface,
  PhaseRole,
  McpServerSummary,
  McpFailedServer,
} from './types.js';
import { gatherWorkspace } from './workspace-source.js';
import { readUsageRecords } from '../usage/usage-snapshot.js';
import { compactUsageEntries } from '../usage/usage-formatter.js';
import {
  aggregateSubagentOutcomes,
  buildSubagentOutcomeSummary,
  type SubagentOutcomeSummaryEntry,
} from '../../insights/aggregators/subagent-outcomes.js';
import { debugLog } from '../../utils/debug.js';

// ---------------------------------------------------------------------------
// Module-level TTL cache for getSubagentOutcomeSummary
//
// The aggregator does a synchronous 1 MB tail-read of routing-decisions.jsonl
// on every call. Most get_runtime_state invocations within a short window will
// see the same data, so a 60-second TTL avoids the repeated I/O at negligible
// staleness cost. The cache is keyed per-file path so different afkHome values
// (common in tests) do not collide.
// ---------------------------------------------------------------------------

interface OutcomeSummaryCache {
  entries: SubagentOutcomeSummaryEntry[];
  expiresAt: number;
}

const OUTCOME_SUMMARY_TTL_MS = 60_000; // 60 s
const outcomeSummaryCache = new Map<string, OutcomeSummaryCache>();

function getCachedOutcomeSummary(afkHome: string | undefined): SubagentOutcomeSummaryEntry[] {
  const key = afkHome ?? '__default__';
  const cached = outcomeSummaryCache.get(key);
  if (cached !== undefined && Date.now() < cached.expiresAt) {
    return cached.entries;
  }
  try {
    const agg = aggregateSubagentOutcomes({ days: 30, ...(afkHome ? { afkHome } : {}) });
    const entries = buildSubagentOutcomeSummary(agg);
    outcomeSummaryCache.set(key, { entries, expiresAt: Date.now() + OUTCOME_SUMMARY_TTL_MS });
    return entries;
  } catch (err) {
    debugLog('[runtime-source] getCachedOutcomeSummary: aggregator threw, returning []:', String(err));
    return [];
  }
}

/**
 * Reset the outcome summary cache. Exported for test isolation only — do not
 * call in production code.
 *
 * @internal
 */
export function resetOutcomeSummaryCache(): void {
  outcomeSummaryCache.clear();
}

export interface RuntimeSourceDeps {
  /** Stable session UUID (may be undefined for pre-init sessions). */
  sessionId?: string | undefined;
  /** Provider-level surface tag (e.g. 'cli', 'daemon', 'telegram'). */
  surface: string;
  /**
   * Live accessor for the session working directory.
   *
   * Invariant: providers SHOULD supply a live callback, not a captured string.
   * The deferred born-named `afk -w` worktree path can repoint an anthropic-direct
   * session mid-flight, and both `getSelf().cwd` and `getWorkspace()` have to
   * follow it. A captured string silently pins the awareness layer to the launch
   * directory, so `get_runtime_state` and the `- Workspace:` prompt line keep
   * reporting the ORIGINAL checkout's branch and HEAD while the tools operate in
   * the new one. Known exception: openai-compatible currently freezes this value
   * per query; fixing its mid-query `setCwd()` staleness is tracked in #876.
   */
  getCwd: () => string;
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
   * Live accessor for MCP server states. Returns per-server connection status
   * including `error` and `oauth_pending` entries — the source for surfacing
   * failed servers in `get_runtime_state` (issue #1702). Returns `[]` when no
   * manager is wired.
   */
  getMcpServerStates: () => readonly { serverName: string; status: string; error?: string }[];

  /**
   * Live accessor for the active foreground subagents + background jobs.
   * Returns `{ active: [], backgroundJobs: [] }` when no executor is wired.
   */
  getSubagents: () => RuntimeSubagents;

  /**
   * AFK home directory used to locate routing-decisions.jsonl for the
   * subagent outcome summary cache. When omitted the default path from
   * `getRoutingDecisionsPath()` is used. Provided so different `afkHome`
   * values (common in tests) do not collide in the module-level cache.
   */
  afkHome?: string | undefined;
}

/**
 * Builds a {@link RuntimeStateSource} that pulls fresh data on every call.
 *
 * Note: `getSelf()` returns a fresh object literal each call, but the values
 * inside are captured by reference at source-construction time except for
 * those exposed as live accessors. For Phase 1 this is fine — identity fields
 * (`sessionId`, `depth`, `parentSessionId`, etc.) do not change mid-session.
 *
 * `getWorkspace()` recomputes git workspace state on every call via
 * `gatherWorkspace(deps.getCwd())`, mirroring the live `getTools()`/
 * `getSubagents()` accessors. This costs 4 `spawnSync` git calls per
 * invocation, but means the model sees the *current* dirty-file count / HEAD /
 * branch when it orients, not a frozen session-start snapshot that silently
 * goes stale as files change.
 *
 * `deps.getCwd` is likewise a callback rather than a string: anthropic-direct
 * sessions can be repointed mid-flight by the deferred born-named `afk -w`
 * worktree path, and a captured cwd would pin the awareness layer to the launch
 * checkout — reporting the wrong branch and HEAD for the remaining session.
 * Known exception: openai-compatible freezes this value per query until #876.
 */
export function buildRuntimeStateSource(deps: RuntimeSourceDeps): RuntimeStateSource {
  return {
    getSelf(): RuntimeSelf {
      return {
        sessionId: deps.sessionId ?? null,
        surface: coerceSurface(deps.surface),
        parentSessionId: deps.parentSessionId ?? null,
        depth: deps.depth ?? null,
        maxDepth: deps.maxDepth ?? null,
        phaseRole: deps.phaseRole ?? null,
        cwd: deps.getCwd(),
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
        failedServers: collectFailedServers(deps.getMcpServerStates()),
      };
    },
    getSubagents(): RuntimeSubagents {
      return deps.getSubagents();
    },
    getWorkspace(): RuntimeWorkspace {
      // Live on BOTH axes: the cwd is re-read per call (so a mid-session
      // setCwd re-anchors which repo we report on) and git is re-run against
      // it (so the snapshot reflects edits made since session start — the
      // agent's own writes AND concurrent external writers).
      // Cost: 4 spawnSync git calls per call (see gatherWorkspace).
      return gatherWorkspace(deps.getCwd());
    },
    getUsage(): RuntimeUsageEntry[] {
      // Shared reader + formatter (agent/usage/*): ledger + in-process cache,
      // no network, safe on every get_runtime_state call.
      return compactUsageEntries(readUsageRecords());
    },
    getSubagentOutcomeSummary() {
      // Reads the last 1 MB tail of routing-decisions.jsonl (synchronous,
      // bounded). Results are cached for 60 s so repeated get_runtime_state
      // calls within a session window avoid redundant I/O. The aggregator
      // never throws; getCachedOutcomeSummary adds a belt-and-suspenders
      // catch for unexpected errors.
      return getCachedOutcomeSummary(deps.afkHome);
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
      // `default`, `plan`, `autonomous` (AFK), and any unrecognised value fall
      // through here. Plan and AFK modes are RESTRICTIVE, not elevated — AFK
      // adds a high-risk-op gate on top of default, it does not bypass
      // permissions. The model observes those restrictions through real-time
      // tool denials and its system-prompt posture addendum, not through this
      // coarse anti-injection field (which exists to hide bypass/auto-accept).
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
    case 'web':
    case 'sdk':
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

/**
 * Collect MCP servers that failed to connect. Filters to `error` status only
 * (not `disabled`, `connecting`, `connected`, or `oauth_pending`) and returns
 * a sorted summary with server name + human-readable reason (issue #1702).
 */
function collectFailedServers(
  states: readonly { serverName: string; status: string; error?: string }[],
): McpFailedServer[] {
  return states
    .filter((s) => s.status === 'error')
    .map((s) => ({ name: s.serverName, reason: s.error ?? 'unknown error' }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
