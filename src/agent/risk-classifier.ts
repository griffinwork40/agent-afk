/**
 * Contract: risk classifier — pure function, no I/O, no permissions side-effects.
 *
 * Maps (toolName, toolInput, RiskContext) → RiskLevel. Intended for use by
 * operator-facing UI (status line, permission prompts) and the audit log.
 * Does NOT wire to `permissions.onAsk` — that is Stream C's job.
 *
 * Bash delegates to command-classifier.ts's approval-risk facet. Its legacy
 * substring tables remain intentionally conservative during migration; this
 * adapter preserves tool context (including background-launch risk). See
 * docs/command-classifier-migration.md for the separate mutation/hook axes.
 *
 * BUILTIN_WRITE_DENYLIST from `src/agent/tools/handlers/write-denylist.ts`
 * is reused for the write_file / edit_file path-based risk check so the
 * two systems share a single source of truth.
 *
 * @module agent/risk-classifier
 */

import { categorizeTool } from './tool-category.js';
import { isBackgroundBashLaunch } from './tools/bash-background-flag.js';
import { classifyFilePath, classifyPatchApply } from './risk-classifier.paths.js';
import { analyzeCommand } from './command-classifier.js';

/** Three-tier risk level for a tool invocation. */
export type RiskLevel = 'safe' | 'medium' | 'high';

/**
 * Named category for a gate verdict — the stable, enumerable "why" dimension
 * that the `hook_decision` trace event records alongside the risk level and the
 * concrete `reason` diagnostic. One definition shared by the classifier, the
 * AFK gate, and the trace schema so they can never drift.
 *
 * Categories map to the broad rule family that produced the verdict:
 *   `read-only`          — no side-effects; tool or command is purely observational.
 *   `bash-destructive`   — bash matched a BASH_HIGH pattern (rm, sudo, force-push, …).
 *   `bash-mutating`      — bash matched a BASH_MEDIUM pattern (git push, installs, redirects).
 *   `bash-background`    — a `run_in_background` bash launch raised from safe to medium.
 *   `workspace-write`    — file write inside the workspace (write_file / edit_file / patch_apply).
 *   `credential-path`    — write targets the write-denylist (ssh keys, /etc, …).
 *   `workspace-escape`   — write resolves outside the workspace boundary.
 *   `network-mutation`   — outbound HTTP write (web_request POST/PUT/PATCH/DELETE).
 *   `schedule-mutation`  — daemon schedule create/update/cancel.
 *   `mcp-destructive`    — MCP tool whose sub-name contains a destructive verb.
 *   `mcp-unknown`        — MCP tool with no destructive verb (unknown side-effects).
 *   `worktree-mutation`  — worktree lifecycle (create/keep/release/remove).
 *   `browser-action`     — browser_open / browser_act (stateful browser interaction).
 *   `remote-exec`        — remote_agent (arbitrary code on another machine over SSH).
 *   `outbound-message`   — send_telegram or similar outbound-message tool.
 *   `release-boundary`   — bash command that crosses a publish/deploy boundary (release-boundary-detect hook).
 *   `unknown`            — tool not classified by any rule; defaults to safe.
 */
export const RISK_CATEGORIES = [
  'read-only',
  'bash-destructive',
  'bash-mutating',
  'bash-background',
  'workspace-write',
  'credential-path',
  'workspace-escape',
  'network-mutation',
  'schedule-mutation',
  'mcp-destructive',
  'mcp-unknown',
  'worktree-mutation',
  'browser-action',
  'remote-exec',
  'outbound-message',
  'release-boundary',
  'unknown',
] as const;

/** Type-level mirror of the RISK_CATEGORIES array. */
export type RiskCategory = (typeof RISK_CATEGORIES)[number];

/**
 * Contract: `reason` is a short concrete rule diagnostic, not a stable code.
 * Every `high` verdict has a reason, including path rules (write-denylist,
 * .git, workspace escape), bash patterns, destructive MCP verbs, schedule
 * mutations, forced worktree removal, and web_request DELETE.
 * For `medium`, it is present only for matched bash patterns (also used by
 * wait_for command), a background bash launch raised from safe, or a
 * node_modules write target (including the selected patch_apply verdict).
 * Other `medium` verdicts omit it; all `safe` verdicts omit it.
 * The field remains optional: callers such as the AFK gate must tolerate its
 * absence when building refusal text, rather than assuming every verdict
 * explains its level.
 *
 * `category` is always present and names the broad rule family that produced
 * the verdict. It is stable across patch versions — consumers (trace readers,
 * `afk trace show`) may key on it safely.
 */
