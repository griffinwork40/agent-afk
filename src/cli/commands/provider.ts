/**
 * `afk provider` command group.
 *
 * Subcommands:
 *   - `afk provider auth diagnose` — OpenAI + xAI auth sources (never raw tokens)
 *   - `afk provider auth xai login|logout` — SuperGrok / SuperGrok Heavy / X Premium+
 *
 * @module cli/commands/provider
 */

import { spawn } from 'node:child_process';
import { Command } from 'commander';
import { palette } from '../palette.js';
import {
  resolveOpenAIAuth,
  formatAuthDiagnostic,
  type OpenAIAuthSource,
  type AuthResolverDeps,
} from '../../agent/providers/openai-compatible/auth.js';
import {
  resolveXaiAuth,
  formatXaiAuthDiagnostic,
  type XaiAuthSource,
  type XaiAuthResolverDeps,
} from '../../agent/providers/xai/auth.js';
import {
  runXaiBrowserLogin,
  runXaiDeviceCodeLogin,
  runXaiLogout,
} from './provider-xai-login.js';
import { resolveBinding } from '../../agent/session/model-slots.js';

/**
 * Build the human-readable result of `afk provider auth diagnose` (OpenAI).
 *
 * @param explicitConfigKey - Explicit API key from AgentConfig, if any.
 * @param deps - Optional env + fs injection point for tests.
 * @param forceChatgptOAuth - When true (resolved from a `chatgpt-oauth` slot
 *   via `--model`/`--slot`), threads the flag through to `resolveOpenAIAuth`
 *   so the diagnose output reflects what the slot-bound session actually sees.
 */
export function buildProviderAuthDiagnose(
  explicitConfigKey: string | undefined,
  deps?: AuthResolverDeps,
  forceChatgptOAuth = false,
): { source: OpenAIAuthSource; message: string; exitCode: number; last4?: string } {
  const resolution = resolveOpenAIAuth(explicitConfigKey, deps, forceChatgptOAuth);
  const message = formatAuthDiagnostic(resolution);
  const exitCode = resolution.apiKey === null ? 1 : 0;
  const result: { source: OpenAIAuthSource; message: string; exitCode: number; last4?: string } = {
    source: resolution.source,
    message,
    exitCode,
  };
  if (resolution.last4 !== undefined) result.last4 = resolution.last4;
  return result;
}

/**
 * Build the xAI half of `afk provider auth diagnose`.
 */
export function buildXaiAuthDiagnose(
  explicitConfigKey: string | undefined,
  forceMode?: 'apikey' | 'oauth',
  deps?: XaiAuthResolverDeps,
): { source: XaiAuthSource; message: string; exitCode: number; last4?: string; mode?: string } {
  const resolution = resolveXaiAuth(explicitConfigKey, forceMode, deps);
  const message = formatXaiAuthDiagnostic(resolution);
  const exitCode = resolution.apiKey === null ? 1 : 0;
  const result: {
    source: XaiAuthSource;
    message: string;
    exitCode: number;
    last4?: string;
    mode?: string;
  } = {
    source: resolution.source,
    message,
    exitCode,
  };
  if (resolution.last4 !== undefined) result.last4 = resolution.last4;
  if (resolution.mode !== undefined) result.mode = resolution.mode;
  return result;
}

