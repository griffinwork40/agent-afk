/**
 * Anthropic ⇄ journal adapter: maps the provider's native `MessageParam`
 * array to the provider-neutral {@link JournalMessage} format and back
 * (docs/message-journal.md).
 *
 * Invariant (round trip): for every array this provider produces,
 * `fromJournalMessages(arr.map(toJournal))` is send-equivalent — string
 * content becomes a single text block, `cache_control` / `citations` are
 * dropped (the loop re-stamps cache breakpoints per request), and every
 * thinking signature, tool_use input, and FULL tool_result payload survives.
 *
 * Lossy on purpose: blocks the journal has no kind for (`search_result`,
 * `server_tool_use`, `web_search_tool_result`, `container_upload`, …) are
 * recorded as a labelled text block so the audit record keeps their content;
 * on resume they replay as text, which the API always accepts.
 *
 * Provenance (#2464): `fromJournalMessages` records which journal messages
 * built each native message (a merge of consecutive same-role messages, plus
 * any message that mapped to nothing), and `adopt` hands those originals back
 * while the native is unedited. Thinking is stamped `origin: 'anthropic'`,
 * and signed thinking from another family is not replayed.
 *
 * @module agent/providers/anthropic-direct/journal-adapter
 */

import type {
  ContentBlockParam,
  DocumentBlockParam,
  ImageBlockParam,
  MessageParam,
  TextBlockParam,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources';
import type {
  JournalAdapter,
  JournalBinary,
  JournalBlock,
  JournalMessage,
  JournalResultPart,
} from '../../journal/index.js';
import { JournalProvenance } from '../../journal/index.js';
import { filterContentBlocks } from './resolve-params.js';

/** Provider family stamped on thinking blocks this adapter writes. */
export const ANTHROPIC_ORIGIN = 'anthropic';

type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
type ResultContentBlock = Exclude<ToolResultBlockParam['content'], string | undefined>[number];

// ─── native → journal ────────────────────────────────────────────────────────

function fallbackText(block: { type: string }): { type: 'text'; text: string } {
  const { type, ...rest } = block as Record<string, unknown> & { type: string };
  delete rest['cache_control'];
  return { type: 'text', text: `[${type}] ${JSON.stringify(rest)}` };
}

function imageToJournal(block: ImageBlockParam): JournalBlock & { type: 'image' } | { type: 'text'; text: string } {
  const s = block.source;
  if (s.type === 'file') return { type: 'text', text: `[image file_id=${s.file_id}]` };
  const source: JournalBinary =
    s.type === 'base64' ? { kind: 'base64', mediaType: s.media_type, data: s.data } : { kind: 'url', url: s.url };
  return { type: 'image', source };
}

/** Documents: PDFs stay binary; plain-text and content-sourced documents become text. */
function documentToJournal(block: DocumentBlockParam): JournalResultPart {
  const s = block.source;
  const title = block.title ?? undefined;
  const withTitle = (text: string): string => (title ? `[document: ${title}]\n${text}` : text);
  if (s.type === 'text') return { type: 'text', text: withTitle(s.data) };
  if (s.type === 'content') {
    const text = typeof s.content === 'string'
      ? s.content
      : s.content.map((c) => (c.type === 'text' ? c.text : '[image]')).join('\n');
    return { type: 'text', text: withTitle(text) };
  }
  if (s.type === 'file') return { type: 'text', text: withTitle(`[document file_id=${s.file_id}]`) };
  const source: JournalBinary =
    s.type === 'base64' ? { kind: 'base64', mediaType: s.media_type, data: s.data } : { kind: 'url', url: s.url };
  return { type: 'document', source, ...(title ? { title } : {}) };
}

function resultPartToJournal(block: ResultContentBlock): JournalResultPart {
  if (block.type === 'text') return { type: 'text', text: block.text };
  if (block.type === 'image') return imageToJournal(block);
  if (block.type === 'document') return documentToJournal(block);
  return fallbackText(block);
}

function toolResultToJournal(block: ToolResultBlockParam): JournalBlock {
  const c = block.content;
  const content: JournalResultPart[] =
    c === undefined ? [] : typeof c === 'string' ? [{ type: 'text', text: c }] : c.map(resultPartToJournal);
  return {
    type: 'tool_result',
    toolUseId: block.tool_use_id,
    ...(block.is_error !== undefined ? { isError: block.is_error } : {}),
    content,
  };
}

function blockToJournal(block: ContentBlockParam): JournalBlock {
  switch (block.type) {
    case 'text': return { type: 'text', text: block.text };
    case 'thinking': return { type: 'thinking', thinking: block.thinking, signature: block.signature, origin: ANTHROPIC_ORIGIN };
    case 'redacted_thinking': return { type: 'redacted_thinking', data: block.data, origin: ANTHROPIC_ORIGIN };
    case 'tool_use': return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
    case 'tool_result': return toolResultToJournal(block);
    case 'image': return imageToJournal(block);
    case 'document': return documentToJournal(block);
    default: return fallbackText(block);
  }
}

// ─── journal → native ────────────────────────────────────────────────────────

function binaryFallback(label: string, title?: string): TextBlockParam {
  return { type: 'text', text: `[${label}${title ? `: ${title}` : ''} unavailable on resume]` };
}

function imageFromJournal(source: JournalBinary): ImageBlockParam | TextBlockParam {
  if (source.kind === 'base64') {
    return { type: 'image', source: { type: 'base64', media_type: source.mediaType as ImageMediaType, data: source.data } };
  }
  if (source.kind === 'url') return { type: 'image', source: { type: 'url', url: source.url } };
  return binaryFallback('image');
}

function documentFromJournal(source: JournalBinary, title?: string): DocumentBlockParam | TextBlockParam {
  const t = title !== undefined ? { title } : {};
  if (source.kind === 'url') return { type: 'document', source: { type: 'url', url: source.url }, ...t };
  if (source.kind === 'base64') {
    if (source.mediaType === 'application/pdf') {
      return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: source.data }, ...t };
    }
    if (source.mediaType.startsWith('text/')) {
      const text = Buffer.from(source.data, 'base64').toString('utf8');
      return { type: 'document', source: { type: 'text', media_type: 'text/plain', data: text }, ...t };
    }
  }
  return binaryFallback('document', title);
}

