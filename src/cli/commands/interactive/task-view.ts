/**
 * Task-view replay renderer.
 *
 * Renders a subagent's conversation history to a terminal string via the
 * memory path: takes a `Message[]` array already held in memory and renders
 * each message using renderMarkdownToTerminal.
 *
 * Emits a header box, the body, and a footer separator, and returns a
 * fully-assembled string so callers can page, write, or stream it as they
 * see fit.
 *
 * @module cli/commands/interactive/task-view
 */

import { palette } from '../../palette.js';
import { renderMarkdownToTerminal } from '../../formatter.js';
import { getTerminalWidth } from '../../terminal-size.js';
import { toolCard } from '../../render/tool-card.js';
import type { Message } from '../../../agent/types/message-types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TaskViewHeader {
  /** Background job / subagent ID. */
  id: string;
  /** Human-readable agent type label (e.g. "background", "worktree"). */
  agentType?: string;
  /** Model identifier used by this subagent. */
  model?: string;
  /** Job status string (e.g. "completed", "running", "failed"). */
  status: string;
  /** Wall-clock duration in milliseconds. */
  durationMs?: number;
  /** Number of tool-use calls recorded. */
  toolCount?: number;
  /** Number of conversation turns. */
  turnCount?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Truncation limit for tool input / result previews (characters). */
const CONTENT_PREVIEW_CHARS = 200;

// ---------------------------------------------------------------------------
// Header / footer helpers
// ---------------------------------------------------------------------------

/**
 * Build the header box string for a task-view panel.
 * Width is clamped to the current terminal width.
 */
function buildHeader(h: TaskViewHeader): string {
  const width = Math.min(getTerminalWidth(), 100);
  const sep = palette.dim('─'.repeat(width));

  const statusColor =
    h.status === 'completed' ? palette.success :
    h.status === 'failed'    ? palette.error   :
    h.status === 'running'   ? palette.info    :
    palette.dim;

  const parts: string[] = [];
  parts.push(palette.bold(`Subagent: ${h.id}`));
  if (h.agentType) parts.push(palette.dim(`type: ${h.agentType}`));
  if (h.model)     parts.push(palette.dim(`model: ${h.model}`));
  parts.push(`status: ${statusColor(h.status)}`);
  if (h.durationMs !== undefined) {
    parts.push(palette.dim(`duration: ${formatMs(h.durationMs)}`));
  }
  if (h.toolCount !== undefined) {
    parts.push(palette.dim(`tools: ${h.toolCount}`));
  }
  if (h.turnCount !== undefined) {
    parts.push(palette.dim(`turns: ${h.turnCount}`));
  }

  return [sep, parts.join('  '), sep].join('\n');
}

/** Build the footer separator. */
function buildFooter(): string {
  const width = Math.min(getTerminalWidth(), 100);
  return palette.dim('─'.repeat(width));
}

/** Format milliseconds as a compact human duration. */
function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return `${mins}m${secs}s`;
}

// ---------------------------------------------------------------------------
// Message-block renderers (memory path)
// ---------------------------------------------------------------------------

/** Truncate a string to `max` chars, appending ellipsis when trimmed. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + palette.dim('…');
}

/** Render a single content block from an assistant message. */
function renderContentBlock(block: unknown): string {
  // Contract: block is a raw Anthropic SDK content block object or a string
  // when the message content is already serialized. The SDK types are not
  // imported here to avoid adding a direct SDK dependency to this module.
  if (typeof block === 'string') {
    return renderMarkdownToTerminal(block);
  }
  if (typeof block !== 'object' || block === null) {
    return palette.dim(String(block));
  }
  const b = block as Record<string, unknown>;

  if (b['type'] === 'text') {
    const text = typeof b['text'] === 'string' ? b['text'] : '';
    return renderMarkdownToTerminal(text);
  }

  if (b['type'] === 'tool_use') {
    const name  = typeof b['name'] === 'string' ? b['name'] : '?';
    const input = b['input'] !== undefined ? JSON.stringify(b['input']) : '';
    return toolCard({
      toolName: name,
      status: 'running',
      inputSummary: input ? truncate(input, CONTENT_PREVIEW_CHARS) : undefined,
      width: Math.min(getTerminalWidth(), 100),
    });
  }

  if (b['type'] === 'tool_result') {
    const isError = b['is_error'] === true;
    const content = b['content'];
    let preview   = '';
    if (typeof content === 'string') {
      preview = truncate(content, CONTENT_PREVIEW_CHARS);
    } else if (Array.isArray(content)) {
      const first = (content[0] as Record<string, unknown> | undefined);
      const text  = first && typeof first['text'] === 'string' ? first['text'] : '';
      preview     = truncate(text, CONTENT_PREVIEW_CHARS);
    }
    // tool_result blocks don't carry the tool name (it's on the preceding
    // tool_use block), so use a generic label.
    return toolCard({
      toolName: 'result',
      status: isError ? 'error' : 'done',
      outputPreview: preview || undefined,
      width: Math.min(getTerminalWidth(), 100),
    });
  }

  // Fallback: emit the block type as a dim badge.
  const typeLabel = typeof b['type'] === 'string' ? b['type'] : 'unknown';
  return palette.dim(`  [${typeLabel}]`);
}

/**
 * Render a single Message (user or assistant) to a terminal string block.
 * The returned string includes a role header and all content blocks.
 */
function renderMessage(msg: Message): string {
  const roleLabel =
    msg.role === 'user'
      ? palette.user('User')
      : palette.heading('Assistant');

  const lines: string[] = [palette.dim('·') + ' ' + roleLabel];

  // Message.content is always a string (per message-types.ts).
  // It may hold raw markdown prose, or JSON-serialized content blocks from
  // the assistant turn. Attempt block-array parse; fall back to plain text.
  const raw = msg.content;
  let parsed: unknown = null;
  try { parsed = JSON.parse(raw); } catch { /* not JSON — render as text */ }

  if (Array.isArray(parsed)) {
    for (const block of parsed) {
      lines.push(renderContentBlock(block));
    }
  } else {
    lines.push(renderMarkdownToTerminal(raw));
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render a subagent conversation from an in-memory Message[] history.
 *
 * Contract: returns a fully assembled terminal string (header + body + footer)
 * with a trailing newline. Never throws; rendering errors for individual
 * messages are caught and emitted as dim error lines.
 */
export function renderMessagesView(
  header: TaskViewHeader,
  messages: readonly Message[],
): string {
  const sections: string[] = [buildHeader(header), ''];

  for (const msg of messages) {
    try {
      sections.push(renderMessage(msg));
      sections.push('');
    } catch (err) {
      const label = err instanceof Error ? err.message : String(err);
      sections.push(palette.dim(`  [render error: ${label}]`), '');
    }
  }

  sections.push(buildFooter());
  return sections.join('\n');
}
