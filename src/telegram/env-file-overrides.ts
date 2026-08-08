/**
 * Telegram config-file → env overrides.
 *
 * Extracted from `src/telegram.ts` so these pure functions can be imported in
 * tests without triggering the entrypoint's module-level `main()` call — the
 * same rationale recorded in `version-check.ts`.
 *
 * Invariant: for the keys in {@link TELEGRAM_FILE_AUTHORITATIVE_KEYS}, the
 * user-scope config FILE wins over a disagreeing shell env var. That is the
 * inverse of dotenv's standard `override:false` rule and is intentional: these
 * are operator-managed config values, not CI-injected credentials. A shell env
 * that disagrees is almost always accidental drift from an old project `.env`
 * exported into the parent shell — exactly the trap that bit this repo's first
 * end-to-end test. Anthropic credentials are deliberately NOT in this list;
 * those keep dotenv's shell-wins rule because CI commonly injects
 * `ANTHROPIC_API_KEY`.
 */

import { existsSync, readFileSync } from 'fs';

/** Telegram-specific config keys that file values override shell env for. */
export const TELEGRAM_FILE_AUTHORITATIVE_KEYS = [
  'TELEGRAM_BOT_TOKEN',
  'AFK_TELEGRAM_ALLOWED_CHAT_IDS',
  'TELEGRAM_VERBOSE',
  'TELEGRAM_DATA_DIR',
];

/**
 * Parse a dotenv-format file into a key→value map. Skips comments and
 * blank lines; strips matching surrounding quotes. Returns an empty map
 * when the file is missing or unreadable.
 *
 * Behavior matches the subset of dotenv's parser we depend on; we don't use
 * dotenv directly because we need to read the file WITHOUT applying it to
 * `process.env`.
 */
export function parseEnvFile(filePath: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(filePath)) return out;
  try {
    const contents = readFileSync(filePath, 'utf-8');
    for (const line of contents.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      out.set(key, value);
    }
  } catch {
    /* unreadable — treat as missing */
  }
  return out;
}

/**
 * Mask a value for logging. Bot tokens look like `12345:AbCdEf...`, so the
 * bot-id prefix is kept for diagnosability and the secret half is redacted.
 * Non-token keys are not secret and pass through unchanged.
 */
export function maskOverrideValue(key: string, raw: string): string {
  if (key !== 'TELEGRAM_BOT_TOKEN') return raw;
  const colon = raw.indexOf(':');
  if (colon === -1) return `${raw.slice(0, 4)}***`;
  return `${raw.slice(0, colon + 1)}***`;
}

/**
 * For each Telegram-authoritative key, copy the file value into `process.env`
 * even when an existing shell-set value disagrees. When an override happens,
 * log a one-line notice so the operator sees what changed. No-op for keys not
 * present in the file (the shell value remains).
 *
 * See the module docblock for why this inverts dotenv's precedence.
 */
export function applyTelegramFileOverrides(
  filePath: string,
  log: (message: string) => void = console.log,
): void {
  const fileVars = parseEnvFile(filePath);
  for (const key of TELEGRAM_FILE_AUTHORITATIVE_KEYS) {
    const fileVal = fileVars.get(key);
    if (fileVal === undefined) continue;
    const envVal = process.env[key]; // audit-env-access: allow — dynamic loop over fixed allowlist
    if (envVal !== undefined && envVal !== fileVal) {
      log(
        `🔧 ${key}: file value (${maskOverrideValue(key, fileVal)}) overrides shell value (${maskOverrideValue(key, envVal)})`,
      );
    }
    process.env[key] = fileVal;
  }
}
