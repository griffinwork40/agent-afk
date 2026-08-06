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
