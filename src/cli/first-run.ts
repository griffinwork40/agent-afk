import type { Command } from 'commander';
import { config as loadEnv } from 'dotenv';
import { getEnvConfigPath } from '../paths.js';
import { loadConfig, loadCredential } from './config.js';
import { getModel } from './shared-helpers.js';
import { providerForModel } from '../agent/providers/index.js';
import { cliProviderFamily } from './provider-selection.js';
import { preloadClaudeKeychainOAuth } from '../agent/auth/credential-resolver.js';
import { runAuthWizard } from './auth-wizard.js';
import { resolveResumeTarget } from './resume-session.js';

const AUTH_GATED_COMMANDS = new Set(['chat', 'interactive', 'daemon', 'farm']);

/** Commander canonicalizes aliases and dispatches bare invocations to interactive. */
export function needsCredentialGate(command: Command): boolean {
  return AUTH_GATED_COMMANDS.has(command.name());
}

/** Runs after Commander parsing but before any command action side effects. */
export async function runFirstRunDetector(command: Command): Promise<void> {
  if (!needsCredentialGate(command)) return;
  // Install JSON + env slot bindings BEFORE routing. getModel() intentionally
  // remains the command default (AFK_MODEL > CLAUDE_MODEL > medium), not config.model.
  const config = loadConfig();
  const options = command.opts<{
    model?: string; provider?: string; resume?: string; continue?: boolean;
  }>();
  let model = options.model ?? String(getModel());
  if (command.name() === 'interactive') {
    model = resolveResumeTarget(options)?.stored?.model ?? model;
  }
  // chat's provider is currently built from options.model even for a resume;
  // mirror it here rather than silently changing that existing behavior.
  const provider = command.name() === 'chat' || command.name() === 'interactive'
    ? cliProviderFamily(options.provider, {
        model,
        ...(config.openaiBaseUrl !== undefined ? { openaiBaseUrl: config.openaiBaseUrl } : {}),
      })
    : providerForModel(model, {
        ...(config.openaiBaseUrl !== undefined ? { openaiBaseUrl: config.openaiBaseUrl } : {}),
      });
  // No gate-owned refresh, Anthropic credential lookup, or wizard for a
  // non-Anthropic route. loadConfig() retains its own default-model behavior;
  // missing credentials for the selected route remain provider-specific.
  if (provider !== 'anthropic-direct') return;
  const refreshedToken = await preloadClaudeKeychainOAuth(provider);
  const credential = refreshedToken ?? loadCredential();
  if (credential) return;
  if (!process.stdin.isTTY) {
    process.stderr.write('agent-afk: No Anthropic credential found. Run `afk login` to authenticate.\n');
    process.exit(1);
    return;
  }
  try {
    await runAuthWizard();
    loadEnv({ path: getEnvConfigPath(), override: true, quiet: true });
  } catch {
    // Preserve the existing wizard cancellation behavior: provider handles auth.
  }
}

/** Help/version/parse errors never reach preAction; utility actions are skipped. */
export function installCredentialGate(program: Command): void {
  program.hook('preAction', async (_root, actionCommand) => {
    await runFirstRunDetector(actionCommand);
  });
}
