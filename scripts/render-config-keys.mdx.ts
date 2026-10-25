import type { ConfigKeySpec } from '../src/config/settable-keys.js';
import { cell, code, pageHeader } from './lib/docs-reference.js';

export function renderConfig(keys: readonly ConfigKeySpec[]): string {
  const lines = pageHeader('Configuration keys', 'Settable configuration keys, types, validation, and sensitivity tiers.', 'scan:config', 'CONFIG_KEY_SPECS in src/config/settable-keys.ts');
  lines.push('These keys are accepted by the configuration mutation API. Agent tier keys are nonsecret behavioural settings that the agent may change. Human tier keys control identity, trust, routing, or safety and require the human CLI; the agent configuration tool refuses them. Keys are sorted by dotted path.', '',
    'See [editing configuration](/configuration/editing-config) for file locations and precedence.', '',
    '| Path | Type | Values or clamp | Tier | Description |', '| --- | --- | --- | --- | --- |');
  for (const key of [...keys].sort((a, b) => a.path.localeCompare(b.path))) {
    const constraints = key.enumValues?.map(code).join(', ') ?? (key.clamp
      ? `${key.clamp.min} to ${key.clamp.max}${key.clamp.integer ? '; integer' : ''}` : '');
    lines.push(`| ${code(key.path)} | ${cell(key.type)} | ${constraints} | ${key.tier} | ${cell(key.description)} |`);
  }
  lines.push('');
  return lines.join('\n');
}
