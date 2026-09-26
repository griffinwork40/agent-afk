/**
 * Builds the child-process environment for a what-if episode subprocess.
 *
 * Contract: credentials (ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, etc.)
 * are inherited from the parent process via process.env — they are never
 * written to disk, logged, or included in the returned record beyond what
 * the parent already has. Telegram and MCP vars are removed so the child
 * cannot send notifications or talk to untrusted MCP servers.
 *
 * @module whatif/runner/child-env
 */

import type { Environment } from '../types.js';

// ---------------------------------------------------------------------------
// Vars to delete from the child env (security / isolation)
// ---------------------------------------------------------------------------

/** Keys removed unconditionally regardless of parent value. */
const VARS_TO_DELETE: readonly string[] = [
  'AFK_ALLOW_PROJECT_MCP',
  'AFK_DUMP_PROMPT',
  'TELEGRAM_BOT_TOKEN',
  'AFK_TELEGRAM_BOT_TOKEN',
  'AFK_TELEGRAM_ALLOWED_CHAT_IDS',
  'AFK_TELEGRAM_TAG_ONLY_CHAT_IDS',
  'AFK_TELEGRAM_PRIMARY_CHAT_ID',
  'AFK_TELEGRAM_NOTIFY_MODE',
  'TELEGRAM_DATA_DIR',
  'TELEGRAM_VERBOSE',
  'AFK_TELEGRAM_TRACE',
  'AFK_TELEGRAM_CWD',
  'AFK_TELEGRAM_SESSION_IDLE_MS',
];

/**
 * Build the child-process env for a what-if episode.
 *
 * Start from the parent's process.env (inherits credentials like
 * ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN; never write them anywhere),
 * apply sandbox overrides, remove sensitive/side-effecting vars, then apply
 * `env.launch.env` and `extra` in that order.
 *
 * `extra` wins over everything else — callers use it to inject
 * ANTHROPIC_BASE_URL for the snapshot path.
 */
export function buildChildEnv(
  env: Environment,
  extra: Record<string, string>,
): Record<string, string> {
  // Inherit the parent env. Never log or persist this object.
  // Cast away undefined values — spawn accepts Record<string, string | undefined>
  // but we model it as string for cleaner downstream code; delete removes undefineds.
  const rawEnv = process.env; // audit-env-access: allow child-process env forwarding for what-if episodes
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawEnv)) {
    if (v !== undefined) result[k] = v;
  }

  // Apply sandbox overrides so the child sees its own isolated home tree.
  result['AFK_HOME'] = env.home;
  result['AFK_STATE_DIR'] = `${env.home}/state`;
  result['AFK_FRAMEWORK_DIR'] = `${env.home}/agent-framework`;

  // Episode mode: read-only tools execute; side-effecting tools are recorded.
  result['AFK_WHATIF_EPISODE'] = '1';

  // Prevent nested delegation inside an episode — depth 0 means "top-level
  // only; no subagent spawning allowed".
  result['AFK_MAX_NESTING_DEPTH'] = '0';

  // Disable the run receipt to avoid cluttering the sandbox state directory.
  result['AFK_RUN_RECEIPT_DISABLED'] = '1';

  // Leave AFK_SESSION_LEDGER_DISABLED unset (we may read the ledger after the
  // episode — the gate itself relies on ledger data).
  delete result['AFK_SESSION_LEDGER_DISABLED'];

  // Remove all vars that could cause side effects outside the sandbox.
  for (const key of VARS_TO_DELETE) {
    delete result[key];
  }

  // Drop inherited keys the child must re-read from its sandbox afk.env copy.
  for (const key of env.launch.unset ?? []) {
    delete result[key];
  }

  // Apply launch-level overrides from the sandbox spec (model, effort, etc.).
  // Keys on the security delete list are skipped so launch.env can never
  // re-add them.
  const denied = new Set(VARS_TO_DELETE);
  for (const [k, v] of Object.entries(env.launch.env)) {
    if (!denied.has(k)) result[k] = v;
  }

  // Apply caller-supplied extras last — they win over everything else.
  for (const [k, v] of Object.entries(extra)) {
    result[k] = v;
  }

  return result;
}
