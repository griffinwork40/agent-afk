/**
 * Config-mutation engine — the single validated write path for self-service
 * edits to `~/.afk/config/afk.env` and `~/.afk/config/afk.config.json`.
 *
 * Consumed by the `afk config` CLI (human surface) and the `config_get` /
 * `config_set` agent tools. Both go through here so validation, the
 * sensitivity tiers (`src/config/settable-keys.ts`), atomic writes, and `.bak`
 * backups are enforced once, in one place.
 *
 * Sensitivity gate (the cross-surface contract):
 *   - Agent-tier keys: any caller may write.
 *   - Secret env vars / human-tier config keys: writes are refused UNLESS the
 *     caller passes `allowSecret` / `allowHumanOnly`. The CLI opts in (after a
 *     masked `promptSecret` / explicit human action); the agent tool never does.
 *
 * Invariant: this engine writes ONLY the two canonical user-scope config files
 * (resolved via `src/paths.ts`). It deliberately does NOT go through
 * `write_file`/`edit_file`, so the S4 write-denylist on `~/.afk/config` stays
 * intact for every other path. Effects take place on the NEXT process start —
 * config is cached at load time; see `RESTART_NOTE`.
 *
 * @module config/mutate
 */

import { existsSync, readFileSync, copyFileSync, chmodSync } from 'fs';
import { getEnvConfigPath, getJsonConfigPath } from '../paths.js';
import { getEnvVarMeta, ENV_REGISTRY, isEnvVarSet } from './env.js';
import { atomicWriteFile, upsertEnvVar, removeEnvVar, readEnvVarFromFile, readEnvFile } from '../utils/envFile.js';
import {
  classifyEnvKey,
  coerceEnvValue,
  classifyConfigKey,
  getConfigKeySpec,
  coerceConfigValue,
  getAtPath,
  setAtPath,
  unsetAtPath,
  type EnvKeyClass,
  type ConfigKeyClass,
} from './settable-keys.js';

/** Surfaced by callers so the user knows a write does not affect this process. */
export const RESTART_NOTE =
  'effective on the next session/daemon restart; the current session is unchanged';

// ── Error taxonomy ────────────────────────────────────────────────────────────

export class UnknownKeyError extends Error {
  constructor(key: string) {
    super(`unknown config key: ${key}`);
    this.name = 'UnknownKeyError';
  }
}
export class NonConfigKeyError extends Error {
  constructor(key: string) {
    super(`${key} is a process/inherited env var and is not afk-configurable`);
    this.name = 'NonConfigKeyError';
  }
}
export class SecretWriteRefused extends Error {
  constructor(key: string) {
    super(
      `${key} holds a credential; the agent cannot set it. A human must run \`afk config env set ${key}\` (the value is entered masked and never enters the model context).`,
    );
    this.name = 'SecretWriteRefused';
  }
}
export class ProtectedEnvKeyRefused extends Error {
  constructor(key: string) {
    super(
      `${key} controls identity, safety, capability, autonomous runs, request routing, or where AFK's own state lives; the agent cannot set it. A human must run \`afk config env set ${key}\`.`,
    );
    this.name = 'ProtectedEnvKeyRefused';
  }
}
export class HumanOnlyKeyRefused extends Error {
  constructor(key: string) {
    super(`${key} is human-gated (prompt/hooks/identity); the agent cannot set it. A human must run \`afk config set ${key}\`.`);
    this.name = 'HumanOnlyKeyRefused';
  }
}
export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}
export class MalformedConfigError extends Error {
  constructor(path: string) {
    super(`refusing to write: existing ${path} is not valid JSON (fix or remove it by hand first)`);
    this.name = 'MalformedConfigError';
  }
}

// ── Masking ───────────────────────────────────────────────────────────────────

/** Mask a secret value to a safe presence indicator (never the raw value). */
export function maskSecret(value: string | undefined): string {
  if (value === undefined || value.length === 0) return '<unset>';
  if (value.length <= 4) return 'set (****)';
  return `set (****${value.slice(-4)})`;
}

