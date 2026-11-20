import type { OutputEvent } from '../../agent/types/session-types.js';
import type { ToolUseDetailChunk, ToolResultChunk, ToolDiffChunk } from '../../agent/types/message-types.js';
import type {
  FinishedTurn, SessionUpdate, TranslatorContext, TranslatorState, TurnMetadata,
  TranslatorToolState, ToolCallStart, StopReason,
} from './acp.wire.js';
import { toolKind, toolTitle, toolLocations } from './acp.tool-kind.js';
import { translateDiff } from './acp.diff.js';
import { inputRecord } from './acp.translate.paths.js';
import { boundedContent, boundedRawInput, boundedResult, boundStartDisplay, parseToolInput } from './acp.translate.bounds.js';

// Kept on the session state, not in a second global singleton/map. Public
// callers may pass an ordinary TranslatorState; the extension is optional.
const doneMetadata = Symbol('acp.doneMetadata');
type LocalState = TranslatorState & { [doneMetadata]?: TurnMetadata };

export function createTranslatorState(): TranslatorState {
  return { tools: new Map(), cancelled: false, cumulativeCostUsd: 0 };
}

function newTool(name: string): TranslatorToolState {
  const kind = toolKind(name);
  return { name, announced: false, content: [], status: kind === 'read' || kind === 'search' ? 'in_progress' : 'pending' };
}

/** A call the session will run without asking is already running when first announced. */
function initialStatus(st: TranslatorState, tool: TranslatorToolState): TranslatorToolState['status'] {
  if (!tool.name || st.requiresConsent === undefined) return tool.status;
  // D10: a read/search kind targeting a path outside the cwd is asked, so it starts pending too.
  return st.requiresConsent(tool.name, inputRecord(tool.input)) ? 'pending' : 'in_progress';
}

function startTool(id: string, tool: TranslatorToolState, ctx: TranslatorContext): ToolCallStart {
  tool.announced = true;
  const rawInput = boundedRawInput(tool.input);
  return boundStartDisplay({
    sessionUpdate: 'tool_call', toolCallId: id, title: toolTitle(tool.name, tool.input, ctx.cwd),
    ...(tool.name ? { name: tool.name } : {}), kind: toolKind(tool.name),
    status: tool.status, content: [...tool.content], locations: toolLocations(tool.name, tool.input, ctx.cwd),
    ...(rawInput !== undefined ? { rawInput } : {}),
  });
}

function translateDetail(chunk: ToolUseDetailChunk, st: TranslatorState, ctx: TranslatorContext): SessionUpdate[] {
  if (chunk.pending || !chunk.toolUseId) return [];
  const existing = st.tools.get(chunk.toolUseId);
  const tool = existing ?? newTool(chunk.toolName || '');
  const previousName = tool.name;
  const previousInput = JSON.stringify(tool.input);
  if (chunk.toolName) tool.name = chunk.toolName;
  const parsed = parseToolInput(chunk.toolInputRaw);
  if (parsed !== undefined) tool.input = parsed;
  st.tools.set(chunk.toolUseId, tool);
  if (!existing) tool.status = initialStatus(st, tool);
  if (!tool.announced) return [startTool(chunk.toolUseId, tool, ctx)];
  // Permission may already have painted/approved the call. Enrich a settled
  // detail without emitting a second start or regressing its status.
  if (previousName === tool.name && previousInput === JSON.stringify(tool.input)) return [];
  const { sessionUpdate: _tag, status: _status, content: _content, ...fields } = startTool(chunk.toolUseId, tool, ctx);
  return [{ sessionUpdate: 'tool_call_update', ...fields }];
}

