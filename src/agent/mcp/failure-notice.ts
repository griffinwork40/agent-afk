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
 * Maximum length (in code points) of the sanitised error snippet embedded in
 * model-visible text.  Keeps the notice bounded regardless of how the caller
 * obtained the raw error string (e.g. the `getMcpServerStates` dispatcher
 * option accepts any accessor, not just the 200-char-capped `McpManager`
 * field).
 */
const SANITISED_ERROR_MAX_LEN = 300;

/** Maximum length (in code points) for a sanitised server name. */
const SANITISED_NAME_MAX_LEN = 128;

/**
 * Shared normaliser for untrusted text before it enters model-visible prose.
 *
 * - Collapses ASCII control characters (U+0000–U+001F, U+007F) and the
 *   Unicode line-terminator characters U+2028 / U+2029 to spaces, so the
 *   text stays on a single logical line even for tokenisers and renderers
 *   that treat those codepoints as newlines.
 * - Replaces backticks with single-quotes so the snippet cannot open a
 *   markdown code span inside a model instruction.
 * - Neutralises embedded double-quotes so the text stays inside its
 *   surrounding quoted datum without breaking the instruction prose.
 * - Caps the result at `maxLen` code points (not UTF-16 code units) so
 *   surrogate pairs are never split.
 */
