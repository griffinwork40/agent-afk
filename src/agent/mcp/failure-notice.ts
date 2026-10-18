/**
 * MCP server failure notice helpers.
 *
 * Centralises the model-visible phrasing for two scenarios:
 *  1. Session-init framework notice — queued via `queueFrameworkContext` so
 *     the model's FIRST turn already knows which servers are down (#4064).
 *  2. Per-call unknown-tool message enrichment — replaces the generic
 *     "tool does not exist" text with a server-specific explanation when the
 *     tool name matches `mcp__<server>__*` and that server is in `error`
 *     state (#4064).
 *
 * Kept in a separate file so `dispatcher.core-exec.ts` and
 * `provider-lifecycle.ts` can both import it without coupling to each other,
 * and so neither breaches the 350-line ceiling.
 *
 * @module agent/mcp/failure-notice
 */

import { redactSecrets } from '../redact-secrets.js';

/** Minimal shape consumed from `McpManager.getServerStates()`. */
export interface McpServerStateLike {
  serverName: string;
  status: string;
  error?: string;
}

/**
 * Return the servers whose `status === 'error'`, sorted by name.
 * Pure filter — no side-effects, safe to call on every tool dispatch.
 */
export function failedMcpServers(
  states: readonly McpServerStateLike[],
): { name: string; reason: string }[] {
  return states
    .filter((s) => s.status === 'error')
    .map((s) => ({
      name: s.serverName,
      reason: redactSecrets(s.error ?? 'unknown error'),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Build the framework context notice injected at session start when one or
 * more MCP servers are in `error` state.
 *
 * Returns `undefined` when every configured server is healthy (avoids
 * injecting an empty or no-op notice).
 *
 * The notice is prefixed with `[MCP]` so hook-layer parsers and log
 * scanners can identify it without substring-matching the prose.
 */
export function buildMcpFailureNotice(
  states: readonly McpServerStateLike[],
): string | undefined {
  const failed = failedMcpServers(states);
  if (failed.length === 0) return undefined;

  const lines = failed.map(
    ({ name, reason }) =>
      `[MCP] Server "${name}" failed to start: ${reason}. ` +
      `Tools mcp__${name}__* cannot be used this session. ` +
      `Tell the user plainly; do not speculate about other causes.`,
  );
  return lines.join('\n');
}

/**
 * If `toolName` matches `mcp__<server>__*` and `<server>` is in `error`
 * state, return a model-visible message naming the failed server and its
 * error. Returns `undefined` when the tool name does not match a failed
 * server (caller falls through to the generic unknown-tool message).
 */
export function mcpUnknownToolMessage(
  toolName: string,
  states: readonly McpServerStateLike[],
): string | undefined {
  if (!toolName.startsWith('mcp__')) return undefined;
  const parts = toolName.split('__');
  if (parts.length < 3) return undefined;
  const serverName = parts[1];
  if (!serverName) return undefined;

  const match = states.find((s) => s.serverName === serverName && s.status === 'error');
  if (!match) return undefined;

  const reason = redactSecrets(match.error ?? 'unknown error');
  return (
    `MCP server "${serverName}" is configured but failed to connect: ${reason}. ` +
    `Tool "${toolName}" is unavailable this session. ` +
    `Do NOT retry this tool or any mcp__${serverName}__* variant.`
  );
}
