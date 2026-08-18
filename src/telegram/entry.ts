/**
 * Telegram bot entrypoint orchestration.
 *
 * Extracted from `src/telegram.ts`, which is now a thin shim. The split exists
 * so this module — and everything it calls — can be imported by tests WITHOUT
 * triggering a `main()` call at module load. `version-check.ts` records the
 * same rationale for its own extraction; this generalizes it to the whole
 * entrypoint.
 *
 * Invariant: `main()` is exported but NOT invoked here. Only `src/telegram.ts`
 * invokes it. Adding a call at this module's top level would reintroduce the
 * import side effect the split removed.
 *
 * Usage:
 * 1. Set TELEGRAM_BOT_TOKEN in .env (get from @BotFather).
 * 2. Either set ANTHROPIC_API_KEY/CLAUDE_CODE_OAUTH_TOKEN in the env, or
 *    sign in once with `afk login` / `claude setup-token`.
 * 3. Set AFK_TELEGRAM_ALLOWED_CHAT_IDS to your numeric chat ID.
 * 4. Run: npm run telegram
 */

import { env } from '../config/env.js';
import { TelegramBot } from './bot.js';
import { parseAllowedChatIds } from './allowlist.js';
import { validateBotToken } from './setup-wizard.js';
import { MemoryStore } from '../agent/memory/index.js';
import { providerForModel } from '../agent/providers/index.js';
import { loadConfig, loadTelegramConfig } from '../cli/config.js';
import { getEnvConfigPath } from '../paths.js';
import { loadSystemPrompt } from '../cli/shared-helpers.js';
import type { AgentModelInput } from '../agent/types.js';
import { applyTelegramFileOverrides } from './env-file-overrides.js';
import { planTelegramCredential, applyTelegramCredentialPlan } from './credentials.js';
import { preloadClaudeKeychainOAuth } from '../agent/auth/credential-resolver.js';
import { loadCredential } from '../cli/config.js';
import { readDiskVersion, UNKNOWN_VERSION } from './daemon-version.js';
import { createTelegramSessionFactory } from './create-session.js';
import { startStatsTicker } from './stats-ticker.js';

