/**
 * `afk provider` command group.
 *
 * Subcommands:
 *   - `afk provider auth diagnose` — report which OpenAI auth source the
 *     openai-compatible provider would resolve, never printing raw tokens.
 *
 * Lives under a `provider` group rather than top-level so future
 * per-provider diagnostics (Anthropic key health, model catalog probe, etc.)
 * have a natural home.
 *
 * @module cli/commands/provider
 */

import { Command } from 'commander';
import { palette } from '../palette.js';
import {
  resolveOpenAIAuth,
  formatAuthDiagnostic,
  type OpenAIAuthSource,
  type AuthResolverDeps,
} from '../../agent/providers/openai-compatible/auth.js';

/**
 * Build the human-readable result of `afk provider auth diagnose`. Pure
 * function so it's trivially testable. Caller writes to stdout.
 *
 * @param explicitConfigKey - `AgentConfig.apiKey` override, if any.
 * @param deps - Optional env + fs injection point (tests pass a hermetic stub
 *   to avoid reading real host credentials from `~/.codex/auth.json`).
 */
export function buildProviderAuthDiagnose(
  explicitConfigKey: string | undefined,
  deps?: AuthResolverDeps,
): { source: OpenAIAuthSource; message: string; exitCode: number; last4?: string } {
  const resolution = resolveOpenAIAuth(explicitConfigKey, deps);
  const message = formatAuthDiagnostic(resolution);
  // Exit nonzero when there's no usable auth so this can drive shell
  // scripts ("ensure OpenAI is configured before running").
  const exitCode = resolution.apiKey === null ? 1 : 0;
  const result: { source: OpenAIAuthSource; message: string; exitCode: number; last4?: string } = {
    source: resolution.source,
    message,
    exitCode,
  };
  if (resolution.last4 !== undefined) result.last4 = resolution.last4;
  return result;
}

export function registerProviderCommand(program: Command): void {
  const provider = program
    .command('provider')
    .description('Provider diagnostics and configuration');

  const auth = provider
    .command('auth')
    .description('Inspect provider auth state');

  auth
    .command('diagnose')
    .description(
      'Report which OpenAI auth source would be used by the openai-compatible provider. ' +
      'Never prints raw tokens.',
    )
    .option('-f, --format <format>', 'Output format (text|json)', 'text')
    .action((options: { format: string }) => {
      // Explicit config-key plumbing is intentionally not wired here yet —
      // `loadConfig().apiKey` would be the future source. For now, the
      // diagnose command reflects only env + Codex CLI auth, which covers
      // every real-world use case the openai-compatible provider supports.
      const result = buildProviderAuthDiagnose(undefined);

      if (options.format === 'json') {
        const payload: Record<string, unknown> = {
          source: result.source,
          message: result.message,
          ok: result.exitCode === 0,
        };
        if (result.last4 !== undefined) payload['last4'] = result.last4;
        console.log(JSON.stringify(payload, null, 2));
      } else {
        const icon =
          result.exitCode === 0 ? palette.success('✓') : palette.warning('⚠');
        console.log(`${icon} ${result.message}`);
      }
      process.exit(result.exitCode);
    });
}