// ── Env mutations ──────────────────────────────────────────────────────────────

export interface EnvOptions {
  /** Permit writing/removing secret-flagged vars (CLI only; never the agent). */
  allowSecret?: boolean;
  /** Permit writing/removing protected control vars (CLI only; never the agent). */
  allowProtected?: boolean;
  /** Override the target file (tests). Defaults to ~/.afk/config/afk.env. */
  filePath?: string;
}

export interface EnvVarView {
  key: string;
  class: EnvKeyClass;
  /** Value persisted in afk.env (masked if secret). undefined when not in file. */
  persisted: string | undefined;
  /** Whether the var is currently set in this process's environment. */
  activeInProcess: boolean;
}

function envPath(opts?: EnvOptions): string {
  return opts?.filePath ?? getEnvConfigPath();
}

/** Throw unless `key` may be written by this caller. Returns the key class. */
function assertEnvWritable(
  key: string,
  allowSecret: boolean | undefined,
  allowProtected: boolean | undefined,
): EnvKeyClass {
  const cls = classifyEnvKey(key);
  if (cls === 'unknown') throw new UnknownKeyError(key);
  if (cls === 'non-config') throw new NonConfigKeyError(key);
  if (cls === 'secret' && !allowSecret) throw new SecretWriteRefused(key);
  if (cls === 'protected' && !allowProtected) throw new ProtectedEnvKeyRefused(key);
  return cls;
}

export interface EnvWriteResult {
  key: string;
  class: EnvKeyClass;
  persistedTo: string;
  /** Display-safe value (masked when the key is secret). */
  display: string;
}

export function setEnvVar(key: string, rawValue: string, opts?: EnvOptions): EnvWriteResult {
  const cls = assertEnvWritable(key, opts?.allowSecret, opts?.allowProtected);
  const meta = getEnvVarMeta(key)!; // non-undefined: assertEnvWritable rejected unknown
  const coerced = coerceEnvValue(meta, rawValue);
  if (!coerced.ok) throw new ConfigValidationError(coerced.error);
  const file = envPath(opts);
  upsertEnvVar(file, key, coerced.value);
  return {
    key,
    class: cls,
    persistedTo: file,
    display: cls === 'secret' ? maskSecret(coerced.value) : coerced.value,
  };
}

export interface EnvRemoveResult {
  key: string;
  class: EnvKeyClass;
  removed: boolean;
  persistedTo: string;
}

export function unsetEnvVar(key: string, opts?: EnvOptions): EnvRemoveResult {
  const cls = assertEnvWritable(key, opts?.allowSecret, opts?.allowProtected);
  const file = envPath(opts);
  const removed = removeEnvVar(file, key);
  return { key, class: cls, removed, persistedTo: file };
}

export function getEnvVar(key: string, opts?: EnvOptions): EnvVarView {
  const cls = classifyEnvKey(key);
  if (cls === 'unknown') throw new UnknownKeyError(key);
  const file = envPath(opts);
  const rawPersisted = readEnvVarFromFile(file, key);
  const activeInProcess = isEnvVarSet(key);
  const persisted =
    cls === 'secret' ? (rawPersisted !== undefined ? maskSecret(rawPersisted) : undefined) : rawPersisted;
  return { key, class: cls, persisted, activeInProcess };
}

/**
 * List env vars. By default only those actually present (in afk.env or in the
 * process env); pass `all` to list every registry var. Secrets are masked.
 */
export function listEnv(opts?: EnvOptions & { all?: boolean }): EnvVarView[] {
  const file = envPath(opts);
  const fileVars = readEnvFile(file);
  const out: EnvVarView[] = [];
  // Iterate the registry (single source of names), not the file, so unknown
  // hand-added keys don't leak; report file-persisted values where present.
  for (const entry of ENV_REGISTRY) {
    const name = entry.name;
    const cls = classifyEnvKey(name);
    const rawPersisted = fileVars[name];
    const activeInProcess = isEnvVarSet(name);
    if (!opts?.all && rawPersisted === undefined && !activeInProcess) continue;
    const persisted =
      cls === 'secret'
        ? rawPersisted !== undefined
          ? maskSecret(rawPersisted)
          : undefined
        : rawPersisted;
    out.push({ key: name, class: cls, persisted, activeInProcess });
  }
  return out;
}

