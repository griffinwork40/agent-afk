/**
 * `afk telegram setup` wizard.
 *
 * Interactive flow that gets the bot from "fresh install" to "working":
 *   1. Verify or collect TELEGRAM_BOT_TOKEN (validated via getMe).
 *   2. Poll getUpdates to auto-discover the user's numeric chat ID after
 *      they DM the bot.
 *   3. Persist both into `~/.afk/config/afk.env` via the same `upsertEnvVar`
 *      helper the credential wizard uses (atomic, file mode 0o600).
 *
 * Pure helpers (`validateBotToken`, `findChatIdInUpdates`) are exported
 * separately from the prompt-driven flow so tests can exercise them
 * without stdin.
 *
 * @module telegram/setup-wizard
 */

import { existsSync, readFileSync } from 'fs';
import { createInterface } from 'readline';
import chalk from 'chalk';
import { upsertEnvVar } from '../utils/envFile.js';
import { getEnvConfigPath } from '../paths.js';
import { env } from '../config/env.js';
import { withStdinClaim } from '../cli/input/stdin-claim.js';

const TELEGRAM_API = 'https://api.telegram.org';

/**
 * Read a single key=value from a dotenv-formatted file without populating
 * `process.env`. Used by the sanctioned CLI subcommands so the token only
 * crosses an in-process boundary — never the model's tool-call output.
 *
 * Bypasses `process.env` deliberately: a long-lived agent subprocess may have
 * stale env from before the user edited the file. Reading the file directly
 * is the only way to see fresh writes.
 *
 * Pure (besides the disk read) and exported so the CLI subcommands and tests
 * can call it without going through dotenv.
 */
export function readEnvVarFromFile(filePath: string, key: string): string | undefined {
  if (!existsSync(filePath)) return undefined;
  const contents = readFileSync(filePath, 'utf-8');
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const k = line.slice(0, eq).trim();
    if (k !== key) continue;
    let v = line.slice(eq + 1).trim();
    // Strip matching surrounding quotes if present (single or double).
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    return v;
  }
  return undefined;
}

/** JSON shape returned by `afk telegram check-token`. */
export interface CheckTokenResult {
  set: boolean;
  valid: boolean;
  username?: string;
  botId?: number;
  /** Human-readable reason on failure (`unset`, `network`, `unauthorized`). */
  reason?: string;
}

/**
 * Read the token from the env file and validate via getMe. Returns a JSON-safe
 * struct. The token itself is never returned, logged, or echoed.
 */
export async function checkTokenFromFile(filePath: string): Promise<CheckTokenResult> {
  const token = readEnvVarFromFile(filePath, 'TELEGRAM_BOT_TOKEN');
  if (!token) return { set: false, valid: false, reason: 'unset' };
  const bot = await validateBotToken(token);
  if (!bot) return { set: true, valid: false, reason: 'unauthorized' };
  return {
    set: true,
    valid: true,
    botId: bot.id,
    ...(bot.username !== undefined ? { username: bot.username } : {}),
  };
}

/** JSON shape returned by `afk telegram discover-chat`. */
export interface DiscoverChatResult {
  found: boolean;
  chats: DiscoveredChat[];
  /** Human-readable reason on failure (`unset`, `timeout`, `network`). */
  reason?: string;
}

/**
 * Read the token from the env file and poll getUpdates for DM'd chats.
 * Returns a JSON-safe struct. The token is never returned or echoed.
 */
export async function discoverChatFromFile(
  filePath: string,
  opts: { timeoutSec?: number } = {},
): Promise<DiscoverChatResult> {
  const token = readEnvVarFromFile(filePath, 'TELEGRAM_BOT_TOKEN');
  if (!token) return { found: false, chats: [], reason: 'unset' };
  const timeoutSec = opts.timeoutSec ?? 60;
  const intervalMs = 2000;
  const maxAttempts = Math.max(1, Math.ceil((timeoutSec * 1000) / intervalMs));
  const chats = await pollForChats(token, { maxAttempts, intervalMs });
  if (chats.length === 0) return { found: false, chats: [], reason: 'timeout' };
  return { found: true, chats };
}

/** Result of a successful getMe call. */
export interface BotIdentity {
  id: number;
  username?: string;
  firstName: string;
}

