/**
 * OpenAI-compatible ↔ message-journal adapter (docs/message-journal.md).
 *
 * Native shapes this provider keeps in `priorTurns` (see loop.ts and
 * query/dispatch-append.ts; `OpenAIMessage` does not model all of them, so
 * the push sites cast and this module reads them structurally):
 *   - user:      `{ role:'user', content: string | OpenAIContentPart[] }`
 *                (real input, harness notes, and the tool-image follow-up)
 *   - assistant: `{ role:'assistant', content: string | null,
 *                   tool_calls?: [{ id, type:'function', function:{ name, arguments } }],
 *                   reasoning_content? }`
 *   - tool:      `{ role:'tool', tool_call_id, content: string }`, errors
 *                prefixed `[error] ` (loop.ts toolResultsToMessages)
 *   - system:    never in `priorTurns`; mapped to `null` defensively.
 *
 * Invariant: `toJournal` maps one native message to one journal message; a
 * `tool` message becomes a `user` message holding exactly one tool_result.
 * `fromJournalMessages` re-groups: a journal user message with N tool_results
 * becomes N `tool` messages (in order) followed by one user message carrying
 * any remaining text / images, so Anthropic-written journals (which batch
 * tool_results into one user message) replay with valid OpenAI alternation.
 *
 * Every replayed assistant tool call gets a `tool` message: a call the
 * journal never recorded a result for (session died mid-dispatch) is answered
 * with a synthetic `[error]` result, since the API rejects an unanswered one.
 *
 * Tool-call arguments are parsed to an object for the journal; a payload that
 * is not valid JSON is preserved verbatim as `{ _raw: <string> }` and replayed
 * as the same string. Images stay `image_url` parts; buildMessages() already
 * down-converts them to a text notice for non-vision models.
 *
 * Provenance (#2464): `fromJournalMessages` records the natives each journal
 * message fanned out to, and `adopt` hands the ORIGINAL journal message back
 * while that span is intact, so thinking signatures, redacted thinking and
 * documents this wire cannot carry survive an A→B→A provider switch. The
 * synthetic `[error]` results from the repair step have no provenance and are
 * journaled as new messages.
 *
 * @module agent/providers/openai-compatible/journal-adapter
 */

import type {
  JournalAdapter,
  JournalBinary,
  JournalBlock,
  JournalMessage,
  JournalResultPart,
} from '../../journal/index.js';
import { JournalProvenance, readResultFlags, tagResultFlags } from '../../journal/index.js';
import type { OpenAIContentPart, OpenAIMessage } from './messages.js';

interface NativeToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

const ERROR_PREFIX = '[error] ';
/** Provider family stamped on thinking this adapter writes (it never has a signature). */
export const OPENAI_COMPATIBLE_ORIGIN = 'openai-compatible';

/**
 * Encode the reasoning wire field into the thinking block's `origin` tag so
 * `assistantFromJournal` can restore the correct echo key on resume.
 *
 * Format: `openai-compatible:<field>` where `<field>` is `reasoning_content`
 * (DeepSeek) or `reasoning` (Cerebras). The tag is stable across provider
 * versions and additive — journals written before this change have
 * `origin: 'openai-compatible'` (no suffix) and are replayed under
 * `reasoning_content` for backward compatibility.
 */
function encodeReasoningOrigin(field: 'reasoning_content' | 'reasoning'): string {
  return `${OPENAI_COMPATIBLE_ORIGIN}:${field}`;
}

/**
 * Decode the reasoning wire field from a thinking block's `origin`. Returns
 * `'reasoning_content'` for legacy entries (origin = `'openai-compatible'` or
 * undefined) so old journals resume cleanly against DeepSeek.
 */
function decodeReasoningField(origin: string | undefined): 'reasoning_content' | 'reasoning' {
  if (origin === `${OPENAI_COMPATIBLE_ORIGIN}:reasoning`) return 'reasoning';
  return 'reasoning_content';
}
const RAW_KEY = '_raw';

function toolCallsOf(msg: OpenAIMessage): NativeToolCall[] | undefined {
  const tc = msg.tool_calls;
  return Array.isArray(tc) && tc.length > 0 ? (tc as NativeToolCall[]) : undefined;
}

function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return { [RAW_KEY]: raw };
  }
}

function stringifyArguments(input: unknown): string {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const keys = Object.keys(input);
    const raw = (input as Record<string, unknown>)[RAW_KEY];
    if (keys.length === 1 && typeof raw === 'string') return raw;
  }
  return JSON.stringify(input ?? {});
}

/** `data:<mime>;base64,<data>` → base64 source; anything else → url source. */
function urlToBinary(url: string): JournalBinary {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  return m ? { kind: 'base64', mediaType: m[1]!, data: m[2]! } : { kind: 'url', url };
}