function normaliseUntrustedText(raw: string, maxLen: number): string {
  // Collapse ASCII controls + Unicode line terminators to a single space.
  const oneLine = raw.replace(/[\x00-\x1F\x7F\u2028\u2029]/g, ' ').trim();
  // Replace backticks (markdown code-span openers) with single-quotes.
  const noTicks = oneLine.replace(/`/g, "'");
  // Neutralise embedded double-quotes so the text stays inside its quotes.
  const noQuotes = noTicks.replace(/"/g, "'");
  // Enforce length cap (code-point-safe via Array.from to avoid splitting
  // surrogate pairs at the boundary).
  const codePoints = Array.from(noQuotes);
  return codePoints.length <= maxLen
    ? noQuotes
    : codePoints.slice(0, maxLen).join('');
}

/**
 * Sanitise untrusted server error text before splicing it into a framework
 * instruction sentence.
 *
 * Delegates to {@link normaliseUntrustedText} with the error-text length cap.
 */
function sanitiseErrorText(raw: string): string {
  return normaliseUntrustedText(raw, SANITISED_ERROR_MAX_LEN);
}

/**
 * Sanitise an operator-authored server name before embedding it in
 * model-visible text.  Config keys are trusted (project `.mcp.json` requires
 * `AFK_ALLOW_PROJECT_MCP`), but we apply the full shared normaliser (control
 * chars, backticks, quotes, length cap) and run `redactSecrets` for
 * redaction consistency.
 */
function sanitiseServerName(raw: string): string {
  return normaliseUntrustedText(redactSecrets(raw), SANITISED_NAME_MAX_LEN);
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
 * Return the servers whose `status === 'oauth_pending'`, sorted by name.
 * Pure filter — no side-effects, safe to call on every tool dispatch.
 */
export function oauthPendingMcpServers(
  states: readonly McpServerStateLike[],
): { name: string }[] {
  return states
    .filter((s) => s.status === 'oauth_pending')
    .map((s) => ({ name: s.serverName }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Build the framework context notice injected at session start when one or
 * more MCP servers are in `error` or `oauth_pending` state.
 *
 * Returns `undefined` when every configured server is healthy (avoids
 * injecting an empty or no-op notice).
 *
 * The notice is prefixed with `[MCP]` so hook-layer parsers and log
 * scanners can identify it without substring-matching the prose.
 *
 * **Wire-prefix glob:** `serverWirePrefixes` returns two entries when a
 * server name is long enough that some tools overflow into the hash-prefix
 * path (see `naming.ts`).  Both globs are included in the notice so the
 * model knows about all tool-name patterns it cannot use.
 */
export function buildMcpFailureNotice(
  states: readonly McpServerStateLike[],
): string | undefined {
  const failed = failedMcpServers(states);
  const pending = oauthPendingMcpServers(states);
  if (failed.length === 0 && pending.length === 0) return undefined;

  const lines: string[] = [];

  for (const { name, reason } of failed) {
    const prefixes = serverWirePrefixes(name);
    // When two prefixes exist the server has both a sanitized and a
    // hash-based prefix (overflow tools).  Name both globs so the model
    // knows the full set of unavailable tool-name patterns.
    const globClause = `Tools ${prefixes.map((p) => `${p}*`).join(' and ')} cannot be used this session.`;
    const safeName = sanitiseServerName(name);
    const safeReason = sanitiseErrorText(reason);
    lines.push(
      `[MCP] Server "${safeName}" failed to start. ` +
      `Error reported by the server (untrusted): "${safeReason}". ` +
      `${globClause} ` +
      `Tell the user plainly; do not speculate about other causes.`,
    );
  }

  for (const { name } of pending) {
    const prefixes = serverWirePrefixes(name);
    const globClause = `Tools ${prefixes.map((p) => `${p}*`).join(' and ')} cannot be used until authorization is complete.`;
    const safeName = sanitiseServerName(name);
    lines.push(
      `[MCP] Server "${safeName}" requires authorization before it can be used. ` +
      `${globClause} ` +
      `Tell the user they must complete the OAuth flow; do not attempt to call these tools.`,
    );
  }

  return lines.join('\n');
}

/**
 * Build a framework-context notice for a server that disconnected mid-session
 * due to a transport error. Queued via `queueFrameworkContext` so the model's
 * NEXT turn learns the server went down (#4064-b).
 *
 * Unlike `buildMcpFailureNotice` (which covers startup failures), this is
 * called reactively from the `McpManager.onServerError` callback.
 *
 * The `reason` argument is the raw error message from the transport — it is
 * sanitised here before embedding in model-visible text.
 */
export function buildMcpDisconnectNotice(serverName: string, reason: string): string {
  const safeName = sanitiseServerName(serverName);
  const safeReason = sanitiseErrorText(redactSecrets(reason));
  const prefixes = serverWirePrefixes(serverName);
  const globClause = `Tools ${prefixes.map((p) => `${p}*`).join(' and ')} cannot be used for the rest of this session.`;
  return (
    `[MCP] Server "${safeName}" disconnected unexpectedly. ` +
    `Error reported by the server (untrusted): "${safeReason}". ` +
    `${globClause} ` +
    `Tell the user plainly; do not speculate about other causes.`
  );
}

/**
 * If `toolName` matches `mcp__<server>__*` and `<server>` is in `error` or
 * `oauth_pending` state, return a model-visible message explaining why the
 * tool is unavailable. Returns `undefined` when the tool name does not match
 * an unavailable server (caller falls through to the generic unknown-tool
 * message).
 *
 * `oauth_pending` servers produce an "authorization required" variant instead
 * of the generic error text so the model does not hallucinate failure causes
 * (#4064-c).
 */
export function mcpUnknownToolMessage(
  toolName: string,
  states: readonly McpServerStateLike[],
): string | undefined {
  if (!toolName.startsWith('mcp__')) return undefined;

  // Find the best-matching unavailable server (error or oauth_pending).
  // Prefer the longest prefix to resolve ambiguity when two servers share a
  // hash prefix (edge case but required by spec).
  let bestMatch: { server: McpServerStateLike; prefix: string } | undefined;
  for (const s of states) {
    if (s.status !== 'error' && s.status !== 'oauth_pending') continue;
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
  const safeName = sanitiseServerName(server.serverName);
  // Sanitise toolName for display only — prefix matching above uses the raw
  // value so routing is unaffected.
  const safeToolName = normaliseUntrustedText(toolName, SANITISED_NAME_MAX_LEN);

  if (server.status === 'oauth_pending') {
    return (
      `MCP server "${safeName}" requires authorization before it can be used. ` +
      `Tool "${safeToolName}" is unavailable until the OAuth flow is complete. ` +
      `Tell the user they must authorize the server; Do NOT retry this tool or any ${prefix}* variant.`
    );
  }

  const reason = redactSecrets(server.error ?? 'unknown error');
  const safeReason = sanitiseErrorText(reason);
  return (
    `MCP server "${safeName}" is configured but failed to connect. ` +
    `Error reported by the server (untrusted): "${safeReason}". ` +
    `Tool "${safeToolName}" is unavailable this session. ` +
    `Do NOT retry this tool or any ${prefix}* variant.`
  );
}
