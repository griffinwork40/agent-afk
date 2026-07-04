/**
 * Sensitivity-tiered allowlist + validators for self-service config mutation.
 *
 * This module is the single source of truth for *what* the config-mutation
 * engine (`src/config/mutate.ts`), the `afk config` CLI, and the `config_set`
 * agent tool are permitted to change, and how each value is validated/coerced.
 *
 * Three tiers (see plan `.afk/plans/agent-config-self-editing.md`):
 *   - agent  — non-secret behavioural knobs the agent may set autonomously.
 *   - human  — secrets + identity/prompt/hooks; CLI-only, behind an explicit
 *              opt-in gate, never settable by the agent tool.
 *   - (none) — inherited/process env vars + unknown keys are never written.
 *
 * Validators here intentionally do NOT reuse the loader's inline guards in
 * `src/cli/config.ts` — that logic is entangled with model-slot parsing and
 * git-flag-injection guards and is not cleanly extractable. The engine only
 * ever mutates ONE key at a time, so a focused per-key validator is both
 * sufficient and lower-risk than refactoring the central loader.
 *
 * @module config/settable-keys
 */

import { getEnvVarMeta, type EnvVarMeta } from './env.js';
import { coerceSlotBindingInput, type ModelSlotBinding } from '../agent/session/model-slots.js';

// ── Env-var classification ───────────────────────────────────────────────────

/**
 * Env vars that are process-inherited or runtime-derived, NOT afk configuration.
 * Writing these into afk.env would be meaningless or actively harmful (e.g.
 * pinning PATH/HOME), so the mutation tooling refuses them for every caller.
 */
export const INHERITED_ENV_KEYS: ReadonlySet<string> = new Set([
  'HOME',
  'PATH',
  'SHELL',
  'PAGER',
  'NODE_ENV',
  'CI',
  'VITEST',
  'DEBUG',
  'FORCE_COLOR',
  'NO_COLOR',
  'AGENT_SURFACE',
  'AFK_SESSION_ID',
  'NO_UPDATE_NOTIFIER',
  'SCRIPT',
  'ASCIINEMA_REC',
]);

/**
 * Non-secret env vars that nonetheless control identity, safety, capability,
 * autonomous-run behaviour, request routing, or where the agent's own state
 * lives. They are NOT credentials (the `secret` tier doesn't cover them), but
 * the agent must not set them on its own config: they are the env twins of the
 * human-tier afk.config.json keys (`systemPrompt`, `daemon.*`,
 * `telegram.notify.*`, `interactive.worktree*`) plus endpoint, state-location,
 * and tier-gate controls. The `afk config` CLI (human surface) opts past this
 * gate; the `config_set` agent tool never does. Mirrors the `human` config tier.
 *
 * Every `*_BASE_URL` is additionally protected by a suffix rule in
 * `classifyEnvKey`: an endpoint redirect carries the paired (separately-secret)
 * API key and the full conversation to wherever it points.
 */
export const PROTECTED_ENV_KEYS: ReadonlySet<string> = new Set([
  // Endpoint redirection (also matched by the *_BASE_URL suffix rule).
  'AFK_MODEL_SMALL_BASE_URL',
  'AFK_MODEL_MEDIUM_BASE_URL',
  'AFK_MODEL_LARGE_BASE_URL',
  'AFK_LOCAL_BASE_URL',
  'AFK_OPENAI_BASE_URL',
  // Identity / system-prompt overlay (highest-priority; env twin of human-tier `systemPrompt`).
  'AFK_SYSTEM_PROMPT',
  // Autonomous-run control — env twins of human-tier `daemon.*` config keys.
  'AFK_DAEMON_TASK',
  'AFK_DAEMON_TASK_ID',
  'AFK_DAEMON_CWD',
  'AFK_DAEMON_HOST',
  // Browser navigation guardrail + alternate-config path.
  'AFK_BROWSER_ALLOWED_DOMAINS',
  'AFK_BROWSER_BLOCKED_DOMAINS',
  'AFK_BROWSER_CONFIG',
  // Capability / tier gates the agent must not flip on itself.
  'AFK_ALLOW_PROJECT_MCP',
  'AFK_INTERNAL',
  // Worktree git-ref fields — env twins of human-tier `interactive.worktree*` (git-flag sensitive).
  'AFK_WORKTREE_BASE',
  'AFK_WORKTREE_BRANCH_PREFIX',
  // Telegram routing + allowlist — who may drive the bot, where notifications go
  // (env twins of human-tier `telegram.notify.*`).
  'AFK_TELEGRAM_ALLOWED_CHAT_IDS',
  'AFK_TELEGRAM_NOTIFY_MODE',
  'AFK_TELEGRAM_PRIMARY_CHAT_ID',
  // State / credential-tree relocation — where AFK's own config, state, memory,
  // or Telegram auth is read from and written to.
  'AFK_HOME',
  'AFK_STATE_DIR',
  'AFK_FRAMEWORK_DIR',
  'TELEGRAM_DATA_DIR',
  'AFK_TELEGRAM_CWD',
]);

