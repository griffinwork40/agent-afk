/**
 * NDJSON accumulator for `afk chat --format stream-json` episode output.
 *
 * Extracted from `afk-runner.run.ts` to keep that file within the 350-line
 * ceiling. `afk-runner.run.ts` re-exports {@link accumulateStreamJson}, so
 * importers are unchanged.
 *
 * Event ordering this parser relies on (anthropic-direct provider, which is
 * the only emitter of pending tool twins):
 *
 *   1. Round N streams `content` chunks. At each `tool_use` content block
 *      start a PENDING `tool_use_detail` is emitted mid-stream
 *      (anthropic-direct/translate.ts), and at the block stop a `tool_use`
 *      summary chunk carrying `metadata.precedingToolUseIds`.
 *   2. A mid-stream overload, dropped connection, or first-byte timeout emits
 *      `stream_retry` and the SAME round is re-driven from scratch, so every
 *      text chunk AND every pending twin of the aborted attempt is re-emitted
 *      (anthropic-direct/loop/round-retry.ts).
 *   3. Once the round's stream settles, the COMPLETED `tool_use_detail` twin is
 *      emitted per call before dispatch (anthropic-direct/loop/tool-dispatch.ts),
 *      then one `tool_result` chunk per call. The `tool_result` is the round
 *      boundary: nothing before it is ever re-streamed.
 *
 * So `stream_retry` rolls back exactly the output since the last `tool_result`
 * (the same boundary the REPL uses in turn-handler.stream-events.ts), and
 * forgets the tool ids marked during that aborted attempt so their re-driven
 * twins mark again. Tool-marker dedup is scoped to one round for the same
 * reason.
 *
 * `thinking` chunks (extended-thinking output) are excluded on purpose: they
 * carry the model's private reasoning, not narration, and every other stream
 * consumer (chat's text output, the REPL) keeps them separate too. Folding
 * them in would contaminate the narration whatif measures.
 *
 * @module whatif/runner/afk-runner.stream
 */

/**
 * Parsed metadata from the stream-json `done` event.
 */
export interface StreamDoneMeta {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  durationMs?: number;
}

/**
 * Result from accumulateStreamJson, including whether a done event was seen.
 */
export interface AccumulateResult {
  text: string;
  meta: StreamDoneMeta;
  /** True iff a `done` event was present in the stream. */
  doneSeen: boolean;
}

/** Mutable accumulator state for one stream. */
interface AccState {
  /** Text segments and tool markers in document order. */
  parts: string[];
  /** Index into `parts` where the in-flight round began. */
  roundStart: number;
  /**
   * Tool ids already marked in the in-flight round. Scoped to the round:
   * every twin of a call arrives before the round's first `tool_result`, so
   * resetting at that boundary loses no dedup and tolerates an emitter that
   * reuses ids across rounds.
   */
  markedIds: Set<string>;
}

/** `tool_use_detail`: one marker per distinct `toolUseId` (pending + completed twins collapse). */
function onToolDetail(state: AccState, c: Record<string, unknown>): void {
  const marker = `[tool: ${c['toolName'] as string}]`;
  const id = typeof c['toolUseId'] === 'string' ? c['toolUseId'] : '';
  // Every emitter stamps an id (the Anthropic block id or the dispatched call
  // id), and only anthropic-direct emits twins. An id-less detail therefore
  // cannot be a twin; mark it unconditionally rather than collapsing distinct
  // id-less calls under a shared '' key.
  if (id === '') {
    state.parts.push(marker);
    return;
  }
  if (state.markedIds.has(id)) return;
  state.parts.push(marker);
  state.markedIds.add(id);
}

/** `tool_use` summary: fallback marker unless a detail already marked one of its ids. */
function onToolSummary(state: AccState, c: Record<string, unknown>): void {
  const m = c['metadata'];
  const rawIds = m !== null && typeof m === 'object'
    ? (m as Record<string, unknown>)['precedingToolUseIds']
    : undefined;
  const ids = Array.isArray(rawIds)
    ? rawIds.filter((id): id is string => typeof id === 'string' && id !== '')
    : [];
  if (ids.some((id) => state.markedIds.has(id))) return;
  state.parts.push(`[tool: ${c['content'] as string}]`);
  for (const id of ids) state.markedIds.add(id);
}

function onChunk(state: AccState, chunk: unknown): void {
  if (chunk === null || typeof chunk !== 'object') return;
  const c = chunk as Record<string, unknown>;
  const chunkType = c['type'];
  if (chunkType === 'content' && typeof c['content'] === 'string') {
    state.parts.push(c['content']);
  } else if (chunkType === 'tool_use_detail' && typeof c['toolName'] === 'string') {
    onToolDetail(state, c);
  } else if (chunkType === 'tool_use' && typeof c['content'] === 'string') {
    onToolSummary(state, c);
  } else if (chunkType === 'tool_result') {
    // Round boundary: everything so far is committed and never re-streamed.
    state.roundStart = state.parts.length;
    state.markedIds.clear();
  }
}

/** Roll back the aborted attempt of the in-flight round. */
function onStreamRetry(state: AccState): void {
  state.parts.length = state.roundStart;
  state.markedIds.clear();
}

function parseDoneMeta(rawMeta: unknown): StreamDoneMeta | null {
  if (rawMeta === null || typeof rawMeta !== 'object') return null;
  const m = rawMeta as Record<string, unknown>;
  const usage = m['usage'];
  let inputTokens = 0;
  let outputTokens = 0;
  if (usage !== null && typeof usage === 'object') {
    const u = usage as Record<string, unknown>;
    inputTokens = typeof u['input_tokens'] === 'number' ? u['input_tokens'] : 0;
    outputTokens = typeof u['output_tokens'] === 'number' ? u['output_tokens'] : 0;
  }
  return {
    costUsd: typeof m['totalCostUsd'] === 'number' ? m['totalCostUsd'] : 0,
    inputTokens,
    outputTokens,
    durationMs: typeof m['durationMs'] === 'number' ? m['durationMs'] : undefined,
  };
}

function parseLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== 'object') return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Parse the NDJSON stdout of `afk chat --format stream-json` into:
 *   - `text`: all assistant text segments joined, with `[tool: <name>]`
 *     markers inserted where tool calls occurred (in document order). Parallel
 *     calls with distinct `toolUseId`s each get a marker in arrival order;
 *     repeated events for the same id collapse to one.
 *   - `meta`: cost and token counts from the terminal `done` event.
 *   - `doneSeen`: whether a `done` event was present (false means a truncated
 *     stream).
 *
 * `stream_retry` discards the aborted attempt of the in-flight round (see the
 * module docstring for the ordering contract).
 *
 * Robustness: malformed lines are skipped; missing `done` yields zero meta.
 *
 * Exported for unit testing.
 */
export function accumulateStreamJson(stdout: string): AccumulateResult {
  const state: AccState = { parts: [], roundStart: 0, markedIds: new Set() };
  let meta: StreamDoneMeta = { costUsd: 0, inputTokens: 0, outputTokens: 0 };
  let doneSeen = false;

  for (const line of stdout.split('\n')) {
    const event = parseLine(line);
    if (event === null) continue;
    const type = event['type'];
    if (type === 'chunk') {
      onChunk(state, event['chunk']);
    } else if (type === 'stream_retry') {
      onStreamRetry(state);
    } else if (type === 'done') {
      doneSeen = true;
      meta = parseDoneMeta(event['metadata']) ?? meta;
    }
  }

  return { text: state.parts.join(''), meta, doneSeen };
}
