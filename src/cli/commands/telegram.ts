/**
 * `afk telegram` command group.
 *
 * Thin CLI veneer over `src/telegram/manager.ts` (lifecycle) and
 * `src/telegram/setup-wizard.ts` (interactive config). Replaces the legacy
 * `scripts/telegram-manager.sh`, which assumed npm + project-scoped state.
 *
 * Subcommands:
 *   afk telegram setup    — interactive: bot token + chat ID → ~/.afk/config/afk.env
 *   afk telegram start    — spawn the bot, write PID to ~/.afk/state/telegram/
 *   afk telegram stop     — SIGTERM (graceful, then SIGKILL after 5s)
 *   afk telegram status   — running state + uptime + log tail
 *   afk telegram restart  — stop + start
 *   afk telegram logs     — tail ~/.afk/logs/telegram.log
 *
 * @module cli/commands/telegram
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { start, stop, status, type BotStatus } from '../../telegram/manager.js';
import {
  runTelegramSetup,
  checkTokenFromFile,
  discoverChatFromFile,
} from '../../telegram/setup-wizard.js';
import { upsertEnvVar } from '../auth-wizard.js';
import { getEnvConfigPath } from '../../paths.js';

export function registerTelegramCommand(program: Command): void {
  const telegram = program
    .command('telegram')
    .description('Manage the Agent AFK Telegram bot (setup, start, stop, status)');

  telegram
    .command('setup')
    .description('Interactive setup: validate bot token, discover chat ID, persist to ~/.afk/config/afk.env')
    .action(async () => {
      try {
        await runTelegramSetup();
      } catch (error) {
        console.error(chalk.red(`Setup failed: ${(error as Error).message}`));
        process.exit(1);
      }
    });

  // ────────────────────────────────────────────────────────────────────────
  // Sanctioned introspection subcommands.
  //
  // These exist for the `telegram-setup` skill (and future doctor/status
  // tooling) to inspect Telegram config WITHOUT the bearer token ever
  // crossing the model's tool-call boundary. Each command reads the token
  // from `~/.afk/config/afk.env` in-process, uses it once over HTTPS, and
  // emits only metadata to stdout as JSON. The token is never logged,
  // printed, or returned.
  //
  // Contract: stdout is exactly one JSON object terminated by a newline.
  // Exit code: 0 on any well-formed result (including invalid token /
  // timeout — the JSON payload conveys the failure). Non-zero exit only
  // for programmer errors (e.g., missing positional arg).
  // ────────────────────────────────────────────────────────────────────────

  telegram
    .command('check-token')
    .description('Validate TELEGRAM_BOT_TOKEN via getMe; emit JSON {set, valid, username?, botId?, reason?}')
    .action(async () => {
      const result = await checkTokenFromFile(getEnvConfigPath());
      process.stdout.write(JSON.stringify(result) + '\n');
    });

  telegram
    .command('discover-chat')
    .description('Poll getUpdates for chats that have DM\'d the bot; emit JSON {found, chats, reason?}')
    .option('--timeout-sec <n>', 'How long to poll before giving up', '60')
    .action(async (opts: { timeoutSec?: string }) => {
      const timeoutSec = Number.parseInt(opts.timeoutSec ?? '60', 10);
      if (!Number.isFinite(timeoutSec) || timeoutSec < 1) {
        console.error(chalk.red('--timeout-sec must be a positive integer'));
        process.exit(2);
      }
      const result = await discoverChatFromFile(getEnvConfigPath(), { timeoutSec });
      process.stdout.write(JSON.stringify(result) + '\n');
    });

  telegram
    .command('set-allowed-chat <chatId>')
    .description('Persist AFK_TELEGRAM_ALLOWED_CHAT_IDS=<chatId> to ~/.afk/config/afk.env; emit JSON {ok, path}')
    .action((chatId: string) => {
      const parsed = Number.parseInt(chatId, 10);
      if (!Number.isFinite(parsed)) {
        process.stdout.write(JSON.stringify({ ok: false, reason: 'invalid-chat-id' }) + '\n');
        process.exit(2);
      }
      const envPath = getEnvConfigPath();
      upsertEnvVar(envPath, 'AFK_TELEGRAM_ALLOWED_CHAT_IDS', String(parsed));
      process.stdout.write(JSON.stringify({ ok: true, path: envPath }) + '\n');
    });

  telegram
    .command('start')
    .description('Start the bot as a background daemon')
    .action(async () => {
      const result = await start();
      if (result.kind === 'started') {
        console.log(chalk.green(`✓ Bot started (PID ${result.pid})`));
        console.log(chalk.gray(`  Logs: ${result.logFile}`));
        console.log(chalk.gray(`  Tail with: afk telegram logs --follow`));
        return;
      }
      if (result.kind === 'already-running') {
        console.log(chalk.yellow(`⚠ ${result.message}`));
        process.exit(1);
      }
      if (result.kind === 'exited-immediately') {
        console.error(chalk.red(`✗ ${result.message}`));
        if (result.logTail && result.logTail.length > 0) {
          console.error('');
          console.error(chalk.bold('Last log entries:'));
          for (const line of result.logTail) console.error(chalk.gray(`  ${line}`));
        }
        process.exit(1);
      }
      console.error(chalk.red(`✗ ${result.message}`));
      process.exit(1);
    });

  telegram
    .command('stop')
    .description('Stop the bot (SIGTERM, then SIGKILL after 5s)')
    .action(async () => {
      const result = await stop();
      if (result.kind === 'not-running') {
        console.log(chalk.yellow('⚠ Bot is not running'));
        return;
      }
      if (result.kind === 'stopped') {
        console.log(chalk.green(`✓ Bot stopped (PID ${result.pid})`));
        return;
      }
      console.log(chalk.yellow(`⚠ Bot force-killed (PID ${result.pid}); graceful shutdown timed out`));
    });

  telegram
    .command('restart')
    .description('Stop and restart the bot')
    .action(async () => {
      const stopResult = await stop();
      if (stopResult.kind === 'stopped' || stopResult.kind === 'force-killed') {
        console.log(chalk.gray(`Stopped (PID ${stopResult.pid})`));
      }
      const startResult = await start();
      if (startResult.kind === 'started') {
        console.log(chalk.green(`✓ Bot restarted (PID ${startResult.pid})`));
        return;
      }
      console.error(chalk.red(`✗ Restart failed: ${startResult.message}`));
      process.exit(1);
    });

  telegram
    .command('status')
    .description('Show running state, uptime, memory, and recent log entries')
    .action(() => {
      const s = status();
      printStatus(s);
    });

  telegram
    .command('logs')
    .description('Show or follow the bot log')
    .option('-f, --follow', 'Stream new log entries (like tail -f)', false)
    .option('-n, --lines <count>', 'Number of trailing lines to show', '50')
    .action((opts: { follow?: boolean; lines?: string }) => {
      const { logFile } = status();
      if (!existsSync(logFile)) {
        console.log(chalk.yellow(`No log file at ${logFile}`));
        console.log(chalk.gray('Start the bot first: afk telegram start'));
        return;
      }
      const lines = Number.parseInt(opts.lines ?? '50', 10);
      if (opts.follow) {
        const tail = spawn('tail', ['-n', String(lines), '-f', logFile], { stdio: 'inherit' });
        tail.on('error', (e) => {
          console.error(chalk.red(`Failed to spawn tail: ${e.message}`));
        });
        return;
      }
      const contents = readFileSync(logFile, 'utf-8').split('\n').slice(-lines - 1);
      console.log(contents.join('\n'));
    });
}

/** Render a BotStatus snapshot to stdout. */
function printStatus(s: BotStatus): void {
  console.log(chalk.bold('📊 Telegram Bot Status'));
  console.log('');
  if (s.running) {
    console.log(`  ${chalk.green('●')} Running  (PID ${s.pid})`);
    if (s.uptimeSec !== undefined) {
      console.log(`  Uptime:  ${formatUptime(s.uptimeSec)}`);
    }
    if (s.memoryMb !== undefined) {
      console.log(`  Memory:  ${s.memoryMb} MB`);
    }
  } else {
    console.log(`  ${chalk.red('●')} Stopped`);
  }
  console.log(`  PID:     ${s.pidFile}`);
  console.log(`  Logs:    ${s.logFile}`);
  if (s.logTail && s.logTail.length > 0) {
    console.log('');
    console.log(chalk.bold('Recent log entries:'));
    for (const line of s.logTail) console.log(chalk.gray(`  ${line}`));
  }
}

function formatUptime(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ${sec % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}
