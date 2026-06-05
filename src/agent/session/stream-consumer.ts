/**
 * Provider-event → OutputEvent transforms.
 *
 * Pure mapping from the normalized `ProviderEvent` dialect (declared in
 * `src/agent/provider.ts`) to the `OutputEvent` shape that
 * {@link IAgentSession.sendMessageStream} yields.
 *
 * No queue, no background task, no async iteration — just a synchronous
 * switch that `sendMessageStream` calls once per event.
 *
 * @module agent/session/stream-consumer
 */

import type { ProviderEvent, ProviderUsage } from '../provider.js';
import type {
  Message,
  OutputEvent,
  PermissionMode,
  ResponseMetadata,
  SessionMetadata,
} from '../types.js';
import { BudgetExceededError } from '../../utils/errors.js';
import { emitBudget } from '../trace/emit.js';
import type { TraceWriter } from '../trace/index.js';
import { renderToolResult } from '../tools/render-registry.js';

/** Callbacks the transform needs to produce side effects. */
export type TransformDeps = {
  conversationHistory: Message[];
  getSessionMetadata: () => SessionMetadata;
  setSessionMetadata: (updater: (prev: SessionMetadata) => SessionMetadata) => void;
  updateSessionIdentity: (sessionId?: string) => void;
  resolveInitialization: () => void;
  setLastResponseMetadata: (metadata: ResponseMetadata) => void;
  /**
   * Hard cost ceiling in USD. Accumulated across `turn.completed` events;
   * when crossed, `abortBudget()` is called and the stream loop exits.
   */
  maxBudgetUsd?: number;
  /**
   * Called when `maxBudgetUsd` is exceeded. Implementors should abort the
   * session's internal AbortController.
   */
  abortBudget?: (reason: string) => void;
  /**
   * Internal accumulator for running session cost. Mutated by
   * `transformProviderEvent` on each `turn.completed` event. Callers should
   * pass the same `deps` object across all calls within one session loop.
   */
  _runningCostUsd?: number;
  /**
   * Witness-layer trace writer. When provided, a `budget` event fires on
   * the same turn that crosses `maxBudgetUsd`, before `abortBudget` runs.
   * The event is the threshold-breach record; the subsequent abort + the
   * later `closure: budget_exceeded` are the termination records. Today
   * the only `kind` emitted is `'monetary'`.
   */
  traceWriter?: TraceWriter;
};

/**
 * Parse persisted output envelope from SDK tool results.
 * Extracts size label, size in bytes, and file path.
 * @returns Parsed envelope data or null if not a persisted output format
 */
export function parsePersistedOutput(
  content: string,
): { sizeLabel: string; sizeBytes: number; absolutePath: string } | null {
  const regex = /Output too large \((\d+(?:\.\d+)?)\s*(B|KB|MB|GB)\)\.\s*Full output saved to:\s*(\/[^\n]+)/;
  const match = content.match(regex);

  if (!match || !match[1] || !match[2] || !match[3]) {
    return null;
  }

  const sizeStr = match[1];
  const unit = match[2];
  const path = match[3];
  const sizeNum = parseFloat(sizeStr);

  let sizeBytes = sizeNum;
  if (unit === 'KB') {
    sizeBytes = sizeNum * 1024;
  } else if (unit === 'MB') {
    sizeBytes = sizeNum * 1024 * 1024;
  } else if (unit === 'GB') {
    sizeBytes = sizeNum * 1024 * 1024 * 1024;
  }

  let sizeLabel = sizeStr;
  if (sizeNum % 1 === 0) {
    sizeLabel = String(Math.floor(sizeNum));
  }
  sizeLabel += unit;

  return {
    sizeLabel,
    sizeBytes: Math.round(sizeBytes),
    absolutePath: path.trim(),
  };
}

function formatByteSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`;
  }
  const kb = bytes / 1024;
  if (kb < 1024) {
    return kb % 1 === 0 ? `${Math.floor(kb)}KB` : `${kb.toFixed(1)}KB`;
  }
  const mb = kb / 1024;
  if (mb < 1024) {
    return mb % 1 === 0 ? `${Math.floor(mb)}MB` : `${mb.toFixed(1)}MB`;
  }
  const gb = mb / 1024;
  return gb % 1 === 0 ? `${Math.floor(gb)}GB` : `${gb.toFixed(1)}GB`;
}

function truncateContent(
  content: string,
): { content: string; truncated: boolean; lineCount?: number; sizeBytes: number; sizeLabel: string } {
  const sizeBytes = Buffer.byteLength(content, 'utf8');
  const sizeLabel = formatByteSize(sizeBytes);

  const lines = content.split('\n');
  if (lines.length <= 1 && content.length <= 80) {
    return { content, truncated: false, sizeBytes, sizeLabel };
  }

  if (lines.length <= 1) {
    if (content.length <= 80) {
      return { content, truncated: false, sizeBytes, sizeLabel };
    }
    const truncated = content.substring(0, 80) + '…';
    return { content: truncated, truncated: true, sizeBytes, sizeLabel };
  }

  if (content.length <= 80) {
    return { content, truncated: false, sizeBytes, sizeLabel };
  }

  const firstLine = lines[0] ?? '';
  let preview = firstLine;
  if (firstLine.length > 80) {
    preview = firstLine.substring(0, 80) + '…';
  }
  const truncatedContent = preview + `…+${lines.length} lines`;
  return { content: truncatedContent, truncated: true, lineCount: lines.length, sizeBytes, sizeLabel };
}

export function usageToMetadata(usage: ProviderUsage, sessionId: string | undefined): ResponseMetadata {
  const usageObj: Record<string, unknown> = { ...(usage.raw ?? {}) };
  if (usage.inputTokens !== undefined) usageObj['input_tokens'] = usage.inputTokens;
  if (usage.outputTokens !== undefined) usageObj['output_tokens'] = usage.outputTokens;
  if (usage.cachedInputTokens !== undefined) usageObj['cache_read_input_tokens'] = usage.cachedInputTokens;
  if (usage.cacheCreationTokens !== undefined) usageObj['cache_creation_input_tokens'] = usage.cacheCreationTokens;
  if (usage.totalTokens !== undefined) usageObj['total_tokens'] = usage.totalTokens;
  // Context-window footprint (last-round occupancy, provider-computed). Carried
  // so the REPL footer's context-% (computed from local stats, not the SDK
  // sampler) matches the live status line. See cli/slash/session-stats.ts.
  if (usage.contextWindowTokens !== undefined) usageObj['context_window_tokens'] = usage.contextWindowTokens;

  return {
    sessionId,
    stopReason: usage.stopReason ?? undefined,
    resultSubtype: usage.resultSubtype,
    durationMs: usage.durationMs,
    durationApiMs: usage.durationApiMs,
    totalCostUsd: usage.totalCostUsd,
    isError: usage.isError,
    usage: Object.keys(usageObj).length > 0 ? usageObj : undefined,
    modelUsage: usage.modelUsage,
    permissionDenials: usage.permissionDenials,
    errors: usage.errors,
  };
}

function buildToolOutputEvent(
  event: Extract<ProviderEvent, { type: 'tool.output' }>,
): OutputEvent {
  // Per-tool display formatter (e.g. memory tools' JSON → "3 results
  // (2 facts, 1 procedure)") runs here, BEFORE `truncateContent` mangles
  // single-line content over 80 chars. The formatter sees the raw
  // handler output and produces a short string; the renderer surfaces it
  // via `chunk.display`. Skipped for error results so the user sees the
  // actual error text instead of a stale success summary. Registry lookup
  // is keyed on `toolName`; if the provider didn't supply one (OpenAI
  // Codex synthesizes some events without it), `renderToolResult`
  // returns null and we fall through to the existing pipeline.
  const display =
    event.isError === true
      ? null
      : renderToolResult(event.toolName, event.content);
  const displayPassthrough = display !== null ? { display } : {};

  const parsed = parsePersistedOutput(event.content);
  if (parsed) {
    return {
      type: 'chunk',
      chunk: {
        type: 'tool_result',
        toolUseId: event.toolUseId,
        content: `Output persisted (${parsed.sizeLabel}) → ${parsed.absolutePath}`,
        isError: event.isError === true,
        persistedPath: parsed.absolutePath,
        sizeBytes: parsed.sizeBytes,
        sizeLabel: parsed.sizeLabel,
        ...displayPassthrough,
      },
    };
  }

  // Invariant: `chunk.truncated` reflects the HANDLER's overflow signal
  // (`event.truncated`, plumbed from `ToolResult.truncated`) — NOT the
  // local 80-char display clip computed below. The display clip is a
  // cosmetic preview for the live tool-lane; its size is implicit in
  // `lineCount` and `content` length, and the renderer reads those.
  // Routing the overflow signal through `chunk.truncated` is what lets
  // subagent traces (handle.ts records `chunk.truncated`) distinguish
  // "got 100KB of legitimate output" from "got 100KB then killed"
  // without substring-scanning content for the `[output truncated …]`
  // sentinel. Prior versions conflated this field with display clipping;
  // see PR introducing `ToolResult.truncated` for the rationale.
  const { content: previewContent, lineCount, sizeBytes, sizeLabel } = truncateContent(event.content);
  return {
    type: 'chunk',
    chunk: {
      type: 'tool_result',
      toolUseId: event.toolUseId,
      content: previewContent,
      isError: event.isError === true,
      sizeBytes,
      sizeLabel,
      ...(event.truncated === true && { truncated: true }),
      ...(lineCount !== undefined && { lineCount }),
      ...displayPassthrough,
    },
  };
}

/**
 * Transform a single `ProviderEvent` into an `OutputEvent` (or null for
 * events that don't produce user-visible output like `session.status`).
 *
 * Side effects (conversation history, metadata, initialization) are
 * dispatched through the `deps` callbacks synchronously.
 */
export function transformProviderEvent(
  event: ProviderEvent,
  deps: TransformDeps,
): OutputEvent | null {
  switch (event.type) {
    case 'session.init': {
      const info = event.info;
      deps.setSessionMetadata((prev) => ({
        ...prev,
        sessionId: info.sessionId,
        model: info.model ?? prev.model,
        ...(info.permissionMode !== undefined
          ? { permissionMode: info.permissionMode as PermissionMode }
          : {}),
        ...(info.cwd !== undefined ? { cwd: info.cwd } : {}),
        tools: info.tools ? [...info.tools] : prev.tools,
        slashCommands: info.slashCommands ? [...info.slashCommands] : prev.slashCommands,
        skills: info.skills ? [...info.skills] : prev.skills,
        plugins: info.plugins ? info.plugins.map((p) => ({ ...p })) : prev.plugins,
        mcpServers: info.mcpServers ? info.mcpServers.map((s) => ({ ...s })) : prev.mcpServers,
        ...(info.apiKeySource !== undefined
          ? { apiKeySource: info.apiKeySource as SessionMetadata['apiKeySource'] }
          : {}),
        ...(info.version !== undefined ? { claudeCodeVersion: info.version } : {}),
        ...(info.outputStyle !== undefined ? { outputStyle: info.outputStyle } : {}),
      }));
      deps.updateSessionIdentity(info.sessionId);
      deps.resolveInitialization();
      return null;
    }

    case 'session.status': {
      deps.setSessionMetadata((prev) => ({
        ...prev,
        sessionId: event.sessionId,
        ...(event.permissionMode !== undefined
          ? { permissionMode: event.permissionMode as PermissionMode }
          : { permissionMode: prev.permissionMode }),
        ...(event.status !== undefined
          ? { status: event.status as SessionMetadata['status'] }
          : {}),
      }));
      return null;
    }

    case 'delta.text':
      return {
        type: 'chunk',
        chunk: {
          type: 'content',
          content: event.text,
          metadata: { eventType: 'delta', deltaType: 'text_delta' },
        },
      };

    case 'delta.reasoning':
      return {
        type: 'chunk',
        chunk: {
          type: 'thinking',
          content: event.text,
          metadata: { eventType: 'delta', deltaType: 'thinking_delta' },
        },
      };

    case 'assistant.message':
      if (event.sessionId) deps.updateSessionIdentity(event.sessionId);
      if (event.text) {
        const assistantMessage: Message = { role: 'assistant', content: event.text, timestamp: new Date() };
        deps.conversationHistory.push(assistantMessage);
        return { type: 'message', message: assistantMessage };
      }
      return null;

    case 'tool.use.start':
      return {
        type: 'chunk',
        chunk: {
          type: 'tool_use_detail',
          toolUseId: event.toolUseId,
          toolName: event.toolName,
          toolInput: event.toolInput,
        },
      };

    case 'tool.use':
      return {
        type: 'chunk',
        chunk: {
          type: 'tool_use',
          content: event.summary,
          metadata: {
            eventType: 'tool_use_summary',
            precedingToolUseIds: event.toolUseIds,
          },
        },
      };

    case 'tool.output':
      return buildToolOutputEvent(event);

    case 'tool.diff':
      // Sidecar render-only event — passes through verbatim. The CLI
      // `tool-lane` attaches the diff to the already-rendered tool result
      // by `toolUseId`; other surfaces (Telegram, JSON output) can ignore
      // it without breaking the legacy event stream.
      return {
        type: 'chunk',
        chunk: {
          type: 'tool_diff',
          toolUseId: event.toolUseId,
          diff: event.diff,
        },
      };

    case 'progress':
      return {
        type: 'progress',
        progress: {
          taskId: event.progress.taskId,
          description: event.progress.description,
          ...(event.progress.summary !== undefined ? { summary: event.progress.summary } : {}),
          ...(event.progress.lastToolName !== undefined
            ? { lastToolName: event.progress.lastToolName }
            : {}),
          totalTokens: event.progress.totalTokens,
          toolUses: event.progress.toolUses,
          durationMs: event.progress.durationMs,
        },
      };

    case 'suggestion':
      return { type: 'suggestion', suggestion: event.suggestion };

    case 'turn.completed': {
      const metadata = usageToMetadata(event.usage, event.sessionId ?? deps.getSessionMetadata().sessionId);
      deps.setLastResponseMetadata(metadata);

      for (let i = deps.conversationHistory.length - 1; i >= 0; i--) {
        const msg = deps.conversationHistory[i];
        if (msg?.role === 'assistant') {
          msg.metadata = metadata;
          break;
        }
      }

      // Budget enforcement (C6): accumulate cost across turns and abort once
      // the session-level running total crosses the ceiling. runningCostUsd is
      // tracked on deps so it persists across calls within one session loop.
      //
      // `metadata.totalCostUsd` is populated by toProviderUsage() from the
      // model pricing table when the model id is known. When cost is
      // unavailable (unknown model / openai-compatible adapter) it will be
      // `undefined` and we skip the gate.
      if (
        deps.maxBudgetUsd !== undefined &&
        deps.abortBudget !== undefined &&
        typeof metadata.totalCostUsd === 'number'
      ) {
        deps._runningCostUsd = (deps._runningCostUsd ?? 0) + metadata.totalCostUsd;
        if (deps._runningCostUsd >= deps.maxBudgetUsd) {
          // Witness layer: emit the threshold-breach record BEFORE the
          // controller aborts. Three reasons for the ordering:
          //   1. The abort cascade (and its own `abort` event) follows
          //      naturally; a trace reader can correlate the budget
          //      breach to the abort that immediately succeeds it.
          //   2. abortBudget short-circuits the stream — if we emitted
          //      after the abort, a fast-cancelling provider could close
          //      before the budget event lands.
          //   3. The closure event (reason: 'budget_exceeded') fires at
          //      session termination; the budget event is the in-flight
          //      record of the threshold being crossed, distinct from
          //      the terminal record.
          void emitBudget(deps.traceWriter, {
            kind: 'monetary',
            runningCostUsd: deps._runningCostUsd,
            maxBudgetUsd: deps.maxBudgetUsd,
            lastTurnCostUsd: metadata.totalCostUsd,
          });
          const err = new BudgetExceededError(deps._runningCostUsd, deps.maxBudgetUsd);
          deps.abortBudget(err.message);
          return { type: 'error', error: err };
        }
      }

      return { type: 'done', metadata };
    }

    case 'error':
      return { type: 'error', error: event.error };

    case 'paused':
      return {
        type: 'paused',
        reason: event.reason,
        ...(event.resetsAt !== undefined ? { resetsAt: event.resetsAt } : {}),
        ...(event.accountId !== undefined ? { accountId: event.accountId } : {}),
        ...(event.autoResume !== undefined ? { autoResume: event.autoResume } : {}),
      };

    case 'resumed':
      return {
        type: 'resumed',
        hotSwapped: event.hotSwapped,
        ...(event.accountId !== undefined ? { accountId: event.accountId } : {}),
      };

    case 'stream.retry':
      return { type: 'stream_retry' };

    default:
      return null;
  }
}