export type EnvKeyClass = 'settable' | 'secret' | 'protected' | 'non-config' | 'unknown';

/**
 * Classify an env-var name for mutation purposes.
 *   - unknown    — not in ENV_REGISTRY (typo / not a real afk var)
 *   - non-config — inherited/process var (PATH, HOME, …)
 *   - secret     — credential-bearing (`secret: true`); human-gated
 *   - protected  — non-secret control (prompt/daemon/browser/endpoint/state/
 *                  tier gate); human-gated, agent refused (PROTECTED_ENV_KEYS)
 *   - settable   — non-secret behavioural knob; agent may set
 */
export function classifyEnvKey(name: string): EnvKeyClass {
  const meta = getEnvVarMeta(name);
  if (!meta) return 'unknown';
  if (INHERITED_ENV_KEYS.has(name)) return 'non-config';
  if (meta.secret) return 'secret';
  // Endpoint redirects are categorically credential/data-exfiltration vectors,
  // so every `*_BASE_URL` is protected even if a new one is added later.
  if (PROTECTED_ENV_KEYS.has(name) || name.endsWith('_BASE_URL')) return 'protected';
  return 'settable';
}

export type CoerceResult = { ok: true; value: string } | { ok: false; error: string };

/**
 * Validate + normalise a raw string value for an env var against its declared
 * registry type. afk.env stores everything as strings, so the returned `value`
 * is always a string — but we reject values that cannot be the declared type
 * (e.g. `abc` for a `number` var) before they are persisted.
 */
export function coerceEnvValue(meta: EnvVarMeta, raw: string): CoerceResult {
  if (raw.includes('\n')) {
    return { ok: false, error: `value for ${meta.name} must not contain newlines` };
  }
  switch (meta.type) {
    case 'number': {
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        return { ok: false, error: `${meta.name} expects a number, got ${JSON.stringify(raw)}` };
      }
      return { ok: true, value: raw.trim() };
    }
    case 'boolean': {
      const v = raw.trim().toLowerCase();
      if (!['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'].includes(v)) {
        return {
          ok: false,
          error: `${meta.name} expects a boolean (true/false/1/0/yes/no/on/off), got ${JSON.stringify(raw)}`,
        };
      }
      return { ok: true, value: v };
    }
    case 'json': {
      try {
        JSON.parse(raw);
      } catch {
        return { ok: false, error: `${meta.name} expects valid JSON` };
      }
      return { ok: true, value: raw };
    }
    case 'string':
    default:
      return { ok: true, value: raw };
  }
}

// ── Config-key (afk.config.json) classification + validation ──────────────────

export type ConfigKeyTier = 'agent' | 'human';
export type ConfigKeyType = 'string' | 'number' | 'boolean' | 'enum' | 'number-array' | 'model-slot';

export interface ConfigKeySpec {
  /** Dotted path, e.g. `models.large` or `telegram.notify.mode`. */
  readonly path: string;
  readonly tier: ConfigKeyTier;
  readonly type: ConfigKeyType;
  readonly enumValues?: readonly string[];
  /** For numeric keys: clamp the accepted range (and require integer). */
  readonly clamp?: { readonly min: number; readonly max: number; readonly integer?: boolean };
  readonly description: string;
}

/**
 * Every config key this tooling may touch. Anything not listed is rejected as
 * `unknown` — defence against typo'd or unsupported paths silently writing junk.
 *
 * Deliberately NOT agent-settable (human tier): `systemPrompt` (the agent
 * rewriting its own prompt is recursive-risk), `hooks` (could disable safety
 * hooks), `importFrom` (a trust grant), `daemon.*` (controls autonomous runs),
 * the worktree git-ref fields (CLI-flag-injection sensitive), `telegram.notify.*`
 * (redirecting outbound notifications is an exfiltration vector), `updatePolicy`
 * (auto self-update is autonomous-code scope-widening), and `permissionMode`
 * (the agent flipping itself to bypassPermissions is privilege escalation).
 */