function binaryToUrl(source: JournalBinary): string | null {
  if (source.kind === 'base64') return `data:${source.mediaType};base64,${source.data}`;
  if (source.kind === 'url') return source.url;
  return null; // unhydrated ref: input is contractually hydrated
}

function contentToBlocks(content: unknown): JournalBlock[] {
  if (typeof content === 'string') return content.length > 0 ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  const blocks: JournalBlock[] = [];
  for (const part of content as OpenAIContentPart[]) {
    if (part.type === 'text') blocks.push({ type: 'text', text: part.text });
    else if (part.type === 'image_url') blocks.push({ type: 'image', source: urlToBinary(part.image_url.url) });
  }
  return blocks;
}

function assistantToJournal(msg: OpenAIMessage): JournalMessage {
  const content: JournalBlock[] = [];
  // Persist the reasoning wire field in the thinking block's origin tag so
  // assistantFromJournal can restore the correct echo key on resume. Cerebras
  // uses `reasoning`; DeepSeek uses `reasoning_content`. Both are encoded as
  // `openai-compatible:<field>` for easy lossless round-tripping.
  if (typeof msg.reasoning === 'string' && msg.reasoning.length > 0) {
    content.push({ type: 'thinking', thinking: msg.reasoning, origin: encodeReasoningOrigin('reasoning') });
  } else if (typeof msg.reasoning_content === 'string' && msg.reasoning_content.length > 0) {
    content.push({ type: 'thinking', thinking: msg.reasoning_content, origin: encodeReasoningOrigin('reasoning_content') });
  }
  content.push(...contentToBlocks(msg.content));
  for (const tc of toolCallsOf(msg) ?? []) {
    content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: parseArguments(tc.function.arguments) });
  }
  return { role: 'assistant', content };
}

function toolToJournal(msg: OpenAIMessage): JournalMessage {
  const text = typeof msg.content === 'string'
    ? msg.content
    : contentToBlocks(msg.content).map((b) => (b.type === 'text' ? b.text : '')).join('\n');
  const block: JournalBlock = {
    type: 'tool_result',
    toolUseId: msg.tool_call_id ?? '',
    // Harness-only partial flags (#2978), tagged by loop.ts toolResultsToMessages.
    ...readResultFlags(msg),
    content: [{ type: 'text', text }],
  };
  if (text.startsWith(ERROR_PREFIX)) block.isError = true;
  return { role: 'user', content: [block] };
}

function toJournal(msg: OpenAIMessage): JournalMessage | null {
  switch (msg.role) {
    case 'system':
      return null;
    case 'assistant':
      return assistantToJournal(msg);
    case 'tool':
      return toolToJournal(msg);
    default:
      return { role: 'user', content: contentToBlocks(msg.content) };
  }
}

function documentText(block: Extract<JournalBlock, { type: 'document' }>): string {
  const title = block.title ?? 'document';
  const mediaType = block.source.kind === 'url' ? 'url' : block.source.kind === 'base64' ? block.source.mediaType : block.source.ref.mediaType;
  return `[Document: ${title}, type: ${mediaType} — content not available for this provider]`;
}

/** Render user-side parts. One text-only part collapses to the plain string wire shape. */
function partsToContent(parts: OpenAIContentPart[]): string | OpenAIContentPart[] {
  if (parts.some((p) => p.type === 'image_url')) return parts;
  return parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
}

function pushUserBlock(parts: OpenAIContentPart[], block: JournalBlock | JournalResultPart): void {
  if (block.type === 'text') parts.push({ type: 'text', text: block.text });
  else if (block.type === 'text_ref') parts.push({ type: 'text', text: block.preview });
  else if (block.type === 'document') parts.push({ type: 'text', text: documentText(block) });
  else if (block.type === 'image') {
    const url = binaryToUrl(block.source);
    if (url !== null) parts.push({ type: 'image_url', image_url: { url } });
  }
}

function toolResultMessage(block: Extract<JournalBlock, { type: 'tool_result' }>, images: OpenAIContentPart[]): OpenAIMessage {
  const texts: string[] = [];
  for (const part of block.content) {
    if (part.type === 'text') texts.push(part.text);
    else if (part.type === 'text_ref') texts.push(part.preview);
    else pushUserBlock(images, part); // images/documents cannot ride a `tool` message
  }
  let text = texts.join('\n');
  if (block.isError === true && !text.startsWith(ERROR_PREFIX)) text = ERROR_PREFIX + text;
  const native: OpenAIMessage = { role: 'tool', tool_call_id: block.toolUseId, content: text };
  tagResultFlags(native, block); // survive resume so a resync re-writes them (#2978)
  return native;
}

