import type { CliConfig, ConfigFileSchema } from './types.js';

/** Preserve valid tool visibility entries in the CLI's per-file config view. */
export function parseToolsConfig(json: ConfigFileSchema): Partial<CliConfig> {
  if (!Array.isArray(json.tools?.disabled)) return {};
  return { tools: { disabled: json.tools.disabled.filter((entry): entry is string => typeof entry === 'string') } };
}
