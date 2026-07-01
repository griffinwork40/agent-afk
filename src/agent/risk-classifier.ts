/**
 * Risk classifier — pure function, no I/O, no permissions side-effects.
 *
 * Maps (toolName, toolInput, RiskContext) → RiskLevel. Intended for use by
 * operator-facing UI (status line, permission prompts) and the audit log.
 * Does NOT wire to `permissions.onAsk` — that is Stream C's job.
 *
 * The bash rule table uses substring-matching against the raw command string
 * and is intentionally conservative: we catch the shapes a model naturally
 * emits; we do not attempt to parse shell syntax comprehensively.
 *
 * BUILTIN_WRITE_DENYLIST from `src/agent/tools/handlers/write-denylist.ts`
 * is reused for the write_file / edit_file path-based risk check so the
 * two systems share a single source of truth.
 *
 * @module agent/risk-classifier
 */

import path from 'path';
import { safeRealpath, getWriteDenylist } from './tools/handlers/write-denylist.js';
import { categorizeTool } from './tool-category.js';

/** Three-tier risk level for a tool invocation. */
export type RiskLevel = 'safe' | 'medium' | 'high';

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
}

// ---------------------------------------------------------------------------
// Bash rule tables
// Checked in order; first match wins within each tier.
// The `high` table is checked before `medium`; `safe` patterns shortcut
// before the default-medium fallback.
// ---------------------------------------------------------------------------

/**
 * Bash commands that map to `high` risk.
 * Sources: common destructive/irreversible shell patterns.
 */
const BASH_HIGH: readonly string[] = [
  'rm -rf',
  'rm ',
  'sudo',
  'eval ',
  'chmod',
  'chown',
  'git push --force',
  'git push -f',
  'git reset --hard',
  'mkfs',
  'fdisk',
  'diskutil eraseDisk',
  'dd if=',
  'dd of=',
  '| sh',
  '| bash',
  '|sh',
  '|bash',
];

/**
 * Bash commands that map to `medium` risk.
 * These are reversible-but-notable operations: pushes (without --force),
 * installs, redirects, moves.
 */
const BASH_MEDIUM: readonly string[] = [
  'git push',
  'git reset',
  'git commit',
  'git stash drop',
  'git stash clear',
  'npm install',
  'pnpm install',
  'yarn',
  'pip install',
  'apt ',
  'apt-get ',
  'brew install',
  'tee ',
  ' > ',
  ' >> ',
  'mv ',
  'cp ',
  'mkdir',
  'touch',
  'pnpm build',
  'tsc ',
  'eslint --fix',
];

/**
 * Bash commands that map to `safe`.
 * Read-only operations and test/lint invocations with no side-effects.
 */
const BASH_SAFE: readonly string[] = [
  'pnpm test',
  'vitest',
  'jest',
  'pytest',
  'cargo test',
  'go test',
  'git status',
  'git log',
  'git diff',
  'git show',
  'ls ',
  'cat ',
  'head ',
  'tail ',
  'find ',
  'grep ',
  'echo ',
  'printf ',
];

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

function classifyBash(cmd: string): RiskLevel {
  // External constraint: check HIGH before MEDIUM before SAFE.
  // High patterns override everything; medium patterns override safe.
  // This ordering matters for commands like `echo foo > out.txt` where
  // both `echo ` (safe) and ` > ` (medium) match — the redirect takes
  // precedence because medium is checked first.
  for (const p of BASH_HIGH) {
    if (cmd.includes(p)) return 'high';
  }
  for (const p of BASH_MEDIUM) {
    if (cmd.includes(p)) return 'medium';
  }
  for (const p of BASH_SAFE) {
    if (cmd.includes(p)) return 'safe';
  }
  // Default: medium — unknown bash commands are not safe by assumption.
  return 'medium';
}

