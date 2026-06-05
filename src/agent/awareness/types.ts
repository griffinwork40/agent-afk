/**
 * Type definitions for the agent situational-awareness layer (Phase 1 + 2).
 *
 * The runtime exposes a `get_runtime_state` tool that returns a compact JSON
 * snapshot of what the agent knows about itself. Four views are supported:
 *
 *   - `self`       — session identity + model + permissions + cwd
 *   - `tools`      — currently-enabled tool names + MCP server summary
 *   - `subagents`  — active subagent handles + background-job statuses
 *   - `workspace`  — git state (branch, HEAD SHA, dirty count, remote URL)
 *   - `all`        — the union of the four above (default)
 *
 * Design constraints (Phase 1):
 *   - All values are derived from in-memory state. Nothing is persisted.
 *   - Fields the runtime does not know (e.g. depth for a top-level session)
 *     are reported as `null` rather than synthesised — the model should be
 *     able to distinguish "unknown" from "zero".
 *   - This file declares only types. The `buildRuntimeSnapshot` builder lives
 *     in `runtime-snapshot.ts`; the live data sources live in `runtime-source.ts`.
 *
 * Design additions (Phase 2):
 *   - `RuntimeWorkspace` captures git state gathered once at session start.
 *   - `RuntimeStateSource` gains `getWorkspace()`.
 *   - `RuntimeSnapshot` gains `workspace`.
 *   - `RuntimeView` gains `'workspace'`.
 *
 * @module agent/awareness/types
 */

/**
 * Coarse-grained execution surface. Distinct from `PromptSurface`
 * (`routing-directive.ts`), which controls END_OF_TURN_DIRECTIVE injection.
 * This field is descriptive metadata for the agent's situational awareness;
 * it is the same string the provider already stores at `opts.surface`.
 */
export type Surface = 'cli' | 'repl' | 'daemon' | 'telegram' | 'subagent' | 'unknown';

/** Read/write phase enforcement tag inherited from `ForkSubagentOptions.phaseRole`. */
export type PhaseRole = 'read-only' | 'read-write';

/** Lifecycle status of an active or recently-finished subagent handle. */
export type SubagentStatusLiteValue =
  | 'idle'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

/** Lifecycle status of a background subagent job. */
export type BgJobStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * Identity + affordance fields for the current session.
 *
 * Nullable fields are unknown-by-default — Phase 1 does not auto-discover
 * branch/HEAD/parent for top-level sessions. A subagent session populated by
 * `SubagentManager.forkSubagent` will have non-null `parentSessionId`,
 * `depth`, `maxDepth`, and `phaseRole`.
 */
export interface RuntimeSelf {
  /** Stable UUID. `null` only on pre-init sessions (rare). */
  sessionId: string | null;
  /** Execution surface tag from the provider opts (defaults to 'cli'). */
  surface: Surface;
  /** Parent session ID when this is a forked subagent; `null` at top level. */
  parentSessionId: string | null;
  /** Nesting depth assigned at fork; `null` at top level. */
  depth: number | null;
  /** Hard ceiling for `agent`/`skill` recursion; `null` when unset. */
  maxDepth: number | null;
  /** Read-only vs read-write phase enforcement; `null` when not enforced. */
  phaseRole: PhaseRole | null;
  /** Current working directory (typically the worktree path under `-w`). */
  cwd: string;
  /** Provider + resolved model identifier. */
  model: { provider: string; name: string };
  /**
   * Active permission mode at snapshot time, bucketed to a coarse
   * `'elevated' | 'default'` rather than the raw SDK string.
   *
   * Why bucket? The raw {@link PermissionMode} union includes
   * `'bypassPermissions'` — surfacing that verbatim in the snapshot would
   * confirm to a prompt-injection attacker that they are running in a mode
   * that skips permission prompts entirely. The model itself does not need
   * the raw token (it already operates under the mode and observes denials
   * in real time); collapsing to `elevated` (any auto-accept / bypass
   * variant) vs `default` (prompt-gated, plan, or anything else) preserves
   * the useful coarse signal without leaking the bypass attestation.
   *
   * Mapping (see `bucketPermissionMode` in `runtime-source.ts`):
   *   - `bypassPermissions`, `acceptEdits`, `dontAsk`, `auto` → `elevated`
   *   - everything else (incl. `default`, `plan`) → `default`
   */
  permissionMode: 'elevated' | 'default';
}

/** Compact summary of one MCP server's contribution to the tool surface. */
export interface McpServerSummary {
  name: string;
  toolCount: number;
}

/**
 * Tool affordances visible to the agent.
 *
 * `enabled` lists the canonical tool names the dispatcher will accept for
 * routing on the NEXT call. It includes MCP tools (prefixed `mcp__`) and any
 * provider-side opt-in tools (`agent`, `skill`, `compose`) when their
 * executors are wired.
 */
export interface RuntimeTools {
  enabled: string[];
  mcpServers: McpServerSummary[];
}

/** Compact identity for an active foreground subagent handle. */
export interface SubagentStatusLite {
  id: string;
  status: SubagentStatusLiteValue;
}

/** Compact identity for a background subagent job. */
export interface BgJobLite {
  jobId: string;
  status: BgJobStatus;
  startedAt: string;
  label: string | null;
}

/** Delegation visibility — who is the current session running? */
export interface RuntimeSubagents {
  active: SubagentStatusLite[];
  backgroundJobs: BgJobLite[];
}

/**
 * Git workspace state captured once at session start (Phase 2).
 *
 * All fields are nullable — the object is returned with every field `null`
 * when the cwd is not a git repo, git is not installed, or any git command
 * exits with a non-zero status. The model can distinguish "not a git repo"
 * (all null) from "a repo with no upstream" (remoteUrl null, others set).
 */
export interface RuntimeWorkspace {
  /** Current branch name; `null` on detached HEAD, error, or non-git cwd. */
  branch: string | null;
  /** Short 7-character HEAD commit SHA; `null` on error or non-git cwd. */
  headSha: string | null;
  /** Whether tracked files have uncommitted changes; `null` on error. */
  dirty: boolean | null;
  /** Count of modified + untracked files shown by `git status --porcelain`; `null` on error. */
  dirtyCount: number | null;
  /** `origin` remote URL; `null` when no remote is configured or on error. */
  remoteUrl: string | null;
}

/** The full runtime snapshot (view='all'). Individual views return subsets. */
export interface RuntimeSnapshot {
  self: RuntimeSelf;
  tools: RuntimeTools;
  subagents: RuntimeSubagents;
  workspace: RuntimeWorkspace;
}

/** Discriminator for `get_runtime_state.input.view`. */
export type RuntimeView = 'self' | 'tools' | 'subagents' | 'workspace' | 'all';

/**
 * Pull-on-demand source for runtime snapshot fields. Each method MUST return
 * a fresh value at call time — the snapshot builder treats these as live
 * accessors, not cached snapshots.
 *
 * Construct via `buildRuntimeStateSource(deps)` in `runtime-source.ts`.
 * Tests can supply hand-rolled object literals.
 */
export interface RuntimeStateSource {
  getSelf(): RuntimeSelf;
  getTools(): RuntimeTools;
  getSubagents(): RuntimeSubagents;
  /** Returns the workspace baseline captured at session start. Always the same object. */
  getWorkspace(): RuntimeWorkspace;
}
