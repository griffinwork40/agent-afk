export const FAST_MODE_BETA = 'fast-mode-2026-02-01';

export interface BetaHeaderOptions {
  oauthEntries?: readonly string[];
  effort?: boolean;
  extendedCacheTtl?: boolean;
  fast?: boolean;
  effortEntry: string;
  extendedCacheEntry: string;
}

export function composeBetaHeader(options: BetaHeaderOptions): string | undefined {
  const entries = [
    ...(options.oauthEntries ?? []),
    ...(options.effort ? [options.effortEntry] : []),
    ...(options.extendedCacheTtl ? [options.extendedCacheEntry] : []),
    ...(options.fast ? [FAST_MODE_BETA] : []),
  ].filter(Boolean);
  const value = [...new Set(entries)].join(',');
  return value || undefined;
}
