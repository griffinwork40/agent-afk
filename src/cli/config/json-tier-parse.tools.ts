import type { CliConfig, ConfigFileSchema } from './types.js';

/** Preserve valid tool visibility entries in the CLI's per-file config view. */
export function parseToolsConfig(json: ConfigFileSchema): Partial<CliConfig> {
  const disabled = Array.isArray(json.tools?.disabled)
    ? json.tools.disabled.filter((entry): entry is string => typeof entry === 'string')
    : undefined;
  const usageAwareness = typeof json.tools?.usageAwareness === 'boolean'
    ? json.tools.usageAwareness
    : undefined;
  if (disabled === undefined && usageAwareness === undefined) return {};
  return { tools: { ...(disabled !== undefined ? { disabled } : {}), ...(usageAwareness !== undefined ? { usageAwareness } : {}) } };
}
