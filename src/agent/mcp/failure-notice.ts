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
import { serverWirePrefixes } from './naming.js';

/**
 * Sanitise untrusted server error text before splicing it into a framework
 * instruction sentence.  Collapses CR/LF and other control characters to
 * spaces and neutralises embedded double-quotes so the text can be presented
 * as a quoted datum without breaking the surrounding instruction prose.
 */
function sanitiseErrorText(raw: string): string {
  // Collapse all control characters (including CR/LF) to a single space.
  const oneLine = raw.replace(/[\x00-\x1F\x7F]/g, ' ').trim();
  // Neutralise embedded double-quotes so the text stays inside its quotes.
  return oneLine.replace(/"/g, "'");
}

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

  const lines = failed.map(({ name, reason }) => {
    // Use the sanitized wire prefix so the glob matches actual tool names.
    const prefix = serverWirePrefixes(name)[0] ?? `mcp__${name}__`;
    const safeReason = sanitiseErrorText(reason);
    return (
      `[MCP] Server "${name}" failed to start. ` +
      `Error reported by the server (untrusted): "${safeReason}". ` +
      `Tools ${prefix}* cannot be used this session. ` +
      `Tell the user plainly; do not speculate about other causes.`
    );
  });
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

  // Find the failed server whose wire prefix best matches this tool name.
  // Prefer the longest prefix to resolve ambiguity when two servers share a
  // hash prefix (edge case but required by spec).
  let bestMatch: { server: McpServerStateLike; prefix: string } | undefined;
  for (const s of states) {
    if (s.status !== 'error') continue;
    for (const prefix of serverWirePrefixes(s.serverName)) {
      if (
        toolName.startsWith(prefix) &&
        (bestMatch === undefined || prefix.length > bestMatch.prefix.length)
      ) {
        bestMatch = { server: s, prefix };
      }
    }
  }
  if (!bestMatch) return undefined;

  const { server, prefix } = bestMatch;
  const reason = redactSecrets(server.error ?? 'unknown error');
  const safeReason = sanitiseErrorText(reason);
  return (
    `MCP server "${server.serverName}" is configured but failed to connect. ` +
    `Error reported by the server (untrusted): "${safeReason}". ` +
    `Tool "${toolName}" is unavailable this session. ` +
    `Do NOT retry this tool or any ${prefix}* variant.`
  );
}