/** Validate a bot token by calling getMe. Returns the bot identity or null. */
export async function validateBotToken(token: string): Promise<BotIdentity | null> {
  try {
    const res = await fetch(`${TELEGRAM_API}/bot${token}/getMe`);
    if (!res.ok) return null;
    const data = (await res.json()) as { ok?: boolean; result?: { id?: number; username?: string; first_name?: string } };
    if (!data.ok || !data.result?.id || !data.result?.first_name) return null;
    return {
      id: data.result.id,
      ...(data.result.username !== undefined ? { username: data.result.username } : {}),
      firstName: data.result.first_name,
    };
  } catch {
    return null;
  }
}

/** Shape of a single update entry from getUpdates we care about. */
interface UpdateEntry {
  message?: { chat?: { id?: number; type?: string; username?: string; first_name?: string } };
  edited_message?: { chat?: { id?: number; type?: string; username?: string; first_name?: string } };
}

/** Match for a chat that has DM'd the bot. */
export interface DiscoveredChat {
  chatId: number;
  type: string;
  username?: string;
  firstName?: string;
}

/**
 * Scan an array of update entries for chats. Exported and pure for testing.
 *
 * Returns the most recent chat per chatId, deduplicated. Order: most recent
 * first (assumes Telegram returns updates oldest-first, which is the API
 * contract).
 */
export function findChatIdInUpdates(updates: UpdateEntry[]): DiscoveredChat[] {
  const byId = new Map<number, DiscoveredChat>();
  for (const u of updates) {
    const msg = u.message ?? u.edited_message;
    const chat = msg?.chat;
    if (!chat || typeof chat.id !== 'number') continue;
    byId.set(chat.id, {
      chatId: chat.id,
      type: chat.type ?? 'unknown',
      ...(chat.username !== undefined ? { username: chat.username } : {}),
      ...(chat.first_name !== undefined ? { firstName: chat.first_name } : {}),
    });
  }
  // Reverse so most recent chats come first (Telegram returns oldest-first).
  return [...byId.values()].reverse();
}

/** Fetch raw updates for a bot. Returns empty array on any error. */
export async function fetchUpdates(token: string): Promise<UpdateEntry[]> {
  try {
    const res = await fetch(`${TELEGRAM_API}/bot${token}/getUpdates`);
    if (!res.ok) return [];
    const data = (await res.json()) as { ok?: boolean; result?: UpdateEntry[] };
    if (!data.ok || !Array.isArray(data.result)) return [];
    return data.result;
  } catch {
    return [];
  }
}

/**
 * Poll getUpdates up to `maxAttempts` times with `intervalMs` between calls,
 * stopping early once any chats are discovered. Returns the discovered chats
 * or an empty array on timeout.
 *
 * Intended for the interactive flow where the user DMs the bot after the
 * wizard prints instructions — we want responsive discovery without
 * hammering the API.
 */
export async function pollForChats(
  token: string,
  opts: { maxAttempts?: number; intervalMs?: number } = {},
): Promise<DiscoveredChat[]> {
  const maxAttempts = opts.maxAttempts ?? 30; // 30 * 2s = 60s default
  const intervalMs = opts.intervalMs ?? 2000;
  for (let i = 0; i < maxAttempts; i++) {
    const updates = await fetchUpdates(token);
    const chats = findChatIdInUpdates(updates);
    if (chats.length > 0) return chats;
    if (i < maxAttempts - 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  return [];
}

/** Prompt for stdin input. */
function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return withStdinClaim('telegram.setup-wizard', () =>
    new Promise<string>((resolve) => {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    }),
  );
}

/**
 * Prompt for a secret value without echoing characters to the terminal.
 *
 * Requires an interactive TTY — non-interactive callers must supply secrets
 * via environment variables (`TELEGRAM_BOT_TOKEN`) or the config file, not
 * stdin. Falling back to plain readline `prompt()` would echo every keystroke
 * to stdout, silently regressing the masking guarantee.
 */
function promptSecret(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    console.error(chalk.red(`Cannot securely prompt for secret on a non-TTY stdin: "${question.trim()}"`));
    console.error(chalk.gray('  Supply TELEGRAM_BOT_TOKEN via environment variable or ~/.afk/config/afk.env instead.'));
    process.exit(1);
  }
  return new Promise((resolve) => {
    process.stdout.write(question);
    const chars: string[] = [];
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf-8');
    const onData = (ch: string) => {
      if (ch === '\r' || ch === '\n' || ch === '\u0004' /* Ctrl-D */) {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(chars.join('').trim());
      } else if (ch === '\u0003' /* Ctrl-C */) {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write('\n');
        process.exit(1);
      } else if (ch === '\u007f' /* Backspace */) {
        chars.pop();
      } else {
        chars.push(ch);
      }
    };
    process.stdin.on('data', onData);
  });
}