export async function main(): Promise<void> {
  // Version the daemon is running as, captured once. Compared against the
  // on-disk version each tick by the drift watchdog.
  const daemonVersion = readDiskVersion();
  if (daemonVersion === UNKNOWN_VERSION) {
    console.warn('⚠️ [daemon] Could not read package.json at startup — version drift check disabled.');
  }

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    console.error('❌ Configuration error:', (error as Error).message);
    process.exit(1);
  }

  // Framework base prompt (`prompts/system-prompt.md`, inlined at publish-build).
  // Resolved once here and layered under the operator overlay per session,
  // so Telegram sessions carry the same unconditional base as chat / REPL.
  const frameworkBase = loadSystemPrompt();

  const providerName = providerForModel(config.model as string);
  // Refresh a near-expiry / expired keychain OAuth token before the sync
  // credential read below. Guarded internally to the keychain-OAuth case, so it
  // is a no-op for OpenAI/xAI/env-var telegram bots. The returned token is a
  // fallback for when the OAuth exchange succeeded but the write-back to the
  // store failed (locked / read-only) — without it, planTelegramCredential
  // would re-read the still-expired store and report missing credentials.
  const refreshedToken = await preloadClaudeKeychainOAuth(providerName);
  const credentialPlan = planTelegramCredential(providerName, {
    loadAnthropicCredential: () => loadCredential() ?? refreshedToken,
  });
  if (!applyTelegramCredentialPlan(credentialPlan, config)) {
    process.exit(1);
  }

  // Telegram-specific config (TELEGRAM_BOT_TOKEN, AFK_TELEGRAM_ALLOWED_CHAT_IDS,
  // TELEGRAM_VERBOSE, TELEGRAM_DATA_DIR) treats the user-scope config file as
  // authoritative when present, overriding any matching shell env var — see
  // env-file-overrides.ts for why this inverts dotenv's precedence.
  applyTelegramFileOverrides(getEnvConfigPath());

  const botToken = env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    console.error('❌ Error: TELEGRAM_BOT_TOKEN environment variable is required');
    console.error('\nHow to get a bot token:');
    console.error('  1. Open Telegram and search for @BotFather');
    console.error('  2. Send /newbot and follow the instructions');
    console.error('  3. Run: afk telegram setup');
    process.exit(1);
  }

  const allowedChatIds = parseAllowedChatIds(
    env.AFK_TELEGRAM_ALLOWED_CHAT_IDS,
    console.warn
  );
  if (allowedChatIds.size === 0) {
    console.error('❌ Error: AFK_TELEGRAM_ALLOWED_CHAT_IDS must list at least one chat ID');
    console.error('\nThis is an allowlist that gates who can message the bot.');
    console.error('Run `afk telegram setup` to set it interactively, or set it manually:');
    console.error('  AFK_TELEGRAM_ALLOWED_CHAT_IDS=123456789,-100987654321');
    process.exit(1);
  }

  // Validate the token via getMe BEFORE handing it to Telegraf. This
  // catches: revoked tokens, typo'd tokens, network issues, and most
  // importantly surfaces the *resolved bot identity* so the operator
  // sees which bot they're actually running — the single most useful
  // piece of operational data, hidden behind DEBUG=telegraf:* otherwise.
  console.log('🔎 Validating bot token...');
  const identity = await validateBotToken(botToken);
  if (!identity) {
    console.error('❌ Error: TELEGRAM_BOT_TOKEN was rejected by Telegram (getMe failed)');
    console.error('   The token may be revoked, malformed, or your network may be unreachable.');
    console.error('   Re-run `afk telegram setup` to refresh it.');
    process.exit(1);
  }
  const handle = identity.username ? `@${identity.username}` : identity.firstName;

  console.log('');
  console.log(`🤖 Starting Agent AFK Telegram Bot as ${handle} (id ${identity.id})`);
  console.log(`📡 Model: ${config.model} · Provider: ${providerName}`);
  console.log(`🔒 Allowlist: ${allowedChatIds.size} chat ID(s)`);

  // Opt-in "tag-only" response policy: chats where the bot answers only when
  // addressed (reply to the bot, @mention, or text_mention resolving to the
  // bot). afk.config.json `telegram.tagOnlyChats` wins; the
  // AFK_TELEGRAM_TAG_ONLY_CHAT_IDS env var is the fallback. Mirrors the inbound
  // allowlist resolution path.
  const configTagOnly = loadTelegramConfig().tagOnlyChats;
  const tagOnlyChats =
    configTagOnly && configTagOnly.length > 0
      ? new Set<number>(configTagOnly)
      : parseAllowedChatIds(env.AFK_TELEGRAM_TAG_ONLY_CHAT_IDS, console.warn);
  if (tagOnlyChats.size > 0) {
    console.log(`🏷️  Tag-only chats: ${tagOnlyChats.size} chat ID(s) — bot responds only when addressed (reply/@mention)`);
    console.log('   ⚠️  Set Telegram privacy mode OFF for this bot (@BotFather → /setprivacy → Disable) or non-addressed group messages never reach it.');
  }

  const sharedMemoryStore = new MemoryStore();

  // Optional working-directory override for every bot-spawned session.
  // When set, all per-chat AgentSessions (and their forked subagents)
  // operate in this directory rather than the bot process's
  // `process.cwd()`. Use this to point the bot at a specific repo or
  // worktree without changing cwd before launch.
  const telegramCwd = env.AFK_TELEGRAM_CWD;

  const bot = new TelegramBot({
    botToken,
    apiKey: config.apiKey ?? '',
    dataDir: env.TELEGRAM_DATA_DIR || './data/telegram-sessions',
    defaultModel: config.model as AgentModelInput,
    verbose: ['1', 'true', 'yes', 'on'].includes((env.TELEGRAM_VERBOSE ?? '').trim().toLowerCase()),
    allowedChatIds,
    tagOnlyChats,
    // Only meaningful for the Anthropic provider — the Codex adapter
    // ignores settingSources at construction time.
    settingSources: ['user', 'project'],
    // Bot-global cwd fallback used by SessionManager when no per-chat
    // override is set via /cd. Per-session `data.cwd` takes precedence.
    ...(telegramCwd !== undefined && telegramCwd.length > 0
      ? { botCwd: telegramCwd }
      : {}),
    createSession: createTelegramSessionFactory({
      config,
      frameworkBase,
      telegramCwd,
      memoryStore: sharedMemoryStore,
    }),
  });

  // Elicitation wiring (path-approval + ask_question) is installed inside
  // `bot.start()` via composeTelegramElicitation — a SINGLE composed handler,
  // so the two systems no longer clobber each other on `elicitationRouter
  // .install` (PR #477 review B1/B2). See `TelegramBot.start()`.
  const statsInterval = startStatsTicker({ bot, spawnedVersion: daemonVersion });

  const shutdown = async () => {
    console.log('\n\n🛑 Shutting down bot...');
    clearInterval(statsInterval);
    await bot.stop();
    sharedMemoryStore.close();
    console.log('✅ Bot stopped.');
    process.exit(0);
  };

  // Invariant: signal handlers are registered BEFORE bot.start() so a
  // SIGTERM arriving during async startup still runs a clean shutdown.
  // Use `once` — shutdown calls process.exit, so a second invocation
  // is impossible and `on` would only risk stacking handlers.
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  try {
    await bot.start();

    console.log('✅ Bot started successfully!');
    console.log('\n📝 Slash commands (Agent SDK):');
    console.log('  /start   - Welcome and command list');
    console.log('  /help    - Show command list');
    console.log('  /clear   - Clear conversation history');
    console.log('  /compact - Compact history (summarize older messages)');
    console.log('  /model   - Switch model (opus/sonnet/haiku/gpt-5.4/...)');
    console.log('\n💬 Send any message to chat with the agent.');
    console.log('\n⏹️  Press Ctrl+C to stop the bot.');

  } catch (error) {
    clearInterval(statsInterval);
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
    console.error('❌ Failed to start bot:', error);
    process.exit(1);
  }
}