function translateResult(chunk: ToolResultChunk, st: TranslatorState, ctx: TranslatorContext): SessionUpdate[] {
  if (!chunk.toolUseId) return [];
  const tool = st.tools.get(chunk.toolUseId) ?? newTool('');
  st.tools.set(chunk.toolUseId, tool);
  const updates: SessionUpdate[] = tool.announced ? [] : [startTool(chunk.toolUseId, tool, ctx)];
  const text = boundedResult(chunk.content);
  tool.status = chunk.isError ? 'failed' : 'completed';
  // A result replaces an earlier result, but never erases accumulated diffs.
  const previous = tool.content.filter(item => item.type === 'diff' ||
    (item.type === 'content' && item.content.type === 'text' && item.content.text === 'Diff omitted: exceeds transport limit'));
  tool.content = boundedContent([...previous, { type: 'content', content: { type: 'text', text } }]);
  updates.push({ sessionUpdate: 'tool_call_update', toolCallId: chunk.toolUseId, status: tool.status, rawOutput: text, content: [...tool.content] });
  return updates;
}

function translateToolDiff(chunk: ToolDiffChunk, st: TranslatorState, ctx: TranslatorContext): SessionUpdate[] {
  if (!chunk.toolUseId) return [];
  const tool = st.tools.get(chunk.toolUseId);
  if (!tool?.announced) return [];
  const diffs = translateDiff(chunk.diff, tool.input, ctx.cwd);
  if (diffs.length === 0) return [];
  tool.content = boundedContent([...tool.content, ...diffs]);
  // Content replaces the collection. No status here: diffs often arrive AFTER
  // the result, and must not turn completed/failed back into in_progress.
  return [{ sessionUpdate: 'tool_call_update', toolCallId: chunk.toolUseId, content: [...tool.content] }];
}

export function translateOutputEvent(ev: OutputEvent, st: TranslatorState, ctx: TranslatorContext): SessionUpdate[] {
  if (ev.type === 'done') {
    if (ev.metadata !== undefined) (st as LocalState)[doneMetadata] = ev.metadata;
    return [];
  }
  // Final message events duplicate streamed text. Summary/progress/lifecycle
  // markers are not provider reasoning and have no advertised ACP equivalent.
  if (ev.type !== 'chunk') return [];
  const chunk = ev.chunk;
  switch (chunk.type) {
    case 'content':
    case 'thinking':
      // An empty chunk carries nothing and some clients render it as a blank bubble.
      if (chunk.content.length === 0) return [];
      return [{ sessionUpdate: chunk.type === 'content' ? 'agent_message_chunk' : 'agent_thought_chunk', content: { type: 'text', text: chunk.content } }];
    case 'tool_use_detail': return translateDetail(chunk, st, ctx);
    case 'tool_result': return translateResult(chunk, st, ctx);
    case 'tool_diff': return translateToolDiff(chunk, st, ctx);
    default: return [];
  }
}

function stopReason(st: TranslatorState, meta: TurnMetadata | undefined): StopReason {
  if (st.cancelled || meta?.stopReason === 'interrupted' || meta?.stopReason === 'cancelled') return 'cancelled';
  if (['max_tokens', 'length', 'max_output_tokens'].includes(meta?.stopReason ?? '')) return 'max_tokens';
  if (['tool_use_loop_capped', 'max_turn_requests', 'max_turns_exceeded'].includes(meta?.stopReason ?? '') || meta?.resultSubtype === 'error_max_turns') return 'max_turn_requests';
  if (meta?.stopReason === 'refusal' || meta?.stopReason === 'content_filter') return 'refusal';
  return 'end_turn';
}

function safeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function finishTurn(st: TranslatorState, meta?: TurnMetadata): FinishedTurn {
  const metadata = meta ?? (st as LocalState)[doneMetadata];
  delete (st as LocalState)[doneMetadata];
  const cost = metadata?.totalCostUsd;
  const cumulative = st.cumulativeCostUsd ?? 0;
  if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 && Number.isFinite(cumulative + cost) && cumulative >= 0) {
    st.cumulativeCostUsd = cumulative + cost;
  } else st.costIncomplete = true;
  const used = metadata?.usage?.['context_window_tokens'];
  const size = st.contextWindowSize;
  const updates: SessionUpdate[] = [];
  if (safeCount(used) && safeCount(size)) {
    updates.push({ sessionUpdate: 'usage_update', used, size,
      ...(!st.costIncomplete && st.cumulativeCostUsd !== undefined
        ? { cost: { amount: st.cumulativeCostUsd, currency: 'USD' as const } } : {}),
    });
  }
  return { updates, stopReason: stopReason(st, metadata) };
}