function userFromJournal(msg: JournalMessage, out: OpenAIMessage[]): void {
  const parts: OpenAIContentPart[] = [];
  const toolImages: OpenAIContentPart[] = [];
  for (const block of msg.content) {
    if (block.type === 'tool_result') out.push(toolResultMessage(block, toolImages));
    else pushUserBlock(parts, block);
  }
  if (toolImages.length > 0) parts.unshift({ type: 'text', text: 'Image output from tool calls (referenced above):' }, ...toolImages);
  const hadToolResults = msg.content.some((b) => b.type === 'tool_result');
  if (parts.length === 0 && hadToolResults) return;
  out.push({ role: 'user', content: partsToContent(parts) });
}

function assistantFromJournal(msg: JournalMessage): OpenAIMessage {
  const texts: string[] = [];
  // reasoning blocks may arrive from different providers, each encoded with
  // its origin field name (e.g. 'openai-compatible:reasoning' for Cerebras).
  // Group by field so mixed journals are unlikely but safe.
  const reasoningByField = new Map<'reasoning_content' | 'reasoning', string[]>();
  const toolCalls: NativeToolCall[] = [];
  for (const block of msg.content) {
    if (block.type === 'text') texts.push(block.text);
    else if (block.type === 'text_ref') texts.push(block.preview);
    else if (block.type === 'thinking') {
      const field = decodeReasoningField(block.origin);
      const bucket = reasoningByField.get(field) ?? [];
      bucket.push(block.thinking);
      reasoningByField.set(field, bucket);
    } else if (block.type === 'tool_use') {
      toolCalls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: stringifyArguments(block.input) } });
    }
    // redacted_thinking / images / documents: not replayable on this wire.
  }
  const text = texts.join('\n');
  const out: Record<string, unknown> = { role: 'assistant', content: toolCalls.length > 0 && text.length === 0 ? null : text };
  if (toolCalls.length > 0) out['tool_calls'] = toolCalls;
  // Echo each reasoning bucket under its original wire field to avoid HTTP 400
  // from providers that reject foreign field names in history.
  for (const [field, chunks] of reasoningByField) {
    if (chunks.length > 0) out[field] = chunks.join('\n');
  }
  return out as unknown as OpenAIMessage;
}

/** Synthetic result for a tool call the journal never recorded a result for. */
export const INTERRUPTED_TOOL_RESULT = ERROR_PREFIX + 'tool call was interrupted before a result was recorded';

/**
 * Pair every assistant `tool_calls` id with a `tool` message before the next
 * assistant message: the API rejects an unanswered call (HTTP 400). A journal
 * ends in one when the session died mid-tool-dispatch. The synthetic `tool`
 * message goes right after that assistant's existing `tool` messages.
 */
function repairUnansweredToolCalls(msgs: OpenAIMessage[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  for (let i = 0; i < msgs.length; i++) {
    const msg = msgs[i]!;
    out.push(msg);
    const calls = msg.role === 'assistant' ? toolCallsOf(msg) : undefined;
    if (!calls) continue;
    const answered = new Set<string>();
    let j = i + 1;
    for (; j < msgs.length && msgs[j]!.role !== 'assistant'; j++) {
      const id = msgs[j]!.tool_call_id;
      if (msgs[j]!.role === 'tool' && id !== undefined) answered.add(id);
    }
    let k = i + 1;
    while (k < j && msgs[k]!.role === 'tool') out.push(msgs[k++]!);
    for (const tc of calls) {
      if (!answered.has(tc.id)) out.push({ role: 'tool', tool_call_id: tc.id, content: INTERRUPTED_TOOL_RESULT });
    }
    i = k - 1;
  }
  return out;
}

const provenance = new JournalProvenance<OpenAIMessage>();

function fromJournalMessages(messages: readonly JournalMessage[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  const spans: Array<{ source: JournalMessage; members: OpenAIMessage[] }> = [];
  for (const msg of messages) {
    const start = out.length;
    if (msg.role === 'assistant') out.push(assistantFromJournal(msg));
    else userFromJournal(msg, out);
    spans.push({ source: msg, members: out.slice(start) });
  }
  // Repair can insert a synthetic result INSIDE a span; adopt() then sees the
  // span as broken and that span maps fresh, which keeps tool pairing valid.
  for (const { source, members } of spans) provenance.record([source], members);
  return repairUnansweredToolCalls(out);
}

function adopt(messages: readonly OpenAIMessage[], at: number): ReturnType<typeof provenance.adopt> {
  return provenance.adopt(messages, at);
}

export const openAIJournalAdapter: JournalAdapter<OpenAIMessage> = { toJournal, fromJournalMessages, adopt };
