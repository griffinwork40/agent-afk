/**
 * Construction options for {@link OpenAICompatibleQuery}.
 *
 * Extracted from `query.ts` (350-code-line ceiling) — see issue #2565.
 *
 * @module agent/providers/openai-compatible/query/query-options
 */

import type { AgentConfig } from '../../../types/config-types.js';
import type { TraceSink } from '../../../trace/index.js';
import type { ProviderUserTurn } from '../../../provider.js';
import type { ToolDispatcher } from '../../anthropic-direct/tool-dispatcher.js';
import type { OpenAIAuthResolution } from '../auth.js';
import type { FastTierOptions } from './fast-tier-session.js';

/** Construction options for OpenAICompatibleQuery. */
export interface OpenAICompatibleQueryOptions {
  /** Pre-resolved auth. Carries the source tag for session.init. */
  auth: OpenAIAuthResolution;
  /** Optional baseURL override (NVIDIA NIM, Together, etc.). Defaults to OpenAI. */
  baseURL?: string;
  /**
   * Optional default headers for the OpenAI client (e.g. xAI CLI-proxy
   * identity). Applied when the wire mode does not supply its own headers
   * (ChatGPT subscription Responses path wins if both are set).
   */
  defaultHeaders?: Record<string, string>;
  /** Model id, passed straight through to the API. */
  model: string;
  /** Synthetic session id emitted on `session.init` before the first wire call. */
  synthesizedSessionId: string;
  /** Caller-side prompt stream (lazy). */
  promptStream: AsyncIterable<ProviderUserTurn>;
  /** Full AgentConfig. */
  config: AgentConfig;
  /**
   * Tool dispatcher to route every tool call through. When omitted, tool
   * calls are not offered to the model (no `tools[]` in the request) and
   * the loop reduces to slice-2 text-only behavior.
   */
  toolDispatcher?: ToolDispatcher;
  /**
   * Provider callback invoked by `setPermissionMode()` to update the
   * provider-level `_currentPermissionMode`.
   */
  onPermissionMode?: (mode: string) => void;
  /**
   * Provider callback invoked by `setCwd()` to rebuild the `# Environment`
   * block after a cwd re-anchor (#876).
   */
  onCwdChange?: (cwd: string) => void;
  /** Optional MCP manager — populates `session.init` and `mcpServerStatus()`. */
  mcpManager?: import('../../../mcp/index.js').McpManager;
  /**
   * Force the OpenAI Responses API instead of Chat Completions.
   * The ChatGPT-subscription path (`auth.source === 'chatgpt-oauth'`) selects
   * Responses automatically regardless of this flag.
   */
  useResponsesApi?: boolean;
  /**
   * Witness-layer trace writer. When provided, `loop_start`/`loop_end`/
   * `model_ttfb` session_phase events and `tool_call` started/completed
   * events are emitted.
   */
  traceWriter?: TraceSink;
  /** Fast mode (service_tier "priority"); absent for forks. See query/fast-tier-session.ts. */
  fastTier?: FastTierOptions;
}