export function registerProviderCommand(program: Command): void {
  const provider = program
    .command('provider')
    .description('Provider diagnostics and configuration');

  const auth = provider
    .command('auth')
    .description('Inspect and manage provider auth state');

  auth
    .command('diagnose')
    .description(
      'Report OpenAI and xAI auth sources. Never prints raw tokens.',
    )
    .option('-f, --format <format>', 'Output format (text|json)', 'text')
    .option(
      '--family <family>',
      'Exit-code family: openai (default, back-compat), xai, or any',
      'openai',
    )
    .option(
      '-m, --model <model>',
      'Resolve auth as if running with this model slot (e.g. small, medium, large, or a custom name). ' +
        'When the slot is bound to provider: chatgpt-oauth, the diagnose uses the forced-OAuth path.',
    )
    .option(
      '--slot <slot>',
      'Alias for --model: resolve auth for the named slot binding.',
    )
    .action((options: { format: string; family: string; model?: string; slot?: string }) => {
      // Resolve per-slot flags from --model / --slot so the diagnose reflects
      // what the session actually sees for that binding.
      const modelInput = options.model ?? options.slot;
      const slotBinding = modelInput ? resolveBinding(modelInput) : undefined;
      const forceChatgptOAuth = slotBinding?.provider === 'chatgpt-oauth';

      const openai = buildProviderAuthDiagnose(undefined, undefined, forceChatgptOAuth);
      const xai = buildXaiAuthDiagnose(undefined);
      const family = options.family.trim().toLowerCase();

      if (options.format === 'json') {
        // Top-level OpenAI fields preserved for scripts that predate the xAI
        // section; nested openai/xai blocks are additive.
        console.log(
          JSON.stringify(
            {
              source: openai.source,
              message: openai.message,
              ok: openai.exitCode === 0,
              ...(openai.last4 !== undefined ? { last4: openai.last4 } : {}),
              openai: {
                source: openai.source,
                message: openai.message,
                ok: openai.exitCode === 0,
                ...(openai.last4 !== undefined ? { last4: openai.last4 } : {}),
              },
              xai: {
                source: xai.source,
                message: xai.message,
                ok: xai.exitCode === 0,
                ...(xai.last4 !== undefined ? { last4: xai.last4 } : {}),
                ...(xai.mode !== undefined ? { mode: xai.mode } : {}),
              },
            },
            null,
            2,
          ),
        );
      } else {
        const oIcon = openai.exitCode === 0 ? palette.success('✓') : palette.warning('⚠');
        const xIcon = xai.exitCode === 0 ? palette.success('✓') : palette.warning('⚠');
        console.log(`${oIcon} OpenAI: ${openai.message}`);
        console.log(`${xIcon} xAI:    ${xai.message}`);
      }
      // Default exit tracks OpenAI only (historical contract). Use
      // --family xai|any to gate on SuperGrok or either family.
      const exitCode =
        family === 'xai'
          ? xai.exitCode
          : family === 'any'
            ? openai.exitCode === 0 || xai.exitCode === 0
              ? 0
              : 1
            : openai.exitCode;
      process.exit(exitCode);
    });

  const xai = auth
    .command('xai')
    .description('SuperGrok / SuperGrok Heavy / X Premium+ OAuth for Grok models');

  xai
    .command('login')
    .description(
      'Sign in with SuperGrok / SuperGrok Heavy / X Premium+ (device-code by default)',
    )
    .option('--device-code', 'Use RFC 8628 device-code flow (default)', false)
    .option('--browser', 'Use browser PKCE loopback on 127.0.0.1:56121', false)
    .action(async (options: { deviceCode?: boolean; browser?: boolean }) => {
      try {
        const useBrowser = options.browser === true && options.deviceCode !== true;
        const result = useBrowser
          ? await runXaiBrowserLogin({
              onStatus: (line) => console.log(line),
              openBrowser: (url) => {
                // Best-effort open; device-code remains the supported headless path.
                try {
                  const cmd =
                    process.platform === 'darwin'
                      ? 'open'
                      : process.platform === 'win32'
                        ? 'cmd'
                        : 'xdg-open';
                  const args =
                    process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
                  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
                } catch {
                  /* user can open the printed URL */
                }
              },
            })
          : await runXaiDeviceCodeLogin({
              onStatus: (line) => console.log(line),
            });
        if (result.ok) {
          console.log(palette.success(`✓ ${result.message}`));
          if (result.last4) console.log(palette.meta(`  token …${result.last4}`));
          process.exit(0);
        }
        console.error(palette.error(`✗ ${result.message}`));
        process.exit(1);
      } catch (e) {
        console.error(palette.error(`✗ ${e instanceof Error ? e.message : String(e)}`));
        process.exit(1);
      }
    });

  xai
    .command('logout')
    .description('Clear stored SuperGrok / SuperGrok Heavy / X Premium+ OAuth tokens')
    .action(() => {
      const result = runXaiLogout();
      console.log(palette.success(`✓ ${result.message}`));
      process.exit(0);
    });
}
