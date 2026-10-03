/**
 * `afk usage` — read-only usage visibility subcommand.
 *
 * Reads the cross-process usage ledger (every AFK process on this machine
 * publishes into it) plus a fresh Claude OAuth usage-endpoint read, then
 * renders per provider/account: per-minute headroom, active 429 freeze,
 * 5h / 7d (and model-scoped 7d) utilization with reset countdowns, and
 * data age. Providers with a credential but no signal (Codex subscription,
 * xAI) are listed as `unknown`.
 *
 * All reading/formatting is shared with `get_runtime_state`, the fan-out
 * notice, and the daemon gate (`agent/usage/*`); this file only gathers
 * credentials and renders.
 *
 * @module cli/commands/usage
 */

import type { Command } from 'commander';
import { collectUsage, ANTHROPIC_OAUTH } from '../../agent/usage/usage-snapshot.js';
import {
  errorProviderSummary,
  summarizeUsageRecord,
  unknownProviderSummary,
  usageRows,
  type ProviderUsageSummary,
  type UsageSummary,
} from '../../agent/usage/usage-formatter.js';
import { loadAnthropicCredential, loadXaiApiKey } from '../../agent/auth/credential-resolver.js';
import { getCodexApiKey } from '../shared-helpers.js';
import { resolveOpenAIAuth, type OpenAIAuthResolution } from '../../agent/providers/openai-compatible/auth.js';
import { statusPanel } from '../render.js';
import type { StatusKind, StatusRow } from '../render/status-panel.js';
import { handleCommandError } from '../errors/index.js';

/** Credential probes behind the `unknown` placeholders; injectable for tests. */
export interface UsageCredentialProbes {
  /** Forced ChatGPT-subscription resolution (same probe as model-availability's `chatgpt-oauth` slot). */
  readonly chatgpt: () => Pick<OpenAIAuthResolution, 'source'>;
  readonly openaiApiKey: () => string | undefined;
}

const DEFAULT_PROBES: UsageCredentialProbes = {
  // Invariant: resolve lazily. Reading an imported binding at module eval
  // breaks every test that partially mocks `shared-helpers.js` (cli/index.ts
  // imports this module transitively).
  chatgpt: () => resolveOpenAIAuth(undefined, {}, true),
  openaiApiKey: () => getCodexApiKey(),
};

/** Build the summary: ledger + endpoint records, then credential-only placeholders. */
export async function collectUsageSummary(
  now: number = Date.now(),
  probes: UsageCredentialProbes = DEFAULT_PROBES,
): Promise<UsageSummary> {
  const { records, anthropic } = await collectUsage({ now });
  const providers: ProviderUsageSummary[] = records.map((r) => summarizeUsageRecord(r, now));
  const has = (provider: string): boolean => providers.some((p) => p.provider === provider);

  if (!has('anthropic') && loadAnthropicCredential()) {
    providers.push(
      anthropic.kind === 'unavailable' && anthropic.reason !== 'no-token'
        ? errorProviderSummary(ANTHROPIC_OAUTH.provider, ANTHROPIC_OAUTH.account, anthropic.detail)
        : unknownProviderSummary(ANTHROPIC_OAUTH.provider, ANTHROPIC_OAUTH.account),
    );
  }
  // Codex subscription traffic (~/.codex/auth.json sign-in) goes to the ChatGPT
  // backend, which emits no rate-limit headers — usage is genuinely unknown,
  // not zero. An OpenAI API key is a different account with its own headers;
  // it is only a placeholder until its first response lands in the ledger.
  const chatgpt = probes.chatgpt().source;
  if (chatgpt === 'chatgpt-oauth' || chatgpt === 'chatgpt-oauth-expired') {
    providers.push(unknownProviderSummary('codex', 'chatgpt-subscription'));
  }
  if (probes.openaiApiKey() && !has('openai')) providers.push(unknownProviderSummary('openai', 'api-key'));
  if (loadXaiApiKey()) providers.push(unknownProviderSummary('xai', 'api-key'));
  if (providers.length === 0) providers.push(unknownProviderSummary(ANTHROPIC_OAUTH.provider, ANTHROPIC_OAUTH.account));
  return { asOfMs: now, providers };
}

const KIND: Record<NonNullable<ReturnType<typeof usageRows>[number]['level']>, StatusKind> = {
  ok: 'ok',
  warn: 'warn',
  over: 'error',
  info: 'info',
};

function panelRows(summary: UsageSummary): StatusRow[] {
  return summary.providers.flatMap((p) => {
    const headerKind: StatusKind =
      p.status === 'ok' ? 'ok' : p.status === 'stale' ? 'warn' : p.status === 'error' ? 'error' : 'info';
    const header: StatusRow = { label: `${p.provider} / ${p.account}`, value: p.status, kind: headerKind };
    const rows = usageRows(p).map((r): StatusRow => ({ label: `  ${r.label}`, value: r.value, kind: KIND[r.level ?? 'info'] }));
    return [header, ...rows];
  });
}

export function registerUsageCommand(program: Command): void {
  program
    .command('usage')
    .description('Show API usage per provider/account: per-minute headroom, 429 freezes, 5h/7d windows, data age')
    .option('--json', 'Output machine-readable JSON and exit')
    .action(async (options: { json?: boolean }) => {
      try {
        const summary = await collectUsageSummary();
        if (options.json) {
          console.log(JSON.stringify(summary, null, 2));
          return;
        }
        const asOf = new Date(summary.asOfMs).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
        console.log('\n' + statusPanel(`Agent AFK · Usage  (as of ${asOf})`, panelRows(summary)) + '\n');
      } catch (error) {
        handleCommandError(error);
      }
    });
}
