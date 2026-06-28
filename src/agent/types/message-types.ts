/**
 * Message and response types.
 * @module agent/types/message-types
 */

import type { DiffPayload } from '../../utils/diff.js';

/** Message role types */
export type MessageRole = 'user' | 'assistant';

/** Metadata extracted from a completed assistant turn (result event) */
export interface ResponseMetadata extends Record<string, unknown> {
  /** SDK session ID */
  sessionId?: string;
  /** Reason the model stopped generating */
  stopReason?: string | null;
  /** Result subtype (e.g. 'success', 'error_during_execution') */
  resultSubtype?: string;
  /** Wall-clock duration of the turn in ms */
  durationMs?: number;
  /** API-level duration in ms */
  durationApiMs?: number;
  /** Estimated cost of the turn in USD */
  totalCostUsd?: number;
  /** Number of agent turns consumed */
  numTurns?: number;
  /** Whether the turn resulted in an error */
  isError?: boolean;
  /** Token usage counters — values are numeric except `iterations`, which
   * is a per-API-call breakdown array (see `BetaIterationsUsage` in the
   * Anthropic SDK). Top-level counters are cumulative across iterations;
   * consumers computing per-call context footprint must use the last
   * iteration, not the aggregated top-level fields. */
  usage?: Record<string, unknown>;
  /** Per-model usage breakdown */
  modelUsage?: Record<string, unknown>;
  /** Tool permission denials that occurred */
  permissionDenials?: unknown[];
  /** Error messages (on error subtypes) */
  errors?: string[];
}

/** A conversation message */
export interface Message {
  role: MessageRole;
  content: string;
  /** Result metadata attached after the turn completes */
  metadata?: ResponseMetadata;
  timestamp?: Date;
}

/** Streaming message chunk variant for plain text content */
export interface ContentChunk {
  type: 'content';
  content: string;
  metadata?: Record<string, unknown>;
}

/** Streaming message chunk variant for tool use summary */
export interface ToolUseChunk {
  type: 'tool_use';
  content: string;
  metadata?: Record<string, unknown>;
}

/** Per-tool chunk from assistant message tool_use blocks (arrives before results). */
export interface ToolUseDetailChunk {
  type: 'tool_use_detail';
  toolUseId: string;
  toolName: string;
  toolInput: string;
  /** Raw JSON-serialized tool input object — used by facet derivation for exact field extraction. */
  toolInputRaw?: string;
  metadata?: Record<string, unknown>;
}

/** Streaming message chunk variant for extended thinking blocks */
export interface ThinkingChunk {
  type: 'thinking';
  content: string;
  metadata?: Record<string, unknown>;
}

/** Streaming message chunk variant for tool result blocks */
export interface ToolResultChunk {
  type: 'tool_result';
  toolUseId: string;
  content: string;
  isError?: boolean;
  /**
   * `true` when the originating tool handler reported its byte cap was hit
   * (e.g. bash/grep 100KB overflow). Plumbed from `ToolResult.truncated`
   * through `tool.output.truncated`. Distinct from the cosmetic 80-char
   * display preview clip — that clip is implicit in `content` (sliced
   * preview string) and `lineCount` (set when the original was multi-line).
   * Subagent traces use this field to surface "the tool's buffer overflowed"
   * to the parent agent without substring-scanning content for the
   * `[output truncated …]` sentinel.
   */
  truncated?: boolean;
  persistedPath?: string;
  sizeBytes?: number;
  sizeLabel?: string;
  lineCount?: number;
  /**
   * Optional pre-rendered display string set by the tool handler (via
   * `ToolResult.display`) for the interactive tool-lane outcome row.
   * The renderer prefers this over slicing `content`. Bypasses the
   * `truncateContent` length cap because it's already short by construction.
   */
  display?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Streaming message chunk variant for the sidecar render-only diff payload
 * emitted by file-mutation tools (`edit_file`, `write_file`). Arrives AFTER
 * the corresponding {@link ToolResultChunk}, correlated by `toolUseId`.
 *
 * Structural invariant: this chunk is rendered by UI surfaces (CLI, Telegram,
 * JSON output) but its payload never appears in the model's `tool_result`
 * content. Late-arriving — consumers should attach it to the already-emitted
 * tool result entry by `toolUseId`, or drop silently if no such entry exists.
 */
export interface ToolDiffChunk {
  type: 'tool_diff';
  toolUseId: string;
  diff: DiffPayload;
  metadata?: Record<string, unknown>;
}

/** Streaming message chunk (discriminated union) */
export type MessageChunk = ContentChunk | ToolUseChunk | ToolUseDetailChunk | ThinkingChunk | ToolResultChunk | ToolDiffChunk | { type: 'done' | 'error'; content?: string; metadata?: Record<string, unknown> };

/** Message send options */
export interface SendMessageOptions {
  /** Whether to stream the response */
  stream?: boolean;
  /** Optional message metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Options for {@link IAgentSession.sendMessageStructured}. Extends
 * {@link SendMessageOptions} with a bounded retry budget for schema-validated
 * output (mirrors the Claude Agent SDK's `outputFormat: json_schema` retry).
 */
export interface StructuredMessageOptions extends SendMessageOptions {
  /**
   * Number of ADDITIONAL re-prompts after the first attempt fails schema
   * validation. Total model turns = `maxRetries + 1`. Default 2 (so up to 3
   * turns). On exhaustion, `sendMessageStructured` throws.
   */
  maxRetries?: number;
  /**
   * When true (default), the JSON Schema derived from the validation schema is
   * injected into the prompt — on the first attempt and on every retry — so the
   * model is told the exact shape to produce (mirrors the Claude Agent SDK's
   * `outputFormat: json_schema`). Set false when the caller has already
   * engineered the schema into `content` and wants it sent verbatim.
   */
  injectSchemaPrompt?: boolean;
}
