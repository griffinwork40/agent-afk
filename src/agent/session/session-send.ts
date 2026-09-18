/**
 * Public send-message surface, extracted from {@link AgentSession}.
 *
 * Owns the four public entry points into a provider turn:
 *   - `sendMessage()` — collect a single assistant `Message` with timeout
 *   - `sendMessageStructured()` — retry loop with schema validation
 *   - `sendMessageStream()` — yield raw `OutputEvent`s
 *   - `interrupt()` / `setBeforeNextRound()` — in-turn control
 *
 * All functions receive their dependencies explicitly; no back-reference
 * to {@link AgentSession} is retained here.
 *
 * @module agent/session/session-send
 */

import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import { z, type ZodType } from 'zod';
import { DEFAULT_SESSION_TIMEOUT_MS, withTimeout } from '../timeout.js';
import { extractStructuredOutput } from '../output-extractor.js';
import type {
  Message,
  OutputEvent,
  SendMessageOptions,
  SessionState,
  StructuredMessageOptions,
} from '../types.js';
import type { ProviderQuery } from '../provider.js';
import type { AgentConfig } from '../types.js';
import type { TurnStreamRunner } from './turn-stream-runner.js';
import type { QueryInputStream } from './input-iterable.js';
import type { PlanExitBridge } from './plan-exit-bridge.js';

/** Context bag for the send-message functions. */
export interface SendDeps {
  getConfig: () => AgentConfig;
  getAbortController: () => AbortController;
  getState: () => SessionState;
  setState: (s: SessionState) => void;
  getSessionId: () => string | undefined;
  runner: TurnStreamRunner;
  getInputStream: () => QueryInputStream;
  getProviderQuery: () => ProviderQuery;
  planExit: PlanExitBridge;
}

/**
 * Collect a single assistant `Message` from a provider turn, applying the
 * session timeout and yielding to the abort controller.
 */
export async function sendMessage(
  content: string,
  options: SendMessageOptions = {},
  deps: SendDeps,
): Promise<Message> {
  deps.runner.assertCanSend();
  const config = deps.getConfig();
  const timeoutMs = config.timeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;

  const collectResponse = async (): Promise<Message> => {
    let result: Message | null = null;
    let streamedContent = '';

    deps.setState(options.stream ? 'streaming' : 'processing');

    for await (const event of sendMessageStreamInternal(content, deps)) {
      if (event.type === 'chunk' && event.chunk.type === 'content') {
        streamedContent += event.chunk.content;
      }
      if (event.type === 'message' && event.message.role === 'assistant') {
        result = event.message;
      }
      if (event.type === 'error') {
        throw event.error;
      }
      if (event.type === 'done') {
        if (result) {
          return { ...result, metadata: event.metadata };
        }
        if (streamedContent) {
          return {
            role: 'assistant',
            content: streamedContent,
            metadata: event.metadata,
            timestamp: new Date(),
          };
        }
      }
    }

    if (result) return result;
    if (streamedContent) {
      return { role: 'assistant', content: streamedContent, timestamp: new Date() };
    }
    throw new Error('No assistant response received');
  };

  try {
    return await withTimeout(collectResponse(), timeoutMs, {
      controller: deps.getAbortController(),
      label: deps.getSessionId() ?? 'session',
    });
  } finally {
    if (deps.getState() === 'processing') deps.setState('idle');
  }
}

/**
 * Send a message and parse the response against a Zod schema, retrying
 * up to `maxRetries` times on validation failure.
 */
export async function sendMessageStructured<T>(
  content: string,
  schema: ZodType<T>,
  options: StructuredMessageOptions = {},
  deps: SendDeps,
): Promise<T> {
  // Composes sendMessage() turns — no streaming-internals changes.
  const { maxRetries = 2, injectSchemaPrompt = true, ...sendOpts } = options;
  const schemaBlock = injectSchemaPrompt
    ? '\n\nRespond with ONLY a JSON object (optionally in a ```json fence) that conforms to this JSON Schema:\n```json\n' +
      JSON.stringify(z.toJSONSchema(schema, { target: 'openapi-3.0' })) +
      '\n```'
    : '';
  let lastError = '';
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const prompt =
      attempt === 0
        ? content + schemaBlock
        : `Your previous response did not match the required JSON schema.\n` +
          `Validation error: ${lastError}\n` +
          'Respond again with ONLY a JSON object (optionally in a ```json fence) that satisfies the schema.' +
          schemaBlock;
    const message = await sendMessage(prompt, sendOpts, deps);
    const candidate = extractStructuredOutput(message.content);
    const parsed = schema.safeParse(candidate);
    if (parsed.success) return parsed.data;
    lastError = parsed.error.message;
  }
  throw new Error(
    `structured output did not match schema after ${maxRetries + 1} attempt(s): ${lastError}`,
  );
}

/**
 * Yield raw `OutputEvent`s from a provider turn. The state machine
 * is set to `streaming` before the loop and restored on exit.
 */
export async function* sendMessageStream(
  content: string | ContentBlockParam[],
  deps: SendDeps,
): AsyncIterableIterator<OutputEvent> {
  deps.runner.assertCanSend();
  deps.setState('streaming');
  try {
    yield* sendMessageStreamInternal(content, deps);
  } finally {
    if (deps.getState() === 'streaming') deps.setState('idle');
  }
}

/**
 * Core streaming entry point: clears the plan-exit ring gesture, then
 * delegates to `TurnStreamRunner.runStream`.
 *
 * Internal — callers should use `sendMessageStream` or `sendMessage`.
 */
export function sendMessageStreamInternal(
  content: string | ContentBlockParam[],
  deps: SendDeps,
): AsyncIterableIterator<OutputEvent> {
  // End any in-flight Shift+Tab ring gesture: submitting a turn means the
  // user actually RESTED in the current mode, so a transient-default stash
  // from `setPermissionMode` must not survive into a later `default → plan`.
  deps.planExit.clearModeBeforeDefault();
  return deps.runner.runStream(content, deps.getInputStream());
}

/**
 * Interrupt an in-progress provider turn. No-op when idle or closed.
 */
export async function interrupt(
  deps: Pick<SendDeps, 'getState' | 'setState' | 'getProviderQuery'>,
): Promise<void> {
  const state = deps.getState();
  if (state !== 'streaming' && state !== 'processing') return;
  deps.setState('idle');
  await deps.getProviderQuery().interrupt();
}

/**
 * Install a callback that fires before the next provider round begins.
 * Forwarded directly to the provider query; no-op when the provider does
 * not support it.
 */
export function setBeforeNextRound(
  cb: (() => string | undefined) | undefined,
  deps: Pick<SendDeps, 'getProviderQuery'>,
): void {
  deps.getProviderQuery().setBeforeNextRound?.(cb);
}
