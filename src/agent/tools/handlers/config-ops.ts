/**
 * Handlers for the `config_get` / `config_set` built-in tools — the agent's
 * sanctioned path to read and edit its OWN config (`~/.afk/config/afk.env` and
 * `~/.afk/config/afk.config.json`).
 *
 * Both delegate to the validated mutation engine (`src/config/mutate.ts`). The
 * engine enforces the sensitivity tiers; these handlers NEVER opt past the
 * `allowSecret` / `allowHumanOnly` gates, so:
 *   - secret env vars (API keys, tokens) and human-tier config keys
 *     (systemPrompt, hooks, …) are REFUSED — the engine throws an error whose
 *     message tells the agent a human must run the `afk config` CLI;
 *   - the agent may freely read (masked) and set non-secret behavioural knobs.
 *
 * Invariant: the engine writes only the two canonical config files via
 * `src/paths.ts` and never goes through `write_file`/`edit_file`, so the S4
 * write-denylist on `~/.afk/config` stays intact for every other path.
 *
 * Effects take place on the NEXT session/daemon restart — config is cached at
 * process start. Every successful `config_set` result says so.
 *
 * @module agent/tools/handlers/config-ops
 */

import type { ToolHandler, ToolResult } from '../types.js';
import {
  setEnvVar,
  unsetEnvVar,
  getEnvVar,
  listEnv,
  setConfigValue,
  unsetConfigValue,
  getConfigValue,
  listConfig,
  RESTART_NOTE,
} from '../../../config/mutate.js';

type Target = 'env' | 'config';

function asRecord(input: unknown): Record<string, unknown> | undefined {
  return input !== null && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : undefined;
}

function parseTarget(raw: unknown): Target | undefined {
  return raw === 'env' || raw === 'config' ? raw : undefined;
}

function errResult(message: string): ToolResult {
  return { content: message, isError: true };
}

/** Read config/env (read-class). Secrets are always masked. */
export const configGetHandler: ToolHandler = async (input) => {
  const obj = asRecord(input);
  if (!obj) return errResult('config_get: expected an object input');
  const target = parseTarget(obj['target']);
  if (!target) return errResult("config_get: `target` must be 'env' or 'config'");
  const key = typeof obj['key'] === 'string' ? (obj['key'] as string) : undefined;
  const all = obj['all'] === true;

  try {
    if (target === 'env') {
      if (key) {
        const v = getEnvVar(key);
        return { content: JSON.stringify(v, null, 2) };
      }
      return { content: JSON.stringify(listEnv({ all }), null, 2) };
    }
    // target === 'config'
    if (key) {
      const v = getConfigValue(key);
      return { content: JSON.stringify(v, null, 2) };
    }
    return { content: JSON.stringify(listConfig(), null, 2) };
  } catch (err) {
    return errResult(`config_get: ${(err as Error).message}`);
  }
};

/** Write config/env (write-class). Refuses secrets and human-tier keys. */
export const configSetHandler: ToolHandler = async (input) => {
  const obj = asRecord(input);
  if (!obj) return errResult('config_set: expected an object input');
  const target = parseTarget(obj['target']);
  if (!target) return errResult("config_set: `target` must be 'env' or 'config'");
  const key = typeof obj['key'] === 'string' ? (obj['key'] as string) : undefined;
  if (!key) return errResult('config_set: `key` is required');
  const action = obj['action'] === 'unset' ? 'unset' : 'set';
  const value = obj['value'];

  try {
    if (action === 'unset') {
      if (target === 'env') {
        const r = unsetEnvVar(key); // no allowSecret → secrets refused
        return {
          content: r.removed
            ? `Removed ${r.key} from afk.env (${r.persistedTo}). ${RESTART_NOTE}.`
            : `${r.key} was not set in afk.env; nothing to remove.`,
        };
      }
      const r = unsetConfigValue(key); // no allowHumanOnly → human keys refused
      return {
        content: r.removed
          ? `Removed ${r.path} from afk.config.json (${r.persistedTo}). ${RESTART_NOTE}.`
          : `${r.path} was not set in afk.config.json; nothing to remove.`,
      };
    }

    // action === 'set'
    if (value === undefined || value === null) {
      return errResult(`config_set: \`value\` is required to set ${key}`);
    }

    if (target === 'env') {
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        return errResult('config_set: env values must be a string, number, or boolean');
      }
      const r = setEnvVar(key, String(value)); // no allowSecret → secrets refused
      return {
        content: `Set ${r.key} = ${r.display} in afk.env (${r.persistedTo}). ${RESTART_NOTE}.`,
      };
    }

    // target === 'config'
    const r = setConfigValue(key, value); // no allowHumanOnly → human keys refused
    return {
      content: `Set ${r.path} = ${JSON.stringify(r.value)} in afk.config.json (${r.persistedTo}). ${RESTART_NOTE}.`,
    };
  } catch (err) {
    // Engine errors (SecretWriteRefused, HumanOnlyKeyRefused, UnknownKeyError,
    // ConfigValidationError, MalformedConfigError) carry agent-actionable
    // guidance in their message — surface it verbatim.
    return errResult(`config_set: ${(err as Error).message}`);
  }
};
