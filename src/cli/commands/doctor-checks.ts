/**
 * Shared health-check logic for `afk doctor` (CLI) and `/doctor` (REPL slash command).
 *
 * Each exported function returns a Check (or null to omit the check from the
 * report). `runDoctorChecks()` runs all checks and returns the full list.
 *
 * Neither this module nor any function it exports calls process.exit() or
 * writes to stdout/stderr — rendering is the caller's responsibility.
 */

import { env, getMissingRequiredEnvVars } from '../../config/env.js';
import { access, constants, mkdir, readFile } from 'fs/promises';
import { execSync } from 'child_process';
import { getApiKey, getCodexApiKey } from '../shared-helpers.js';
import {
  getAfkConfigDir,
  getAfkStateDir,
  getLogsDir,
  getJsonConfigPath,
} from '../../paths.js';
import { detectSources, loadImportFromConfig } from '../../config/import-sources.js';

export interface Check {
  name: string;
  state: 'pass' | 'warn' | 'fail';
  detail?: string;
  fix?: string;
}

export async function checkAnthropicKey(): Promise<Check> {
  const key = getApiKey();
  if (key) {
    return { name: 'Anthropic API Key', state: 'pass', detail: 'ANTHROPIC_API_KEY set' };
  }
  return {
    name: 'Anthropic API Key',
    state: 'fail',
    fix: 'Set ANTHROPIC_API_KEY or run `afk login`',
  };
}

export async function checkCodexKey(): Promise<Check> {
  const key = getCodexApiKey();
  if (key) {
    return {
      name: 'Codex/OpenAI API Key',
      state: 'pass',
      detail: 'OPENAI_API_KEY or CODEX_API_KEY set',
    };
  }
  return {
    name: 'Codex/OpenAI API Key',
    state: 'warn',
    fix: 'Set OPENAI_API_KEY or CODEX_API_KEY to use Codex models',
  };
}

export async function checkNpmBinOnPath(): Promise<Check> {
  try {
    const prefix = execSync('npm config get prefix', {
      timeout: 2000,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .trim()
      .replace(/\/$/, '');
    const binDir = `${prefix}/bin`;
    const pathParts = (env.PATH ?? '').split(':').map((p) => p.replace(/\/$/, ''));
    if (pathParts.includes(binDir)) {
      return { name: 'npm bin on PATH', state: 'pass', detail: binDir };
    }
    return {
      name: 'npm bin on PATH',
      state: 'fail',
      detail: binDir,
      fix: `Add ${binDir} to PATH: echo 'export PATH="${binDir}:$PATH"' >> ~/.zshrc`,
    };
  } catch {
    return { name: 'npm bin on PATH', state: 'warn', detail: 'could not query npm prefix' };
  }
}

export async function checkDirWritable(name: string, getDir: () => string): Promise<Check> {
  const dir = getDir();
  try {
    await access(dir, constants.W_OK);
    return { name, state: 'pass', detail: dir };
  } catch {
    try {
      await mkdir(dir, { recursive: true });
      return { name, state: 'pass', detail: `${dir} (created)` };
    } catch {
      return { name, state: 'fail', detail: dir, fix: `Unable to create or write to ${dir}` };
    }
  }
}

export async function checkConfigFile(): Promise<Check> {
  const path = getJsonConfigPath();
  try {
    const content = await readFile(path, 'utf-8');
    JSON.parse(content);
    return { name: 'Config File', state: 'pass', detail: `${path} (valid JSON)` };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { name: 'Config File', state: 'pass', detail: 'no config file (using defaults)' };
    }
    return {
      name: 'Config File',
      state: 'fail',
      detail: path,
      fix: `Unable to parse config file: ${err instanceof Error ? err.message : 'unknown error'}`,
    };
  }
}

/**
 * // Invariant: returns null (omits the check) when no env vars in the registry
 * are marked required — avoids a spurious "0 missing" row in the report.
 * The registry intentionally starts with no required: true entries; this
 * check is a forward-compatibility hook so future required vars surface
 * automatically.
 */
export async function checkRequiredEnvVars(): Promise<Check | null> {
  const missing = getMissingRequiredEnvVars();
  if (missing.length === 0) return null;
  return {
    name: 'Required env vars',
    state: 'fail',
    detail: `Missing: ${missing.map((m) => m.name).join(', ')}`,
    fix: 'Set these env vars before running. See docs/env-registry.md for descriptions.',
  };
}

export async function checkTelegram(): Promise<Check | null> {
  const token = env.AFK_TELEGRAM_BOT_TOKEN;
  if (!token) return null;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (response.ok) {
      const json = (await response.json()) as { result?: { username?: string } };
      const botUsername = json.result?.username;
      return {
        name: 'Telegram Bot',
        state: 'pass',
        detail: botUsername ? `@${botUsername}` : 'connected',
      };
    }
    return {
      name: 'Telegram Bot',
      state: 'fail',
      fix: `Telegram API returned ${response.status}. Check AFK_TELEGRAM_BOT_TOKEN.`,
    };
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      return { name: 'Telegram Bot', state: 'warn', detail: 'connection timeout' };
    }
    return {
      name: 'Telegram Bot',
      state: 'warn',
      detail: `network error: ${err instanceof Error ? err.message : 'unknown'}`,
    };
  }
}

/**
 * Surface importable assets from other agent CLIs (Claude Code, Codex) that
 * are present on disk but not yet trusted via `importFrom`. Returns `null`
 * when nothing new is available (so the check stays silent for the common
 * case), otherwise a `warn` nudging the user toward `afk migrate`.
 */
export async function checkImportAvailable(): Promise<Check | null> {
  let detected;
  try {
    detected = detectSources();
  } catch {
    return null;
  }
  const trusted = loadImportFromConfig() ?? {};
  const untrusted = detected.filter(
    (s) =>
      s.present &&
      (s.plugins.length > 0 || s.skills.length > 0) &&
      trusted[s.binary] === undefined,
  );
  if (untrusted.length === 0) return null;
  const summary = untrusted
    .map((s) => `${s.label} (${s.plugins.length} plugins, ${s.skills.length} skills)`)
    .join('; ');
  return {
    name: 'Cross-tool import available',
    state: 'warn',
    detail: summary,
    fix: 'Run `afk migrate` to import them',
  };
}

/** Run all checks and return the full list (nulls filtered out). */
export async function runDoctorChecks(): Promise<Check[]> {
  const results: Check[] = [];

  results.push(await checkAnthropicKey());
  results.push(await checkCodexKey());
  results.push(await checkNpmBinOnPath());
  results.push(await checkDirWritable('Config Directory', getAfkConfigDir));
  results.push(await checkDirWritable('State Directory', getAfkStateDir));
  results.push(await checkDirWritable('Logs Directory', getLogsDir));
  results.push(await checkConfigFile());

  const envCheck = await checkRequiredEnvVars();
  if (envCheck !== null) results.push(envCheck);

  const telegramCheck = await checkTelegram();
  if (telegramCheck !== null) results.push(telegramCheck);

  const importCheck = await checkImportAvailable();
  if (importCheck !== null) results.push(importCheck);

  return results;
}