function classifyFilePath(filePath: string, ctx: RiskContext): RiskLevel {
  if (!filePath) return 'safe';

  const resolved = safeRealpath(path.resolve(ctx.cwd, filePath));

  // Denylist check — matches ~/.ssh, /etc, etc.
  const denylist = getWriteDenylist();
  for (const blocked of denylist) {
    if (resolved === blocked || resolved.startsWith(blocked + '/')) {
      return 'high';
    }
  }

  // .git/ directory — writes to the git object store are almost always wrong.
  if (resolved.includes('/.git/')) return 'high';

  // Workspace boundary escape.
  if (ctx.workspaceRoot !== undefined) {
    const realRoot = safeRealpath(ctx.workspaceRoot);
    const rel = path.relative(realRoot, resolved);
    if (rel.startsWith('..')) return 'high';
  }

  // node_modules — usually unintentional; not catastrophic.
  if (resolved.includes('/node_modules/')) return 'medium';

  return 'safe';
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
  // Normalise to lowercase for case-insensitive matching against known tools.
  const tool = toolName.toLowerCase();

  // ---- bash ----------------------------------------------------------------
  if (tool === 'bash') {
    const cmd = extractBashCommand(input);
    return classifyBash(cmd);
  }

  // ---- write_file / edit_file ---------------------------------------------
  if (tool === 'write_file' || tool === 'edit_file') {
    const filePath = extractFilePath(input);
    return classifyFilePath(filePath, ctx);
  }

  // ---- read-class tools ---------------------------------------------------
  // Derive from tool-category taxonomy rather than a local hand-maintained list.
  // Previously this was a 5-entry if-chain that diverged from tool-category.ts
  // (notably missing memory_search). Now any tool that categorizeTool returns
  // 'read' for is safe by default; new read tools automatically get the right
  // risk level without a secondary edit here.
  if (categorizeTool(toolName) === 'read') {
    return 'safe';
  }

  // ---- outbound communication --------------------------------------------
  if (tool === 'send_telegram') {
    // Can't be unsent — medium risk.
    return 'medium';
  }

  // ---- MCP tools ----------------------------------------------------------
  // Invariant: any tool whose name begins with `mcp__` is an externally-
  // contributed function from a third-party server (postgres, filesystem,
  // GitHub, etc.). The classifier has NO visibility into what that tool does,
  // so it cannot distinguish a safe MCP read from a destructive mutation
  // (e.g. `mcp__postgres__drop_table`, `mcp__fs__delete`). Failing open here
  // (returning 'safe') would let an unattended run silently execute arbitrary
  // external side-effects — exactly the scenario AFK gate exists to prevent.
  //
  // Policy (conservative default, operator-upgradable):
  //   - Mutation-patterned names (`*delete*`, `*drop*`, `*remove*`, `*write*`,
  //     `*create*`, `*update*`, `*insert*`, `*exec*`, `*run*`, `*send*`,
  //     `*push*`, `*publish*`, `*deploy*`) → 'high': irreversible external
  //     side-effects, gate behind approval.
  //   - All other MCP tools → 'medium': may have network/quota side-effects,
  //     but not obviously destructive. Medium is allowed in AFK (gate only
  //     blocks 'high'), which matches the posture for normal git push / install.
  //
  // Rationale for not defaulting ALL MCP to 'high': the policy guide says
  // "medium ops … are ALLOWED — autonomous work has to be useful." A blanket
  // 'high' on every MCP call would make MCP unusable in AFK, defeating its
  // value for automation-friendly setups. The sub-name filter catches the
  // clearly-dangerous verbs; a future per-server allowlist can refine further.
  if (toolName.startsWith('mcp__') || toolName.startsWith('MCP__')) {
    const subName = toolName.split('__').slice(2).join('__').toLowerCase();
    const DESTRUCTIVE_VERBS = [
      'delete', 'drop', 'remove', 'destroy', 'truncate', 'purge',
      'write', 'create', 'update', 'insert', 'upsert', 'patch',
      'exec', 'execute', 'run', 'eval',
      'send', 'push', 'publish', 'deploy', 'post',
    ];
    for (const verb of DESTRUCTIVE_VERBS) {
      if (subName.includes(verb)) return 'high';
    }
    return 'medium';
  }

  // ---- schedule mutations --------------------------------------------------
  // Invariant: create_schedule and cancel_schedule modify the daemon's cron
  // store (schedules.json) and may immediately affect a running daemon via live
  // sync. These are irreversible in the sense that a wrongly-scheduled task
  // could run before the operator notices — so they are 'high', gated behind
  // explicit approval in AFK mode. list_schedules and get_schedule_history are
  // read-only and fall through to the 'safe' default below.
  if (tool === 'create_schedule' || tool === 'cancel_schedule') {
    return 'high';
  }

  // ---- browser actions -----------------------------------------------------
  // browser_act and browser_open drive a stateful headed browser session and
  // can submit forms, click "Delete", trigger purchases, or navigate to
  // arbitrary URLs — side-effects that survive the session and may be
  // irreversible. They are 'medium' rather than 'high' because they are
  // generally recoverable (navigate away, close the tab) and the AFK posture
  // allows medium ops unattended. browser_screenshot and browser_observe are
  // read-only; browser_close is a cleanup op — all safe.
  if (tool === 'browser_act' || tool === 'browser_open') {
    return 'medium';
  }

  // ---- web_scrape ----------------------------------------------------------
  // web_scrape issues outbound HTTP requests (and optionally headless-browser
  // renders for JS-heavy pages). It may hit rate-limited, metered, or
  // auth-gated endpoints. 'medium' — notable network side-effect but recoverable
  // and broadly necessary for autonomous research work in AFK mode.
  if (tool === 'web_scrape') {
    return 'medium';
  }

  // ---- unknown tool -------------------------------------------------------
  // Don't gate things we haven't classified — default to safe so the
  // classifier never blocks novel tools without an explicit rule.
  return 'safe';
}
