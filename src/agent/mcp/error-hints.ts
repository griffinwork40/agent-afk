/**
 * Server-specific diagnoses appended to failed MCP tool results.
 *
 * Some MCP servers report a misleading error whose real cause afk can detect
 * locally. A hint rule matches a server + error text and returns extra text
 * that is appended to the model-facing result, so the agent relays the real
 * fix instead of re-trying the same call. Rules live here, keyed by server, so
 * the generic client (`client.ts`) carries no server-specific strings.
 *
 * Contract: a rule never throws and never mutates the result it is given;
 * `applyMcpErrorHints` returns the original object unchanged when no rule
 * matches or the result is not an error.
 *
 * @module agent/mcp/error-hints
 */

import type { ToolResult } from '../tools/types.js';
import type { McpServerConfig } from './types.js';
import { adviseRealChrome, formatRealChromeAdvice } from '../../browser/real-chrome-advice.js';
import {
  CHROME_DEVTOOLS_SERVER_NAME,
  channelFromArgs,
  probeRealChrome,
  type RealChromeProbeResult,
} from '../../browser/real-chrome-probe.js';

export interface McpErrorHintRule {
  /** Short id for tests and debugging. */
  id: string;
  appliesTo(serverName: string, config: McpServerConfig): boolean;
  /** Return text to append, or undefined to leave the result alone. */
  hint(errorText: string, config: McpServerConfig): string | undefined;
}

/** Test seam: override the probe used by the chrome-devtools rule. */
export interface McpErrorHintDeps {
  probe?: (channel: ReturnType<typeof channelFromArgs>) => RealChromeProbeResult;
}

function isChromeDevtoolsServer(serverName: string, config: McpServerConfig): boolean {
  if (serverName === CHROME_DEVTOOLS_SERVER_NAME) return true;
  return (config.args ?? []).some((a) => a.startsWith('chrome-devtools-mcp'));
}

export function chromeDevtoolsActivePortRule(deps: McpErrorHintDeps = {}): McpErrorHintRule {
  return {
    id: 'chrome-devtools/active-port',
    appliesTo: isChromeDevtoolsServer,
    hint(errorText, config) {
      if (!errorText.includes('DevToolsActivePort')) return undefined;
      const channel = channelFromArgs(config.args);
      const probe = (deps.probe ?? ((c) => probeRealChrome({ channel: c })))(channel);
      // `ok` means the file was readable by afk just now: the failure was likely
      // transient (Chrome restarting), so the generic error stands on its own.
      if (probe.state === 'ok') return undefined;
      return `[afk diagnosis] ${formatRealChromeAdvice(adviseRealChrome(probe))}\n` +
        'Relay these steps to the user; retrying the same call will fail until they are done.';
    },
  };
}

const DEFAULT_RULES: readonly McpErrorHintRule[] = [chromeDevtoolsActivePortRule()];

/** Append the first matching hint to an error result. Never throws. */
export function applyMcpErrorHints(
  serverName: string,
  config: McpServerConfig,
  result: ToolResult,
  rules: readonly McpErrorHintRule[] = DEFAULT_RULES,
): ToolResult {
  if (result.isError !== true) return result;
  for (const rule of rules) {
    try {
      if (!rule.appliesTo(serverName, config)) continue;
      const extra = rule.hint(result.content, config);
      if (extra !== undefined) return { ...result, content: `${result.content}\n\n${extra}` };
    } catch (err) {
      // A hint is best-effort decoration; never let it break a tool result.
      // Log so the failure is visible in stderr rather than silently swallowed.
      // The write itself is guarded: stderr may be destroyed (closed fd, daemon
      // redirect) and process.stderr.write() can throw ERR_STREAM_DESTROYED.
      try {
        process.stderr.write(`[afk] mcp error-hint rule "${rule.id}" threw: ${String(err)}\n`);
      } catch {
        // ignore — best-effort logging must never surface to callers
      }
    }
  }
  return result;
}
