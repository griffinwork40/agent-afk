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
import { palette } from '../cli/palette.js';
import { TelegramBot } from './bot.js';
import { parseAllowedChatIds } from './allowlist.js';
import { validateBotToken } from './setup-wizard.js';
import { MemoryStore } from '../agent/memory/index.js';
import { StateStore } from '../agent/state/state-store.js';
import { providerForModel } from '../agent/providers/index.js';
import { loadConfig, loadTelegramConfig, getOperatorPermissionMode } from '../cli/config.js';
import { getEnvConfigPath, getStateDatabasePath } from '../paths.js';
import { loadSystemPrompt, getThinking, getEffort } from '../cli/shared-helpers.js';
import type { AgentModelInput } from '../agent/types.js';
import { applyTelegramFileOverrides } from './env-file-overrides.js';
import { planTelegramCredential, applyTelegramCredentialPlan } from './credentials.js';
import { preloadClaudeKeychainOAuth, loadAnthropicCredential } from '../agent/auth/credential-resolver.js';
import { readDiskVersion, UNKNOWN_VERSION } from './daemon-version.js';
import { createTelegramSessionFactory } from './create-session.js';
import { announceTelegramStartup } from './entry.startup.js';
import { startStatsTicker } from './stats-ticker.js';
import { pushIfConfigured } from './push.js';
import { installCrashNotifier } from '../utils/crash-notifier.js';
import { errorMessage } from '../utils/errors.js';
import { createTranscriber } from './audio-transcriber.js';
import { checkEgressTarget } from '../http-client/egress-guard.js';

/**
 * Crash-notification handler for the Telegram bot process.
 *
 * Delegates to the shared `installCrashNotifier` helper in `src/utils/`.
 * The label `"telegram"` distinguishes bot crashes from daemon crashes in
 * the push message. Re-entry safety and rate-limiting are owned by the helper.
 *
 * Exported for testing only — callers should use `main()`.
 */

/** Module-scoped handle returned by installCrashNotifier; holds the reset fn. */
let _crashHandle: { reset: () => void } | undefined;

/**
 * Reset the re-entry guard. Exported for testing only — do not call in
 * production code.
 *
 * @internal
 */
export function _resetCrashHandlersForTest(): void {
  _crashHandle?.reset();
  _crashHandle = undefined;
}

export function installCrashHandlers(): void {
  if (_crashHandle !== undefined) return;
  _crashHandle = installCrashNotifier('telegram', pushIfConfigured);
}

/**
 * Build a transcriber from the typed env object, or return null when
 * AFK_TRANSCRIBE_API_URL is unset (opt-in; no silent paid calls by default).
 * Extracted from main() to keep that function within the 200-line ceiling.
 */
function resolveTranscriber(e: typeof env): ReturnType<typeof createTranscriber> {
  return createTranscriber(e, { checkEgress: checkEgressTarget });
}

/**
 * Construct the TelegramBot instance from resolved config and shared stores.
 * Extracted from main() to keep that function within the 200-line ceiling.
 * All dependencies are passed explicitly — no closure over main() locals.
 */
function buildBot(params: {
  botToken: string;
  config: ReturnType<typeof loadConfig>;
  frameworkBase: string | undefined;
  allowedChatIds: Set<number>;
  tagOnlyChats: Set<number>;
  sharedMemoryStore: MemoryStore;
  sharedStateStore: StateStore;
}): TelegramBot {
  const { botToken, config, frameworkBase, allowedChatIds, tagOnlyChats, sharedMemoryStore, sharedStateStore } = params;
  const telegramCwd = env.AFK_TELEGRAM_CWD;
  const idleSessionMsRaw = env.AFK_TELEGRAM_SESSION_IDLE_MS;
  const idleSessionMs = idleSessionMsRaw !== undefined ? parseInt(idleSessionMsRaw, 10) : undefined;
  const opMode = getOperatorPermissionMode();
  return new TelegramBot({
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
    // Thread AFK_THINKING / AFK_EFFORT into every bot-spawned session so the
    // Telegram surface honours these env vars just like chat, daemon, and REPL.
    thinking: getThinking(),
    effort: getEffort(),
    // Bot-global cwd fallback used by SessionManager when no per-chat
    // override is set via /cd. Per-session `data.cwd` takes precedence.
    ...(telegramCwd !== undefined && telegramCwd.length > 0 ? { botCwd: telegramCwd } : {}),
    ...(idleSessionMs !== undefined && !isNaN(idleSessionMs) && idleSessionMs > 0 ? { idleSessionMs } : {}),
    transcriber: resolveTranscriber(env),
    // Forward permissionMode only when the operator explicitly set it in afk.config.json.
    // loadConfig() always fills in DEFAULT_CLI_PERMISSION_MODE, so checking config.permissionMode
    // would unconditionally forward bypassPermissions into Telegram session metadata (#3969).
    ...(opMode !== undefined ? { permissionMode: opMode } : {}),
    createSession: createTelegramSessionFactory({
      config,
      frameworkBase,
      telegramCwd,
      memoryStore: sharedMemoryStore,
      stateStore: sharedStateStore,
    }),
  });
}