/** Returns `undefined` for a part type this version does not know (newer writer); callers drop it. */
function resultPartFromJournal(part: JournalResultPart): ResultContentBlock | undefined {
  switch (part.type) {
    case 'text': return { type: 'text', text: part.text };
    case 'text_ref': return { type: 'text', text: part.preview };
    case 'image': return imageFromJournal(part.source);
    case 'document': return documentFromJournal(part.source, part.title);
    default: return undefined;
  }
}

function resultContentFromJournal(parts: readonly JournalResultPart[]): ResultContentBlock[] {
  return parts.map(resultPartFromJournal).filter((p): p is ResultContentBlock => p !== undefined);
}

/** Anthropic-written, or legacy (pre-#2464, no origin recorded). */
function ownOrigin(origin: string | undefined): boolean {
  return origin === undefined || origin === ANTHROPIC_ORIGIN;
}

/** Returns `null` for blocks this provider cannot replay (unsigned or foreign-signed thinking). */
function blockFromJournal(block: JournalBlock): ContentBlockParam | null {
  switch (block.type) {
    case 'text': return { type: 'text', text: block.text };
    case 'text_ref': return { type: 'text', text: block.preview };
    case 'thinking':
      // Cross-provider thinking has no Anthropic signature; the API rejects it.
      return block.signature && ownOrigin(block.origin)
        ? { type: 'thinking', thinking: block.thinking, signature: block.signature }
        : null;
    case 'redacted_thinking': return ownOrigin(block.origin) ? { type: 'redacted_thinking', data: block.data } : null;
    case 'tool_use': return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
    case 'tool_result': {
      const content = resultContentFromJournal(block.content);
      return {
        type: 'tool_result',
        tool_use_id: block.toolUseId,
        ...(block.isError !== undefined ? { is_error: block.isError } : {}),
        ...(content.length > 0 ? { content } : {}),
      };
    }
    case 'image': return imageFromJournal(block.source);
    case 'document': return documentFromJournal(block.source, block.title);
  }
}

function messageFromJournal(message: JournalMessage): MessageParam | null {
  const blocks = message.content.map(blockFromJournal).filter((b): b is ContentBlockParam => b !== null);
  // Final shape guard shared with the legacy resume path.
  const content = filterContentBlocks(blocks);
  return content.length > 0 ? { role: message.role, content } : null;
}

/**
 * Module-scope singleton shared across all concurrent sessions.
 *
 * Safety rationale (#2486): `JournalProvenance` is keyed by object identity
 * in a `WeakMap<T, Origin<T>>`. Each `JournalSync` instance holds its own
 * `MessageParam[]` array, so two concurrent sessions have disjoint key sets
 * by construction — a lookup in one session can never collide with records
 * from another. The singleton is safe here for the same reason a module-scope
 * `WeakMap` is always safe: isolation is structural, not temporal.
 *
 * If this ever needs to become per-`JournalSync` (e.g. to allow GC-ing records
 * mid-session), move the instantiation into `fromJournalMessages` or pass the
 * provenance instance as a constructor argument to the adapter.
 */
const provenance = new JournalProvenance<MessageParam>();

/**
 * The anthropic-direct {@link JournalAdapter}. Share one instance: its only
 * state is the identity-keyed provenance map, which is safe across runtimes.
 */
export const anthropicJournalAdapter: JournalAdapter<MessageParam> = {
  toJournal(message: MessageParam): JournalMessage {
    const content: JournalBlock[] = typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : message.content.map(blockToJournal);
    // The SDK's MessageParam.role now includes 'system'; the journal schema
    // only accepts 'user' | 'assistant'. Map system messages to 'user' — they
    // carry instructional content that replays correctly in the user role.
    const role: 'user' | 'assistant' = message.role === 'system' ? 'user' : message.role;
    return { role, content };
  },

  fromJournalMessages(messages: readonly JournalMessage[]): MessageParam[] {
    const out: MessageParam[] = [];
    // sources[i]: the journal messages native out[i] stands for. A message
    // that maps to nothing rides with the native before it (or the first one).
    const sources: JournalMessage[][] = [];
    let pending: JournalMessage[] = [];
    for (const m of messages) {
      const native = messageFromJournal(m);
      const last = sources[sources.length - 1];
      if (!native) {
        if (last) last.push(m);
        else pending.push(m);
        continue;
      }
      const prev = out[out.length - 1];
      // Anthropic requires role alternation: merge consecutive same-role
      // messages (cross-provider journals, or a message emptied above).
      if (prev && last && prev.role === native.role) {
        prev.content = [...(prev.content as ContentBlockParam[]), ...(native.content as ContentBlockParam[])];
        last.push(m);
      } else {
        out.push(native);
        sources.push([...pending, m]);
        pending = [];
      }
    }
    // After the loop: a merge reassigns `content`, and record() captures shape.
    out.forEach((native, i) => provenance.record(sources[i]!, [native]));
    return out;
  },

  adopt(messages: readonly MessageParam[], at: number) {
    return provenance.adopt(messages, at);
  },
};
