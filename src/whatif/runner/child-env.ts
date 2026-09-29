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
import { SANDBOX_OWNED_KEYS } from '../sandbox.home.js';

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
  // Sandbox-owned keys (SANDBOX_OWNED_KEYS) are intentionally NOT in
  // launch.unset (sandboxedAfkEnvKeys already excludes them), so this loop
  // never touches them — but even if a stale path somehow added them, the
  // sandbox-path writes below would overwrite them anyway.
  for (const key of env.launch.unset ?? []) {
    delete result[key];
  }

  // Apply launch-level overrides from the sandbox spec (model, effort, etc.).
  // Keys on the security delete list are skipped so launch.env can never
  // re-add them.
  // Sandbox-owned keys are also skipped here — they are applied unconditionally
  // below to guarantee the child always sees the sandbox paths.
  const denied = new Set(VARS_TO_DELETE);
  for (const [k, v] of Object.entries(env.launch.env)) {
    if (!denied.has(k) && !SANDBOX_OWNED_KEYS.has(k)) result[k] = v;
  }

  // Build the set of keys that launch.unset explicitly removed so that extra
  // cannot silently reverse an explicit unset.
  const unsetKeys = new Set(env.launch.unset ?? []);

  // Apply caller-supplied extras — filtered through the same deny list so
  // a caller cannot re-introduce a Telegram or MCP side-effecting var, and
  // skipping any key that launch.unset explicitly removed.
  // Sandbox-owned keys are also blocked here; their values are applied below.
  // Note: credential keys (ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, etc.)
  // are deliberately NOT in the deny list here — the child is a full `afk chat`
  // invocation that needs them to talk to the model; they arrive via the
  // process.env inheritance at the top of this function, not through `extra`.
  for (const [k, v] of Object.entries(extra)) {
    if (!denied.has(k) && !unsetKeys.has(k) && !SANDBOX_OWNED_KEYS.has(k)) result[k] = v;
  }

  // Apply sandbox-owned path overrides LAST so they cannot be removed or
  // overridden by the launch.unset loop, launch.env, or extra above.
  // This is the authoritative fix for the AFK_FRAMEWORK_DIR isolation breach:
  // previously these were set before the unset loop and could be deleted.
  result['AFK_HOME'] = env.home;
  result['AFK_STATE_DIR'] = `${env.home}/state`;
  result['AFK_FRAMEWORK_DIR'] = `${env.home}/agent-framework`;

  return result;
}