// ── Config (afk.config.json) mutations ──────────────────────────────────────────

export interface ConfigOptions {
  /** Permit writing/removing human-tier keys (CLI only; never the agent). */
  allowHumanOnly?: boolean;
  /** Override the target file (tests). Defaults to ~/.afk/config/afk.config.json. */
  filePath?: string;
}

function jsonPath(opts?: ConfigOptions): string {
  return opts?.filePath ?? getJsonConfigPath();
}

/** Read + parse the config file. Throws MalformedConfigError on bad JSON. */
function readConfigObject(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    throw new MalformedConfigError(file);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new MalformedConfigError(file);
  }
  return parsed as Record<string, unknown>;
}

function writeConfigObject(file: string, obj: Record<string, unknown>): void {
  // Back up the prior file (last-known-good) before overwriting, so a bad write
  // is recoverable from <file>.bak.
  if (existsSync(file)) {
    try {
      copyFileSync(file, `${file}.bak`);
      // copyFileSync inherits the source mode; force 0o600 so a pre-existing
      // world-readable config can't leak through a world-readable backup.
      chmodSync(`${file}.bak`, 0o600);
    } catch {
      /* non-fatal: a missing .bak just means no rollback copy this time */
    }
  }
  atomicWriteFile(file, JSON.stringify(obj, null, 2) + '\n', 0o600);
}

/** Throw unless `path` may be written by this caller. Returns the key class. */
function assertConfigWritable(path: string, allowHumanOnly: boolean | undefined): ConfigKeyClass {
  const cls = classifyConfigKey(path);
  if (cls === 'unknown') throw new UnknownKeyError(path);
  if (cls === 'human' && !allowHumanOnly) throw new HumanOnlyKeyRefused(path);
  return cls;
}

export interface ConfigWriteResult {
  path: string;
  class: ConfigKeyClass;
  value: string | number | boolean | number[];
  persistedTo: string;
}

export function setConfigValue(
  path: string,
  rawValue: unknown,
  opts?: ConfigOptions,
): ConfigWriteResult {
  const cls = assertConfigWritable(path, opts?.allowHumanOnly);
  const spec = getConfigKeySpec(path)!; // non-undefined: assertConfigWritable rejected unknown
  const coerced = coerceConfigValue(spec, rawValue);
  if (!coerced.ok) throw new ConfigValidationError(coerced.error);
  const file = jsonPath(opts);
  const obj = readConfigObject(file);
  setAtPath(obj, path, coerced.value);
  writeConfigObject(file, obj);
  return { path, class: cls, value: coerced.value, persistedTo: file };
}

export interface ConfigRemoveResult {
  path: string;
  class: ConfigKeyClass;
  removed: boolean;
  persistedTo: string;
}

export function unsetConfigValue(path: string, opts?: ConfigOptions): ConfigRemoveResult {
  const cls = assertConfigWritable(path, opts?.allowHumanOnly);
  const file = jsonPath(opts);
  const obj = readConfigObject(file);
  const removed = unsetAtPath(obj, path);
  if (removed) writeConfigObject(file, obj);
  return { path, class: cls, removed, persistedTo: file };
}

export interface ConfigValueView {
  path: string;
  class: ConfigKeyClass;
  value: unknown;
}

export function getConfigValue(path: string, opts?: ConfigOptions): ConfigValueView {
  const cls = classifyConfigKey(path);
  const file = jsonPath(opts);
  const obj = readConfigObject(file);
  return { path, class: cls, value: getAtPath(obj, path) };
}

/** Return the full persisted afk.config.json object ({} when absent). */
export function listConfig(opts?: ConfigOptions): Record<string, unknown> {
  return readConfigObject(jsonPath(opts));
}