/**
 * Resolve the tag-only chat set from config + env, and log a notice when it
 * is non-empty. Extracted from main() to keep that function within the
 * 200-line ceiling.
 *
 * afk.config.json `telegram.tagOnlyChats` wins; the
 * AFK_TELEGRAM_TAG_ONLY_CHAT_IDS env var is the fallback. Mirrors the inbound
 * allowlist resolution path.
 */
function resolveTagOnlyChats(
  configTagOnly: number[] | undefined,
  envVar: string | undefined,
): Set<number> {
  const tagOnlyChats =
    configTagOnly && configTagOnly.length > 0
      ? new Set<number>(configTagOnly)
      : parseAllowedChatIds(envVar, console.warn);
  if (tagOnlyChats.size > 0) {
    console.log(palette.info(`🏷️  Tag-only chats: ${tagOnlyChats.size} chat ID(s) — bot responds only when addressed (reply/@mention)`));
    console.log(palette.warning('   ⚠️  Set Telegram privacy mode OFF for this bot (@BotFather → /setprivacy → Disable) or non-addressed group messages never reach it.'));
  }
  return tagOnlyChats;
}

export async function main(): Promise<void> {
  // Version the daemon is running as, captured once. Compared against the
  // on-disk version each tick by the drift watchdog.
  const daemonVersion = readDiskVersion();
  if (daemonVersion === UNKNOWN_VERSION) {
    console.warn(palette.warning('⚠️ [daemon] Could not read package.json at startup — version drift check disabled.'));
  }

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    console.error(palette.error('❌ Configuration error: ' + errorMessage(error)));
    process.exit(1);
  }

  // Framework base prompt (`system-prompt.md`, inlined at publish-build).
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
  // `loadAnthropicCredential` already incorporates the refreshed token as its
  // final tier, so no explicit fallback is needed here.
  await preloadClaudeKeychainOAuth(providerName);
  const credentialPlan = planTelegramCredential(providerName, {
    loadAnthropicCredential,
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
    console.error(palette.error('❌ Error: TELEGRAM_BOT_TOKEN environment variable is required'));
    console.error(palette.error('\nHow to get a bot token:'));
    console.error(palette.error('  1. Open Telegram and search for @BotFather'));
    console.error(palette.error('  2. Send /newbot and follow the instructions'));
    console.error(palette.error('  3. Run: afk telegram setup'));
    process.exit(1);
  }

  const allowedChatIds = parseAllowedChatIds(
    env.AFK_TELEGRAM_ALLOWED_CHAT_IDS,
    console.warn
  );
  if (allowedChatIds.size === 0) {
    console.error(palette.error('❌ Error: AFK_TELEGRAM_ALLOWED_CHAT_IDS must list at least one chat ID'));
    console.error(palette.error('\nThis is an allowlist that gates who can message the bot.'));
    console.error(palette.error('Run `afk telegram setup` to set it interactively, or set it manually:'));
    console.error(palette.error('  AFK_TELEGRAM_ALLOWED_CHAT_IDS=123456789,-100987654321'));
    process.exit(1);
  }

  // Validate the token via getMe BEFORE handing it to Telegraf. This
  // catches: revoked tokens, typo'd tokens, network issues, and most
  // importantly surfaces the *resolved bot identity* so the operator
  // sees which bot they're actually running — the single most useful
  // piece of operational data, hidden behind DEBUG=telegraf:* otherwise.
  console.log(palette.info('🔎 Validating bot token...'));
  const identity = await validateBotToken(botToken);
  if (!identity) {
    console.error(palette.error('❌ Error: TELEGRAM_BOT_TOKEN was rejected by Telegram (getMe failed)'));
    console.error(palette.error('   The token may be revoked, malformed, or your network may be unreachable.'));
    console.error(palette.error('   Re-run `afk telegram setup` to refresh it.'));
    process.exit(1);
  }
  const handle = identity.username ? `@${identity.username}` : identity.firstName;

  console.log(''); // console-ok
  console.log(palette.info(`🤖 Starting Agent AFK Telegram Bot as ${handle} (id ${identity.id})`));
  console.log(palette.info(`📡 Model: ${config.model} · Provider: ${providerName}`));
  console.log(palette.info(`🔒 Allowlist: ${allowedChatIds.size} chat ID(s)`));

  // Opt-in "tag-only" response policy — see resolveTagOnlyChats() for details.
  const tagOnlyChats = resolveTagOnlyChats(
    loadTelegramConfig().tagOnlyChats,
    env.AFK_TELEGRAM_TAG_ONLY_CHAT_IDS,
  );

  const sharedMemoryStore = new MemoryStore();
  const sharedStateStore = new StateStore(getStateDatabasePath());

  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const bot = buildBot({ botToken, config: config!, frameworkBase, allowedChatIds, tagOnlyChats, sharedMemoryStore, sharedStateStore });

  // Elicitation wiring (path-approval + ask_question) is installed inside
  // `bot.start()` via composeTelegramElicitation — a SINGLE composed handler,
  // so the two systems no longer clobber each other on `elicitationRouter
  // .install` (PR #477 review B1/B2). See `TelegramBot.start()`.
  const statsInterval = startStatsTicker({ bot, spawnedVersion: daemonVersion });

  let stopping = false;
  let shutdownPromise: Promise<void> | undefined;

  const shutdown = async (exitCode: number) => {
    if (stopping) return;
    stopping = true;
    console.log(palette.dim('\n\n🛑 Shutting down bot...'));
    clearInterval(statsInterval);
    try {
      await bot.stop();
    } finally {
      // Guard store closes independently so a bot.stop() rejection does not
      // skip them (finding #4: store close in its own try/finally).
      try { sharedMemoryStore.close(); } catch { /* best-effort */ }
      try { sharedStateStore.close(); } catch { /* best-effort */ }
    }
    console.log(palette.success('✅ Bot stopped.'));
    // Signal listeners are removed before exit so this finally path is
    // reachable and the removeListener calls in main()'s finally are live
    // (finding #1: process.exit moved after cleanup).
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    process.exit(exitCode);
  };
  // ??= ensures a concurrent second signal never overwrites shutdownPromise.
  // shutdown() returns a Promise<void> (async always does), but the stopping
  // guard makes it resolve immediately on re-entry — ??= keeps the original
  // pending promise so `await shutdownPromise` in finally waits for cleanup.
  // The ??= also means shutdown(1) called from the catch block below does NOT
  // overwrite a concurrent signal-triggered shutdown(0) (finding #8: non-obvious
  // but correct — shutdown(1) is called directly, bypassing ??=, so the exit
  // code from the first shutdown always wins; onSignal is the ??= path only).
  const onSignal = () => { shutdownPromise ??= shutdown(0); };

  installCrashHandlers();

  // Invariant: handlers registered BEFORE bot.start() so a signal arriving
  // during async startup still runs a clean shutdown. process.on (not once)
  // keeps the listener alive for a repeated signal during pending teardown;
  // both are removed in finally after shutdown completes.
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  let started = false;
  try {
    const { polling } = await bot.start();
    if (stopping) return;
    started = true;
    announceTelegramStartup(daemonVersion);
    await polling;
    if (!stopping) throw new Error('Telegram polling stopped unexpectedly');
  } catch (error) {
    if (stopping) return;
    const message = started ? 'Telegram polling failed: ' : 'Failed to start bot: ';
    // Scrub any embedded bot token from the error string before logging
    // (defense-in-depth — Telegraf scrubs internally, but error.message may
    // carry a URL with the token; finding #2: token scrub on startup error path).
    const safeError = String(error).replace(/\/bot[^/]+\//g, '/bot[REDACTED]/');
    console.error(palette.error('❌ ' + message + safeError));
    await shutdown(1);
  } finally {
    // shutdown() now removes the listeners itself before process.exit(), so
    // these calls are a belt-and-suspenders guard for the non-shutdown exit
    // path (polling ended cleanly without stopping=true, which throws above).
    // They are intentionally kept here so coverage is complete regardless of
    // which code path exits (finding #1: removeListener now reachable).
    await shutdownPromise;
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}
