/**
 * Provider-neutral result returned by every tool dispatcher.
 *
 * Model-facing fields are interpreted by both provider adapters; render and
 * trace metadata stays harness-only. Keeping this type at the shared provider
 * boundary prevents either adapter from growing a private result contract.
 */

import type { ToolFailureClass } from '../../trace/types.js';

export interface RenderHints {
  /** Line-based unified diff payload, populated by file-mutation handlers. */
  diff?: import('../../../utils/diff.js').DiffPayload;
}

export interface HarnessUserMessage {
  readonly kind: 'queued_user_message';
  readonly text: string;
}

export interface ToolResult {
  content: string;
  /** Harness-authenticated input appended outside child-controlled tool content. */
  harnessUserMessage?: HarnessUserMessage;
  isError?: boolean;
  truncated?: boolean;
  /**
   * Absolute path to a capture file holding the full tool output when the
   * model-facing content was reduced to a head+tail view (i.e. `truncated:
   * true`). Present only on bash results where `content` omits the middle.
   * Never set when the output was hard-capped via SIGKILL (HARD_CAP_KILL_NOTE)
   * because the middle is genuinely unrecoverable in that case.
   * The TUI uses this to offer "full output saved → ~/…path" instead of
   * silently hiding retained bytes. The model never sees this field.
   */
  capturePath?: string;
  /**
   * Wall-clock duration of the tool call in milliseconds, set by the bash
   * handler. Used by the TUI to surface result status/duration in the outcome
   * line. Not model-facing.
   */
  durationMs?: number;
  /**
   * Numeric process exit status for bash commands when the OS reports one.
   * Present for normal close results including success (0) and non-zero exits;
   * absent when the process outcome has no status code (timeout, abort, spawn
   * error, signal-only close). Not model-facing.
   */
  exitCode?: number;
  incomplete?: boolean;
  incompleteReason?: string;
  circuitBreaker?: boolean;
  failureClass?: ToolFailureClass;
  batchIndex?: number;
  batchSize?: number;
  render?: RenderHints;
  testResult?: import('../../tools/handlers/test-runner-detector.js').TestResult;
  image?: {
    mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
    data: string;
  };
}