export const CONFIG_KEY_SPECS: readonly ConfigKeySpec[] = [
  { path: 'model', tier: 'agent', type: 'string', description: 'Default model id / alias.' },
  { path: 'models.local', tier: 'agent', type: 'model-slot', description: 'Local-tier model id (OpenAI-compatible shim: Ollama, LM Studio, vLLM, MLX). Accepts a bare id string or a { id, provider, baseUrl } object.' },
  { path: 'models.small', tier: 'agent', type: 'model-slot', description: 'Small-tier model id. Accepts a bare id string or a { id, provider, baseUrl } object.' },
  { path: 'models.medium', tier: 'agent', type: 'model-slot', description: 'Medium-tier model id. Accepts a bare id string or a { id, provider, baseUrl } object.' },
  { path: 'models.large', tier: 'agent', type: 'model-slot', description: 'Large-tier model id. Accepts a bare id string or a { id, provider, baseUrl } object.' },
  { path: 'maxTokens', tier: 'agent', type: 'number', clamp: { min: 1, max: 1_000_000, integer: true }, description: 'Max tokens per turn.' },
  { path: 'temperature', tier: 'agent', type: 'number', clamp: { min: 0, max: 2 }, description: 'Sampling temperature.' },
  { path: 'autoRouting.interactive', tier: 'agent', type: 'boolean', description: 'Auto-route model in the REPL.' },
  { path: 'autoRouting.chat', tier: 'agent', type: 'boolean', description: 'Auto-route model for chat.' },
  { path: 'autoRouting.telegram', tier: 'agent', type: 'boolean', description: 'Auto-route model for Telegram.' },
  { path: 'autoRouting.daemon', tier: 'agent', type: 'boolean', description: 'Auto-route model for the daemon.' },
  { path: 'telegram.notify.mode', tier: 'human', type: 'enum', enumValues: ['primary', 'broadcast', 'custom'], description: 'Telegram notify routing mode (human-tier: notification-redirect vector).' },
  { path: 'telegram.notify.primaryChatId', tier: 'human', type: 'number', clamp: { min: -1e15, max: 1e15, integer: true }, description: 'Primary Telegram chat id (human-tier: notification-redirect vector).' },
  { path: 'telegram.notify.targets', tier: 'human', type: 'number-array', description: 'Custom Telegram target chat ids (human-tier: notification-redirect vector).' },
  { path: 'telegram.verifyDone', tier: 'human', type: 'boolean', description: 'Opt-in AFK "Done" verification gate (human-tier: a self-honesty check on the agent\'s own completion reporting — the agent must not be able to disable it on its own config, same rationale as enableShellHooks/permissionMode).' },
  { path: 'interactive.worktreeAutoname', tier: 'agent', type: 'boolean', description: 'Auto-name worktrees.' },
  { path: 'interactive.suggestGhost', tier: 'agent', type: 'boolean', description: 'Ghost-text suggestions in the REPL.' },
  { path: 'updatePolicy', tier: 'human', type: 'enum', enumValues: ['notify', 'auto', 'off'], description: 'Self-update policy (human-tier: auto self-update is scope-widening).' },
  { path: 'autoResumeOnUsageLimit', tier: 'agent', type: 'boolean', description: 'Auto-resume after a usage-limit pause.' },
  { path: 'bgSummaries', tier: 'agent', type: 'boolean', description: 'Background summarisation.' },
  { path: 'maxSummaryCallsPerSession', tier: 'agent', type: 'number', clamp: { min: 1, max: 500, integer: true }, description: 'Cap on summary calls per session.' },

  // Human-only (CLI with --allow gate; agent tool refuses).
  { path: 'systemPrompt', tier: 'human', type: 'string', description: 'Operator system-prompt overlay.' },
  // Session permission mode. Default for new installs (when unset) is
  // bypassPermissions — path containment + the approval prompt OFF. Human-tier:
  // the agent must NOT be able to escalate its own permissions (set bypass) via
  // config_set; only the human CLI (`afk config set permissionMode <mode>`) can.
  { path: 'permissionMode', tier: 'human', type: 'enum', enumValues: ['default', 'plan', 'autonomous', 'bypassPermissions'], description: 'Session permission mode for afk chat/interactive (human-tier: privilege-escalation vector). Unset → bypassPermissions (new-install default); set `default` to re-enable path containment + the approval prompt.' },
  // enableShellHooks is the TRUST GATE that activates shell hooks at load time
  // (config-loader userGlobalEnabled). Even though the agent cannot define `hooks`,
  // it must not be able to flip the activation gate on its own config — human-only.
  { path: 'enableShellHooks', tier: 'human', type: 'boolean', description: 'Enable shell hooks (trust gate).' },
  { path: 'interactive.worktreeBranchPrefix', tier: 'human', type: 'string', description: 'Worktree branch prefix (git-flag sensitive).' },
  { path: 'interactive.worktreeBase', tier: 'human', type: 'string', description: 'Worktree base ref (git-flag sensitive).' },
  { path: 'daemon.task', tier: 'human', type: 'string', description: 'Daemon task prompt.' },
  { path: 'daemon.taskId', tier: 'human', type: 'string', description: 'Daemon task id.' },
];

const CONFIG_KEY_BY_PATH = new Map(CONFIG_KEY_SPECS.map((s) => [s.path, s]));

export function getConfigKeySpec(path: string): ConfigKeySpec | undefined {
  return CONFIG_KEY_BY_PATH.get(path);
}