export interface RiskVerdict {
  level: RiskLevel;
  reason?: string;
  category: RiskCategory;
}

/**
 * Workspace context required to evaluate path-based risk rules.
 * Both fields can be omitted in tests that only exercise bash rules.
 */
export interface RiskContext {
  /** Current working directory of the session. */
  cwd: string;
  /**
   * Worktree / workspace root. When set, file paths that resolve outside
   * this root are flagged as `high` risk (escaping the workspace boundary).
   */
  workspaceRoot?: string;
  /**
   * The taskId of the currently-running daemon task, supplied by the scheduler.
   * When set, `cancel_schedule` and `update_schedule` (enabled:false only)
   * targeting THIS task id are downgraded from `high` to `medium` — the
   * self-disable carve-out for issue #3464. Every other schedule mutation
   * (other task ids, `create_schedule`, command/cron edits) stays `high`.
   * Never populated outside a daemon task run.
   */
  daemonTaskId?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractBashCommand(input: unknown): string {
  if (typeof input === 'object' && input !== null && 'command' in input) {
    return String((input as Record<string, unknown>)['command'] ?? '');
  }
  if (typeof input === 'string') return input;
  return '';
}

function extractFilePath(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '';
  const obj = input as Record<string, unknown>;
  // write_file uses `file_path`, edit_file uses `file_path`
  if (typeof obj['file_path'] === 'string') return obj['file_path'];
  // Fallback: `path` field used by some tools
  if (typeof obj['path'] === 'string') return obj['path'];
  return '';
}

function classifyBash(cmd: string): RiskVerdict {
  return analyzeCommand(cmd).risk;
}

// ---------------------------------------------------------------------------
// MCP destructive-verb table
// ---------------------------------------------------------------------------

// Invariant: an MCP tool name is `mcp__<server>__<tool>` (3 segments) by the
// bridge convention, but a server MAY expose a 2-segment `mcp__<tool>` name.
// classifyRisk scans EVERY word token after the `mcp__` prefix (server segment
// included) for a destructive verb, matching on `_`/`-` word boundaries — never
// a raw substring. Two failure modes this guards against, both surfaced in the
// review of PR #339:
//   1. UNDER-GATING (the security hole this table exists to close): extracting
//      only the 3rd+ segment (`.slice(2)`) made a 2-segment `mcp__deploy` yield
//      an empty sub-name, so the verb scan never fired and an irreversible op
//      ran unattended at 'medium'. Scanning the full post-prefix suffix
//      (`.slice(1)`) closes this — `mcp__deploy` now matches the `deploy` verb.
//   2. FALSE POSITIVES from substring matching: `.includes('run')` gated
//      `mcp__test__runner` and `.includes('exec')` gated `mcp__server__executor`
//      to 'high'. Token matching on `_`/`-` boundaries keeps `run`/`execute` as
//      whole-word verbs while letting `runner`/`executor` through as 'medium'.
// Token (not substring) matching is REQUIRED once the server segment is scanned:
// the `postgres` server name contains `post` (a verb), so substring matching
// would wrongly gate every `mcp__postgres__*` tool 'high'. The tradeoff is that a
// verb concatenated WITHOUT a separator (`mcp__db__dropall`) is not caught — but
// real MCP tools use snake_case/kebab-case (`drop_all`), so this is a narrow gap.
// Scanning the server segment too can over-gate a benign tool whose SERVER is
// named after a verb (e.g. `mcp__deploy__status` → 'high'). That is deliberate
// safe-side error: over-gating merely asks the operator to approve; under-gating
// runs a destructive op unattended. A future per-server allowlist can refine it.
const DESTRUCTIVE_VERBS: ReadonlySet<string> = new Set([
  // data / storage mutation
  'delete', 'drop', 'remove', 'destroy', 'truncate', 'purge', 'wipe',
  'write', 'create', 'update', 'insert', 'upsert', 'patch', 'rename',
  // execution
  'exec', 'execute', 'run', 'eval',
  // messaging / publishing
  'send', 'push', 'publish', 'deploy', 'post',
  // repo / vcs
  'merge', 'rollback', 'reset',
  // infra lifecycle
  'terminate', 'provision', 'scale', 'disable',
  // financial
  'charge', 'refund',
  // auth / access
  'revoke',
]);

/**
 * Lowercase word tokens of an MCP tool's sub-name (everything after the `mcp__`
 * prefix), split on `_`/`-`/`__` boundaries. The server segment is intentionally
 * included: a 2-segment name has no server, and the verb may live in either
 * position. Empty tokens (from `__` separators or leading/trailing delimiters)
 * are dropped so they never spuriously match a verb. `tool` must already be
 * lowercased by the caller.
 */
function mcpSubNameTokens(tool: string): string[] {
  const suffix = tool.split('__').slice(1).join('__');
  return suffix.split(/[_-]+/).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Schedule-mutation classifier (#3464)
// ---------------------------------------------------------------------------

/**
 * Classify `create_schedule`, `cancel_schedule`, and `update_schedule`.
 *
 * Invariant: all three tools modify the daemon cron store (schedules.json)
 * and may immediately affect a running daemon via live sync — they are `high`
 * by default. The one exception is the self-disable carve-out (issue #3464):
 * a daemon task disabling ONLY its own schedule is a routine one-shot cleanup
 * step, not an attack on other tasks, and is downgraded to `medium` when:
 *   1. `ctx.daemonTaskId` is set (injected by the scheduler — never from
 *      model-supplied input, so it cannot be spoofed by the agent).
 *   2. The input `taskId` matches the running task's own id exactly.
 *   3. For `cancel_schedule`: `permanent` is not `true` (permanent delete
 *      removes the task from the store and is irreversible → stays `high`).
 *   4. For `update_schedule`: the ONLY supplied field besides `taskId` is
 *      `enabled: false` (no command, cron, name, or other edits).
 * `create_schedule` is always `high` — it adds new tasks, not removes self.
 */
function classifyScheduleMutation(tool: string, input: unknown, ctx: RiskContext): RiskLevel {
  if (tool === 'create_schedule') return 'high';

  const inputObj =
    typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  const inputTaskId = typeof inputObj['taskId'] === 'string' ? inputObj['taskId'] : undefined;

  // Self-disable carve-out: own task id, scheduler-supplied (trusted) context.
  if (
    ctx.daemonTaskId !== undefined &&
    inputTaskId !== undefined &&
    inputTaskId === ctx.daemonTaskId
  ) {
    if (tool === 'cancel_schedule') {
      // Permanent delete stays high — only plain disable is carved out.
      if (inputObj['permanent'] === true) return 'high';
      // Re-enabling own schedule is a mutation, not a disable — keep it high.
      if (inputObj['enable'] === true) return 'high';
      return 'medium';
    }
    // update_schedule: only allowed when the sole change is enabled:false.
    // Any other field (command, cron, name, …) keeps it high.
    const { taskId: _tid, enabled, ...rest } = inputObj;
    const hasOtherFields = Object.keys(rest).length > 0;
    // Invariant: strict false fails closed for non-boolean values (e.g. "false", 0).
    if (enabled === false && !hasOtherFields) return 'medium';
  }

  return 'high';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify the risk level of a tool invocation.
 *
 * @param toolName  - The tool being invoked (e.g. `'bash'`, `'write_file'`).
 * @param input     - The raw tool input as decoded JSON (unknown shape).
 * @param ctx       - Workspace context for path-based rules.
 * @returns `'safe'` | `'medium'` | `'high'`
 */
export function classifyRisk(
  toolName: string,
  input: unknown,
  ctx: RiskContext,
): RiskLevel {
  return classifyRiskDetailed(toolName, input, ctx).level;
}

/**
 * Like {@link classifyRisk}, but also returns a short concrete `reason` naming
 * the rule that fired (always set for `'high'`). The AFK gate surfaces the
 * reason in its refusal so a blocked agent knows exactly what to change.
 */
export function classifyRiskDetailed(
  toolName: string,
  input: unknown,
  ctx: RiskContext,
): RiskVerdict {
  // Normalise to lowercase for case-insensitive matching against known tools.
  const tool = toolName.toLowerCase();

  // ---- bash ----------------------------------------------------------------
  if (tool === 'bash') {
    const verdict = classifyBash(extractBashCommand(input));
    // Background floor: a `run_in_background` launch can run for up to 24 h,
    // so a "safe" substring match (e.g. `cat ` or `pnpm test` anywhere in the
    // string) must never auto-approve it.
    return isBackgroundBashLaunch(tool, input) && verdict.level === 'safe'
      ? { level: 'medium', reason: 'bash-background', category: 'bash-background' }
      : verdict;
  }

  // ---- write_file / edit_file ---------------------------------------------
  if (tool === 'write_file' || tool === 'edit_file') {
    return classifyFilePath(extractFilePath(input), ctx);
  }

  // ---- patch_apply ---------------------------------------------------------
  // patch_apply atomically writes multiple files; classify by the highest-risk
  // path across the entire changes array. An empty changes array is safe.
  if (tool === 'patch_apply') return classifyPatchApply(input, ctx);

  // ---- read-class tools ---------------------------------------------------
  // Derive from tool-category taxonomy rather than a local hand-maintained list.
  // Previously this was a 5-entry if-chain that diverged from tool-category.ts
  // (notably missing memory_search). Now any tool that categorizeTool returns
  // 'read' for is safe by default; new read tools automatically get the right
  // risk level without a secondary edit here.
  if (categorizeTool(toolName) === 'read') return { level: 'safe', category: 'read-only' };

  // ---- outbound communication --------------------------------------------
  if (tool === 'send_telegram') {
    // Can't be unsent — medium risk.
    return { level: 'medium', category: 'outbound-message' };
  }
  // remote_agent executes arbitrary code on another machine over SSH. The
  // remote afk process runs in headless/bypassPermissions mode by default
  // (no --permission-mode flag is injected by the launcher), so a destructive
  // prompt could bypass the local AFK gate by routing through the remote.
  // High risk ensures autonomous mode (AFK gate) holds this tool for approval.
  if (tool === 'remote_agent') return { level: 'high', reason: 'remote-exec', category: 'remote-exec' };
  // `agent` with `host` set has the same risk profile as `remote_agent` — the
  // underlying SSH transport is identical. The schema description promises this
  // classification; the AFK gate must hold it for approval in autonomous mode.
  if (tool === 'agent' && typeof input === 'object' && input !== null && 'host' in input && (input as Record<string, unknown>)['host'] !== undefined) {
    return { level: 'high', reason: 'remote-exec', category: 'remote-exec' };
  }

  // ---- MCP tools ----------------------------------------------------------
  // Any `mcp__*` tool is an externally-contributed function from a third-party
  // server (postgres, filesystem, GitHub, …). The classifier has NO visibility
  // into what it does, so it cannot tell a safe MCP read from a destructive
  // mutation (`mcp__postgres__drop_table`, `mcp__fs__delete`). Failing open
  // (returning 'safe') would let an unattended run silently execute arbitrary
  // external side-effects — exactly what the AFK gate exists to prevent.
  //
  // Policy (conservative default, operator-upgradable): a destructive verb in
  // any post-prefix token → 'high' (gated behind approval); all other MCP tools
  // → 'medium' (may have network/quota side-effects but not obviously
  // destructive, and medium is allowed in AFK so autonomous research stays
  // useful). See DESTRUCTIVE_VERBS / mcpSubNameTokens above for the exact scan
  // rule and why it covers 2-segment names and matches on word boundaries.
  //
  // Prefix test uses the already-lowercased `tool` so mixed-case `Mcp__…` names
  // are classified too, not silently dropped to the 'safe' default below.
  if (tool.startsWith('mcp__')) {
    const verb = mcpSubNameTokens(tool).find((t) => DESTRUCTIVE_VERBS.has(t));
    if (verb !== undefined) return { level: 'high', reason: `mcp-destructive-verb: ${verb}`, category: 'mcp-destructive' };
    return { level: 'medium', category: 'mcp-unknown' };
  }

  // ---- schedule mutations --------------------------------------------------
  // See classifyScheduleMutation for the full rule set and self-disable carve-out.
  if (tool === 'create_schedule' || tool === 'cancel_schedule' || tool === 'update_schedule') {
    const level = classifyScheduleMutation(tool, input, ctx);
    return level === 'high'
      ? { level, reason: `schedule-mutation: ${tool}`, category: 'schedule-mutation' }
      : { level, category: 'schedule-mutation' };
  }

  // ---- worktree lifecycle --------------------------------------------------
  // Invariant: the `worktree` tool mutates git worktree state under
  // .afk-worktrees/. `remove` with `force: true` is the only irreversible
  // action — it discards uncommitted working-tree changes and commits-ahead
  // trees that the non-forced path refuses (the branch ref always survives, but
  // working-tree edits do not), so it is 'high' and gated behind approval.
  // `list` is a dry-run sweep report (read-only) → 'safe'. Every other action
  // (create/keep/release, and non-forced remove — which refuses dirty, locked,
  // and commits-ahead trees) is reversible → 'medium', allowed unattended like
  // other afk-managed writes. Without this branch the tool fell through to the
  // 'safe' default below, so `remove --force` ran unattended with no approval.
  if (tool === 'worktree') {
    const obj =
      typeof input === 'object' && input !== null
        ? (input as Record<string, unknown>)
        : {};
    const action = typeof obj['action'] === 'string' ? obj['action'] : '';
    if (action === 'list') return { level: 'safe', category: 'read-only' };
    if (action === 'remove' && obj['force'] === true) {
      return { level: 'high', reason: 'worktree-force-remove', category: 'worktree-mutation' };
    }
    return { level: 'medium', category: 'worktree-mutation' };
  }

  // ---- browser actions -----------------------------------------------------
  // browser_act and browser_open drive a stateful headed browser session and
  // can submit forms, click "Delete", trigger purchases, or navigate to
  // arbitrary URLs — side-effects that survive the session and may be
  // irreversible. They are 'medium' rather than 'high' because they are
  // generally recoverable (navigate away, close the tab) and the AFK posture
  // allows medium ops unattended. browser_screenshot and browser_observe are
  // read-only; browser_close is a cleanup op — all safe.
  if (tool === 'browser_act' || tool === 'browser_open') return { level: 'medium', category: 'browser-action' };
  if (tool === 'browser_observe' || tool === 'browser_screenshot' || tool === 'browser_close') {
    return { level: 'safe', category: 'read-only' };
  }

  // ---- web_scrape ----------------------------------------------------------
  // web_scrape issues outbound HTTP requests (and optionally headless-browser
  // renders for JS-heavy pages). It may hit rate-limited, metered, or
  // auth-gated endpoints. 'medium' — notable network side-effect but recoverable
  // and broadly necessary for autonomous research work in AFK mode.
  if (tool === 'web_scrape') return { level: 'medium', category: 'network-mutation' };

  // ---- web_request ---------------------------------------------------------
  // web_request supports all HTTP methods, so risk is method-dependent:
  //   GET / HEAD / OPTIONS → 'safe' (read-only; web-request.ts uses 'low' in its own
  //                          MethodRisk vocabulary — 'safe' is the RiskLevel equivalent)
  //   POST / PUT / PATCH   → 'medium' (mutation, but generally recoverable)
  //   DELETE               → 'high' (irreversible destructive mutation)
  //
  // The method is extracted from the raw input and mapped per the tool spec.
  // An unknown or absent method falls through to 'medium' (conservative).
  if (tool === 'web_request') {
    const obj =
      typeof input === 'object' && input !== null
        ? (input as Record<string, unknown>)
        : {};
    const rawMethod = typeof obj['method'] === 'string' ? obj['method'].toUpperCase() : '';
    if (rawMethod === 'DELETE') return { level: 'high', reason: 'web-request: DELETE', category: 'network-mutation' };
    if (rawMethod === 'GET' || rawMethod === 'HEAD' || rawMethod === 'OPTIONS') return { level: 'safe', category: 'read-only' };
    return { level: 'medium', category: 'network-mutation' };
  }

  // ---- wait_for ------------------------------------------------------------
  // wait_for condition types differ significantly in risk:
  //
  //   url     — issues outbound HTTP; same risk profile as web_scrape ('medium').
  //   file    — read-only fs.stat / readFile; 'safe'.
  //   process — read-only process.kill(pid, 0); 'safe'.
  //   command — runs a shell command via execSync. The command string is
  //             classified using the same bash rule table (classifyBash) as the
  //             bash tool, but that logic lives inside evaluateCommand so we
  //             cannot call it here without the command string. We therefore
  //             use the bash classifier directly when the type is 'command'.
  //             For other types fall through to the type-specific rules above.
  //
  // A missing or unknown `type` field is treated conservatively as 'medium'.
  if (tool === 'wait_for') {
    const obj =
      typeof input === 'object' && input !== null
        ? (input as Record<string, unknown>)
        : {};
    const condType = typeof obj['type'] === 'string' ? obj['type'] : '';
    if (condType === 'command') {
      const cmd =
        typeof obj['command'] === 'string' ? obj['command'] : '';
      return classifyBash(cmd);
    }
    if (condType === 'file' || condType === 'process') return { level: 'safe', category: 'read-only' };
    // url or unknown: treat as medium (outbound network).
    return { level: 'medium', category: 'network-mutation' };
  }

  // ---- unknown tool -------------------------------------------------------
  // Don't gate things we haven't classified — default to safe so the
  // classifier never blocks novel tools without an explicit rule.
  return { level: 'safe', category: 'unknown' };
}
