import { providerForModel, type BundledProviderName } from '../agent/providers/index.js';

const VALID_PROVIDERS: readonly string[] = [
  'anthropic', 'anthropic-direct', 'openai-codex', 'openai', 'openai-compatible', 'xai', 'xai-oauth',
];

export interface CliProviderContext {
  model?: string;
  openaiBaseUrl?: string;
}

/**
 * Pure selection shared by provider construction and the startup credential gate.
 * Undefined preserves the caller's fully-wired Anthropic fallback. In particular,
 * the legacy openai-codex flag still returns undefined from parseProvider; do not
 * silently change that construction behavior while fixing the credential gate.
 */
export function selectCliProvider(
  raw: string | undefined,
  opts?: CliProviderContext,
): string | undefined {
  let effective = raw;
  if (effective === undefined && opts?.model !== undefined) {
    const routed = providerForModel(opts.model, {
      ...(opts.openaiBaseUrl !== undefined ? { openaiBaseUrl: opts.openaiBaseUrl } : {}),
    });
    if (routed !== 'anthropic-direct') effective = routed;
  }
  if (effective !== undefined && !VALID_PROVIDERS.includes(effective)) {
    throw new Error(`Invalid --provider value: ${effective}. Expected one of: ${VALID_PROVIDERS.join(', ')}`);
  }
  return effective;
}

/** Actual family constructed by parseProvider + its caller's fallback. */
export function cliProviderFamily(
  raw: string | undefined,
  opts?: CliProviderContext,
): BundledProviderName {
  const selected = selectCliProvider(raw, opts);
  if (selected === 'openai' || selected === 'openai-compatible' || selected === 'openai-codex') return 'openai-compatible';
  if (selected === 'xai' || selected === 'xai-oauth') return selected;
  return 'anthropic-direct';
}
