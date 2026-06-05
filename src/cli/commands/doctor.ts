import { Command } from 'commander';
import { env, getMissingRequiredEnvVars } from '../../config/env.js';
import { access, constants, mkdir, readFile } from 'fs/promises';
import { execSync } from 'child_process';
import { palette } from '../palette.js';
import {
  getApiKey,
  getCodexApiKey,
} from '../shared-helpers.js';
import {
  getAfkConfigDir,
  getAfkStateDir,
  getLogsDir,
  getJsonConfigPath,
} from '../../paths.js';

interface Check {
  name: string;
  state: 'pass' | 'warn' | 'fail';
  detail?: string;
  fix?: string;
}

async function checkAnthropicKey(): Promise<Check> {
  const key = getApiKey();
  if (key) {
    return {
      name: 'Anthropic API Key',
      state: 'pass',
      detail: 'ANTHROPIC_API_KEY set',
    };
  }
  return {
    name: 'Anthropic API Key',
    state: 'fail',
    fix: 'Set ANTHROPIC_API_KEY or run `afk login`',
  };
}

async function checkCodexKey(): Promise<Check> {
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


async function checkNpmBinOnPath(): Promise<Check> {
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

async function checkDirWritable(
  name: string,
  getDir: () => string,
): Promise<Check> {
  const dir = getDir();
  try {
    await access(dir, constants.W_OK);
    return {
      name,
      state: 'pass',
      detail: dir,
    };
  } catch {
    try {
      await mkdir(dir, { recursive: true });
      return {
        name,
        state: 'pass',
        detail: `${dir} (created)`,
      };
    } catch {
      return {
        name,
        state: 'fail',
        detail: dir,
        fix: `Unable to create or write to ${dir}`,
      };
    }
  }
}

async function checkConfigFile(): Promise<Check> {
  const path = getJsonConfigPath();
  try {
    const content = await readFile(path, 'utf-8');
    JSON.parse(content);
    return {
      name: 'Config File',
      state: 'pass',
      detail: `${path} (valid JSON)`,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        name: 'Config File',
        state: 'pass',
        detail: 'no config file (using defaults)',
      };
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
 * Surface any `required: true` env var that is unset in the current process.
 *
 * The registry intentionally starts with no `required: true` entries — surfaces
 * (Telegram, daemon) do their own startup checks. The infra is here so when a
 * truly process-wide required var ever lands, it surfaces in `/doctor`
 * automatically.
 *
 * Returns `null` (omits the check from the report) when nothing in the
 * registry is marked required. The unknown-var warning was intentionally
 * dropped — `described: false` noise on registry launch trains users to ignore
 * the doctor output.
 */
async function checkRequiredEnvVars(): Promise<Check | null> {
  const missing = getMissingRequiredEnvVars();
  if (missing.length === 0) return null;
  return {
    name: 'Required env vars',
    state: 'fail',
    detail: `Missing: ${missing.map((m) => m.name).join(', ')}`,
    fix: `Set these env vars before running. See docs/env-registry.md for descriptions.`,
  };
}

async function checkTelegram(): Promise<Check | null> {
  const token = env.AFK_TELEGRAM_BOT_TOKEN;
  if (!token) {
    return null;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(
      `https://api.telegram.org/bot${token}/getMe`,
      { signal: controller.signal },
    );
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
      return {
        name: 'Telegram Bot',
        state: 'warn',
        detail: 'connection timeout',
      };
    }
    return {
      name: 'Telegram Bot',
      state: 'warn',
      detail: `network error: ${err instanceof Error ? err.message : 'unknown'}`,
    };
  }
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Check system health and configuration')
    .option('-f, --format <format>', 'Output format (text|json)', 'text')
    .action(async (options: { format: string }) => {
      const checks: Check[] = [];

      checks.push(await checkAnthropicKey());
      checks.push(await checkCodexKey());
      checks.push(await checkNpmBinOnPath());
      checks.push(
        await checkDirWritable('Config Directory', getAfkConfigDir),
      );
      checks.push(
        await checkDirWritable('State Directory', getAfkStateDir),
      );
      checks.push(
        await checkDirWritable('Logs Directory', getLogsDir),
      );
      checks.push(await checkConfigFile());

      const envCheck = await checkRequiredEnvVars();
      if (envCheck !== null) {
        checks.push(envCheck);
      }

      const telegramCheck = await checkTelegram();
      if (telegramCheck !== null) {
        checks.push(telegramCheck);
      }

      const summary = {
        passed: checks.filter((c) => c.state === 'pass').length,
        warned: checks.filter((c) => c.state === 'warn').length,
        failed: checks.filter((c) => c.state === 'fail').length,
      };

      if (options.format === 'json') {
        console.log(JSON.stringify({ checks, summary }, null, 2));
      } else {
        checks.forEach((check) => {
          let icon: string;
          if (check.state === 'pass') {
            icon = palette.success('✓');
          } else if (check.state === 'warn') {
            icon = palette.warning('⚠');
          } else {
            icon = palette.error('✗');
          }

          let line = `${icon} ${check.name}`;
          if (check.detail) {
            line += ` — ${check.detail}`;
          }
          console.log(line);

          if (check.state === 'fail' && check.fix) {
            console.log(`  Fix: ${check.fix}`);
          }
        });

        console.log(
          `\nSummary: ${summary.passed} passed, ${summary.warned} warned, ${summary.failed} failed`,
        );
      }

      process.exit(summary.failed > 0 ? 1 : 0);
    });
}
