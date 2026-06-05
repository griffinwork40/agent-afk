/**
 * Renders a multi-line diagnostic block summarizing SDK session metadata.
 * Used by interactive mode when --debug / AFK_DEBUG=1 is on, and
 * by the /debug slash command on demand.
 * @module cli/debug-banner
 */

import type { SessionMetadata } from '../agent/types/session-types.js';
import { palette } from './palette.js';
import { divider } from './render.js';

function formatList(values: readonly string[] | undefined, max = 30): string {
  if (!values || values.length === 0) return palette.dim('(none)');
  if (values.length <= max) return values.join(', ');
  const shown = values.slice(0, max).join(', ');
  return `${shown}, ${palette.dim(`+${values.length - max} more`)}`;
}

function row(label: string, value: string): string {
  return `  ${palette.label(label.padEnd(16))} ${value}`;
}

/**
 * Format a SessionMetadata snapshot into a human-readable block.
 * Pure function — no I/O, safe to snapshot in tests.
 */
export function renderDebugBanner(meta: SessionMetadata): string {
  const lines: string[] = [];
  lines.push('  ' + divider('Session Debug'));

  if (meta.sessionId) lines.push(row('session', meta.sessionId));
  if (meta.model) lines.push(row('model', meta.model));
  if (meta.permissionMode) lines.push(row('permission', meta.permissionMode));
  if (meta.cwd) lines.push(row('cwd', meta.cwd));
  if (meta.claudeCodeVersion) lines.push(row('sdk', `v${meta.claudeCodeVersion}`));
  if (meta.apiKeySource) lines.push(row('api key', meta.apiKeySource));
  if (meta.outputStyle) lines.push(row('output style', meta.outputStyle));

  const toolCount = meta.tools?.length ?? 0;
  lines.push(row(`tools (${toolCount})`, formatList(meta.tools)));

  const mcpServers = meta.mcpServers ?? [];
  const mcpSummary = mcpServers.length
    ? mcpServers.map((s) => `${s.name}[${s.status}]`).join(', ')
    : palette.dim('(none)');
  lines.push(row(`mcp (${mcpServers.length})`, mcpSummary));

  const skillCount = meta.skills?.length ?? 0;
  lines.push(row(`skills (${skillCount})`, formatList(meta.skills)));

  const pluginCount = meta.plugins?.length ?? 0;
  const pluginSummary = pluginCount
    ? (meta.plugins ?? []).map((p) => p.name).join(', ')
    : palette.dim('(none)');
  lines.push(row(`plugins (${pluginCount})`, pluginSummary));

  const slashCount = meta.slashCommands?.length ?? 0;
  lines.push(row(`slash (${slashCount})`, formatList(meta.slashCommands)));

  lines.push('  ' + divider());
  return lines.join('\n');
}