/**
 * Run the full interactive setup wizard. Writes to `~/.afk/config/afk.env`.
 * Returns a summary suitable for printing.
 */
export async function runTelegramSetup(): Promise<{
  envPath: string;
  bot: BotIdentity;
  chatId: number;
}> {
  const envPath = getEnvConfigPath();
  console.log('');
  console.log(chalk.bold('🤖 Telegram bot setup'));
  console.log('');
  console.log(chalk.gray(`Config will be written to ${envPath}`));
  console.log('');

  // 1. Bot token: env first, then prompt.
  let token = env.TELEGRAM_BOT_TOKEN?.trim() ?? '';
  let bot: BotIdentity | null = null;

  if (token) {
    console.log(chalk.gray('Validating existing TELEGRAM_BOT_TOKEN...'));
    bot = await validateBotToken(token);
    if (bot) {
      console.log(chalk.green(`✓ Token valid for @${bot.username ?? bot.firstName} (id ${bot.id})`));
    } else {
      console.log(chalk.yellow('⚠ Existing TELEGRAM_BOT_TOKEN is invalid; prompting for a new one'));
      token = '';
    }
  }

  while (!bot) {
    token = await promptSecret('Paste your bot token (from @BotFather): ');
    if (!token) {
      console.error(chalk.red('No token provided. Aborting.'));
      process.exit(1);
    }
    bot = await validateBotToken(token);
    if (!bot) {
      console.log(chalk.red('✗ Token rejected by getMe. Try again or Ctrl-C to abort.'));
    }
  }

  upsertEnvVar(envPath, 'TELEGRAM_BOT_TOKEN', token);
  console.log(chalk.green(`✓ Saved TELEGRAM_BOT_TOKEN → ${envPath}`));
  console.log('');

  // 2. Chat ID: poll getUpdates.
  console.log(chalk.bold('Now DM your bot to authorize your account.'));
  const handle = bot.username ? `@${bot.username}` : `"${bot.firstName}"`;
  console.log(`  1. Open Telegram and find ${chalk.cyan(handle)}`);
  console.log(`  2. Send any message (e.g. "hi")`);
  console.log('');
  console.log(chalk.gray('Polling for your chat ID (up to 60s)...'));

  const chats = await pollForChats(token);
  if (chats.length === 0) {
    console.error(chalk.red('✗ No chats found after 60s.'));
    console.error(chalk.gray('  Send a message to the bot and run `afk telegram setup` again,'));
    console.error(chalk.gray('  or paste your chat ID manually:'));
    const manual = await prompt('Chat ID: ');
    const parsed = Number.parseInt(manual, 10);
    if (!Number.isFinite(parsed)) {
      console.error(chalk.red('Invalid chat ID. Aborting.'));
      process.exit(1);
    }
    upsertEnvVar(envPath, 'AFK_TELEGRAM_ALLOWED_CHAT_IDS', String(parsed));
    console.log(chalk.green(`✓ Saved AFK_TELEGRAM_ALLOWED_CHAT_IDS=${parsed}`));
    return { envPath, bot, chatId: parsed };
  }

  let pick = chats[0]!;
  if (chats.length > 1) {
    console.log(chalk.bold('\nMultiple chats found:'));
    chats.forEach((c, i) => {
      const who = c.username ? `@${c.username}` : c.firstName ?? c.type;
      console.log(`  [${i + 1}] ${who} (id ${c.chatId}, ${c.type})`);
    });
    const choice = await prompt('Which chat should be allowed? [1]: ');
    const idx = Number.parseInt(choice || '1', 10) - 1;
    if (Number.isFinite(idx) && idx >= 0 && idx < chats.length) {
      pick = chats[idx]!;
    }
  } else {
    const who = pick.username ? `@${pick.username}` : pick.firstName ?? pick.type;
    console.log(chalk.green(`✓ Found chat with ${who} (id ${pick.chatId})`));
  }

  upsertEnvVar(envPath, 'AFK_TELEGRAM_ALLOWED_CHAT_IDS', String(pick.chatId));
  console.log(chalk.green(`✓ Saved AFK_TELEGRAM_ALLOWED_CHAT_IDS=${pick.chatId} → ${envPath}`));
  console.log('');
  console.log(chalk.bold('Setup complete. Start the bot with:'));
  console.log(chalk.cyan('  afk telegram start'));
  console.log('');

  return { envPath, bot, chatId: pick.chatId };
}