export type ConfigKeyClass = 'agent' | 'human' | 'unknown';

export function classifyConfigKey(path: string): ConfigKeyClass {
  const spec = CONFIG_KEY_BY_PATH.get(path);
  return spec ? spec.tier : 'unknown';
}

export type ConfigCoerceResult =
  | { ok: true; value: string | number | boolean | number[] | ModelSlotBinding }
  | { ok: false; error: string };

/**
 * Validate + coerce a value for a config key. Accepts either an already-typed
 * value (from the agent tool's JSON schema) or a raw string (from the CLI),
 * and returns the canonical typed value to store in afk.config.json.
 */
export function coerceConfigValue(spec: ConfigKeySpec, raw: unknown): ConfigCoerceResult {
  switch (spec.type) {
    case 'boolean': {
      if (typeof raw === 'boolean') return { ok: true, value: raw };
      if (typeof raw === 'string') {
        const v = raw.trim().toLowerCase();
        if (['true', '1', 'yes', 'on'].includes(v)) return { ok: true, value: true };
        if (['false', '0', 'no', 'off'].includes(v)) return { ok: true, value: false };
      }
      return { ok: false, error: `${spec.path} expects a boolean` };
    }
    case 'number': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
      if (!Number.isFinite(n)) return { ok: false, error: `${spec.path} expects a number` };
      if (spec.clamp) {
        if (spec.clamp.integer && !Number.isInteger(n)) {
          return { ok: false, error: `${spec.path} expects an integer` };
        }
        const clamped = Math.min(spec.clamp.max, Math.max(spec.clamp.min, n));
        return { ok: true, value: clamped };
      }
      return { ok: true, value: n };
    }
    case 'enum': {
      if (typeof raw === 'string' && spec.enumValues?.includes(raw)) {
        return { ok: true, value: raw };
      }
      return { ok: false, error: `${spec.path} expects one of: ${spec.enumValues?.join(', ')}` };
    }
    case 'number-array': {
      let arr: unknown[];
      if (Array.isArray(raw)) arr = raw;
      else if (typeof raw === 'string') {
        arr = raw
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
          .map((s) => Number(s));
      } else {
        return { ok: false, error: `${spec.path} expects an array of numbers` };
      }
      const nums: number[] = [];
      for (const el of arr) {
        const n = typeof el === 'number' ? el : Number(el);
        if (!Number.isFinite(n)) return { ok: false, error: `${spec.path} contains a non-number` };
        nums.push(n);
      }
      return { ok: true, value: nums };
    }
    case 'model-slot': {
      if (typeof raw === 'string') {
        if (raw.trim().length === 0) return { ok: false, error: `${spec.path} must not be empty` };
        return { ok: true, value: raw.trim() };
      }
      const res = coerceSlotBindingInput(raw);
      if (!res.ok) return { ok: false, error: `${spec.path}: ${res.error}` };
      return { ok: true, value: res.value };
    }
    case 'string':
    default: {
      if (typeof raw !== 'string') return { ok: false, error: `${spec.path} expects a string` };
      if (raw.trim().length === 0) return { ok: false, error: `${spec.path} must not be empty` };
      return { ok: true, value: raw };
    }
  }
}

// ── Dotted-path object helpers ────────────────────────────────────────────────

type Json = Record<string, unknown>;

/** Read a value at a dotted path; returns undefined if any segment is missing. */
export function getAtPath(obj: Json, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Json)[seg];
  }
  return cur;
}

/** Set a value at a dotted path, creating intermediate objects as needed. */
export function setAtPath(obj: Json, path: string, value: unknown): void {
  const segs = path.split('.');
  let cur: Json = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i]!;
    const next = cur[seg];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      cur[seg] = {};
    }
    cur = cur[seg] as Json;
  }
  cur[segs[segs.length - 1]!] = value;
}

/**
 * Delete the leaf at a dotted path. Prunes any parent objects left empty by the
 * deletion so the persisted file does not accumulate `{}` husks. Returns true
 * if a value was actually removed.
 */
export function unsetAtPath(obj: Json, path: string): boolean {
  const segs = path.split('.');
  // Walk to each ancestor, tracking the chain so we can prune upward.
  const chain: Json[] = [obj];
  let cur: Json = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i]!;
    const next = cur[seg];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) return false;
    cur = next as Json;
    chain.push(cur);
  }
  const leaf = segs[segs.length - 1]!;
  if (!(leaf in cur)) return false;
  delete cur[leaf];
  // Prune empties from the leaf's parent upward.
  for (let i = chain.length - 1; i >= 1; i--) {
    const node = chain[i]!;
    if (Object.keys(node).length === 0) {
      const parentKey = segs[i - 1]!;
      delete chain[i - 1]![parentKey];
    } else {
      break;
    }
  }
  return true;
}
