/**
 * One-shot programmatic entry points — the library-friendly façade over
 * {@link AgentSession}, mirroring the shape of the Claude Agent SDK's `query()`.
 *
 * `query()` returns an async-iterable of {@link OutputEvent}s and owns the full
 * session lifecycle (construct → stream → close), so library callers do not have
 * to manage `new AgentSession(...)` / `close()` themselves. `queryText()` is the
 * non-streaming convenience that resolves to the final assistant text.
 *
 * @module agent/query
 */

import type { ZodType } from 'zod';
import { AgentSession } from './session.js';
import type {
  AgentConfig,
  AgentModelInput,
  Message,
  OutputEvent,
  StructuredMessageOptions,
} from './types.js';

/** Default model when a caller omits one (the `medium` capability-tier alias). */
const DEFAULT_QUERY_MODEL: AgentModelInput = 'sonnet';

/**
 * Options for {@link query} / {@link queryText}. Every {@link AgentConfig} field
 * is accepted; `model` is optional here (defaults to {@link DEFAULT_QUERY_MODEL})
 * whereas it is required on the bare config. Pass `abortSignal` to cancel, or
 * `provider` to inject a custom/mock {@link ModelProvider}.
 */
export type QueryOptions = Partial<Omit<AgentConfig, 'model'>> & {
  model?: AgentModelInput;
};

/** Build a fresh session from query options, applying the default model. */
function sessionFor(options: QueryOptions): AgentSession {
  const { model = DEFAULT_QUERY_MODEL, ...rest } = options;
  return new AgentSession({ model, ...rest });
}

/**
 * Run a single prompt and stream the resulting {@link OutputEvent}s. The
 * underlying session is torn down when iteration finishes — whether it completes
 * normally, the caller `break`s early, or an error propagates (the `finally`
 * runs on generator return). Cancel mid-stream by passing `abortSignal` in
 * `options`.
 *
 * @example
 * for await (const event of query('Summarize README.md', { model: 'sonnet' })) {
 *   if (event.type === 'delta.text') process.stdout.write(event.text);
 * }
 */
export async function* query(
  prompt: string,
  options: QueryOptions = {},
): AsyncGenerator<OutputEvent, void, void> {
  const session = sessionFor(options);
  try {
    yield* session.sendMessageStream(prompt);
  } finally {
    await session.close();
  }
}

/**
 * Run a single prompt and resolve to the final assistant message text, owning
 * the session lifecycle like {@link query}. Use this for the common
 * "ask once, get the answer" case where streaming is not needed.
 *
 * @example
 * const answer = await queryText('What is 2 + 2?', { model: 'haiku' });
 */
export async function queryText(
  prompt: string,
  options: QueryOptions = {},
): Promise<string> {
  const session = sessionFor(options);
  try {
    const message: Message = await session.sendMessage(prompt);
    return message.content;
  } finally {
    await session.close();
  }
}

/**
 * Run a single prompt and resolve to its response parsed against a Zod schema,
 * owning the session lifecycle like {@link query}. Mirrors the Claude Agent
 * SDK's `outputFormat: json_schema`: the assistant's JSON payload is extracted
 * and validated, with bounded re-prompting on a schema mismatch (see
 * {@link StructuredMessageOptions.maxRetries}). Throws if the schema is never
 * satisfied within the retry budget.
 *
 * @example
 * const schema = z.object({ sentiment: z.enum(['pos', 'neg']) });
 * const out = await queryStructured('Classify: "great!"', schema, { model: 'sonnet' });
 * //    ^? { sentiment: 'pos' | 'neg' }
 */
export async function queryStructured<T>(
  prompt: string,
  schema: ZodType<T>,
  options: QueryOptions & { maxRetries?: number; injectSchemaPrompt?: boolean } = {},
): Promise<T> {
  const { maxRetries, injectSchemaPrompt, ...rest } = options;
  const session = sessionFor(rest);
  const structuredOpts: StructuredMessageOptions = {};
  if (maxRetries !== undefined) structuredOpts.maxRetries = maxRetries;
  if (injectSchemaPrompt !== undefined) structuredOpts.injectSchemaPrompt = injectSchemaPrompt;
  try {
    return await session.sendMessageStructured(prompt, schema, structuredOpts);
  } finally {
    await session.close();
  }
}
