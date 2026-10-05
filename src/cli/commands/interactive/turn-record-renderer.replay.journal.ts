/**
 * Journal-backed conversation replay for resumed / forked sessions and
 * `/history`.
 *
 * The sidecar replay (`turn-record-renderer.replay.ts`) only has what
 * `turns[]` stores: flattened user text, assistant text, and a one-line tool
 * summary. The message journal holds the full conversation, so this module
 * rebuilds the screen from it with the SAME renderer a live turn uses:
 * journal records → display fold (`agent/journal/display-fold.ts`, which keeps
 * compaction-displaced history and follows `/fork` chains) → turns →
 * `OutputEvent`s → a non-TTY `StreamRenderer` per turn. Markdown, tool cards,
 * and tool results therefore look like they did live, and any future renderer
 * change applies to replay for free.
 *
 * Contract: `replayJournal` returns the number of turns rendered, or `null`
 * when there is nothing to render from the journal (no journal, journal
 * disabled, empty display fold, or a failure BEFORE any line was written).
 * `null` is the caller's cue to fall back to the sidecar replay; a failure
 * AFTER output started is reported inline instead, so a fallback never prints
 * the history twice.
 *
 * @module cli/commands/interactive/turn-record-renderer.replay.journal
 */

import { StreamRenderer } from '../../_lib/stream-renderer.js';
import { createConsoleWriter, type WriterSink } from '../../slash/writer.js';
import { formatSubmittedEcho } from '../../input/echo.js';
import { buildPrompt } from './repl-loop-shared.js';
import { palette } from '../../palette.js';
import { stripCommandTags } from '../../slash/_lib/command-tags.js';
import { stripEscapeSequences } from '../../../utils/terminal-sanitize.js';
import { extractUserContent, isPreamble } from '../../../agent/session/preamble-strip.js';
import {
  hydrateMessages,
  isMessageJournalDisabled,
  loadDisplayMessages,
  type JournalBlock,
  type JournalMessage,
  type JournalResultPart,
} from '../../../agent/journal/index.js';
import type { OutputEvent } from '../../../agent/types.js';

/** Default number of most-recent turns replayed (matches the sidecar replay). */
const DEFAULT_MAX_TURNS = 50;

const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const BACKGROUND_RESULT_TAG = '<background-subagent-result';

/** One replayed exchange: what the human sent, then everything that followed. */
export interface ReplayTurn {
  /** Cleaned human text; empty for a headless leading segment. */
  user: string;
  /** Dim annotation instead of user text (e.g. a delivered background result). */
  note?: string;
  body: JournalMessage[];
}

function hasToolResult(m: JournalMessage): boolean {
  return m.content.some((b) => b.type === 'tool_result');
}

/** A bracketed harness header with no colon/space, e.g. `[placeholder-prevent]`. */
const BARE_BRACKET_HEADER_RE = /^\s*\[[\w-]+\]/;

/**
 * Longest sidecar user text that the journal text ends with ON A LINE
 * BOUNDARY. Harness preambles are PREPENDED to what the human typed (joined
 * by a newline), so the typed text, which the sidecar's `TurnRecord.user`
 * stores verbatim, is a suffix that starts a line. The boundary is
 * load-bearing: a bare suffix match lets a one-character turn like "." claim
 * every message that merely ends in a period.
 */
function matchHint(text: string, hints: ReadonlySet<string>): string | undefined {
  let best: string | undefined;
  for (const h of hints) {
    if (h.length <= (best?.length ?? 0)) continue;
    if (text === h || text.endsWith(`\n${h}`)) best = h;
  }
  return best;
}

/**
 * The part of a user message the human actually typed. Harness injections
 * (system reminders, plugin/skill preambles, command breadcrumbs) are
 * removed; a skill invocation collapses to its `/name args` form. `hints`
 * (trimmed sidecar user texts) give an exact answer when one matches; the
 * preamble heuristics cover sessions without a usable sidecar.
 */
export function humanText(m: JournalMessage, hints: ReadonlySet<string> = new Set()): { text: string; note?: string } {
  const raw = m.content
    .filter((b): b is Extract<JournalBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  if (raw.includes(BACKGROUND_RESULT_TAG)) return { text: '', note: 'background subagent result delivered' };
  let text = raw.replace(SYSTEM_REMINDER_RE, '').trim();
  const hinted = matchHint(text, hints);
  if (hinted !== undefined) {
    text = hinted;
  } else if (isPreamble(text) || BARE_BRACKET_HEADER_RE.test(text)) {
    text = extractUserContent(text) ?? text;
  }
  // A skill breadcrumb that survived preamble peeling (it sat AFTER the
  // bridge marker) collapses to `/name args`, not the dispatch instruction
  // that follows the tags.
  if (hinted === undefined && text.includes('<command-name>')) text = extractUserContent(text) ?? text;
  text = stripCommandTags(text).trim();
  const images = m.content.filter((b) => b.type === 'image').length;
  if (images > 0) {
    const tag = `[${images} image${images === 1 ? '' : 's'} attached]`;
    text = text ? `${text} ${tag}` : tag;
  }
  return { text };
}

/**
 * Group display messages into turns. A user message that carries human text
 * (or a note) opens a turn; tool_result carriers and assistant messages
 * belong to the open turn. Text riding inside a tool_result carrier is
 * harness-injected context, never a new human turn.
 */
export function groupTurns(messages: readonly JournalMessage[], hintTexts: readonly string[] = []): ReplayTurn[] {
  const hints = new Set(hintTexts.map((h) => h.trim()).filter((h) => h.length > 0));
  const turns: ReplayTurn[] = [];
  for (const m of messages) {
    if (m.role === 'user' && !hasToolResult(m)) {
      const { text, note } = humanText(m, hints);
      if (text || note) {
        turns.push({ user: text, ...(note !== undefined ? { note } : {}), body: [] });
        continue;
      }
    }
    if (turns.length === 0) turns.push({ user: '', body: [] });
    turns[turns.length - 1]!.body.push(m);
  }
  return turns;
}

function resultText(parts: readonly JournalResultPart[]): string {
  return parts
    .map((p) => {
      if (p.type === 'text') return p.text;
      if (p.type === 'text_ref') return p.preview;
      return `[${p.type}]`;
    })
    .join('\n');
}

/** Translate one turn's body into the event stream a live turn would emit. */
export function turnEvents(body: readonly JournalMessage[]): OutputEvent[] {
  const events: OutputEvent[] = [];
  let lastWasText = false;
  for (const m of body) {
    for (const b of m.content) {
      if (m.role === 'assistant' && b.type === 'text' && b.text.length > 0) {
        // Separate text from consecutive assistant messages as paragraphs,
        // the way successive model rounds read live.
        // Security boundary: strip terminal escape sequences from assistant text
        // before it reaches the terminal, matching the sidecar replay's behaviour.
        const safeText = stripEscapeSequences(lastWasText ? `\n\n${b.text}` : b.text);
        if (safeText.length > 0) {
          events.push({ type: 'chunk', chunk: { type: 'content', content: safeText } });
          lastWasText = true;
        }
      } else if (m.role === 'assistant' && b.type === 'tool_use') {
        const toolInput = typeof b.input === 'string' ? b.input : JSON.stringify(b.input ?? {});
        events.push({ type: 'chunk', chunk: { type: 'tool_use_detail', toolUseId: b.id, toolName: b.name, toolInput } });
        lastWasText = false;
      } else if (b.type === 'tool_result') {
        events.push({
          type: 'chunk',
          chunk: { type: 'tool_result', toolUseId: b.toolUseId, content: resultText(b.content), ...(b.isError ? { isError: true } : {}) },
        });
        lastWasText = false;
      }
    }
  }
  events.push({ type: 'done' });
  return events;
}

/**
 * Split a turn body into model rounds: each assistant message plus the
 * tool_result carriers that answer it. Exported for tests.
 */
export function splitRounds(body: readonly JournalMessage[]): JournalMessage[][] {
  const rounds: JournalMessage[][] = [];
  for (const m of body) {
    if (m.role === 'assistant' || rounds.length === 0) rounds.push([]);
    rounds[rounds.length - 1]!.push(m);
  }
  return rounds;
}

async function renderRound(round: readonly JournalMessage[], sink: WriterSink): Promise<void> {
  const renderer = new StreamRenderer({ out: createConsoleWriter(sink), forceNonTty: true, captureMode: false, thinkingMode: 'off' });
  try {
    for (const event of turnEvents(hydrateMessages([...round]))) renderer.process(event);
  } finally {
    await renderer.dispose();
  }
}

async function renderTurn(turn: ReplayTurn, sink: WriterSink): Promise<void> {
  if (turn.note !== undefined) {
    // Security boundary: strip escape sequences from notes that originated in
    // journal text (e.g. background-subagent annotation derived from message content).
    sink.fn(palette.dim(`  ↳ ${stripEscapeSequences(turn.note)}`));
  } else if (turn.user) {
    // Security boundary: strip escape sequences from the human text before
    // passing it to formatSubmittedEcho, which writes it to the terminal.
    sink.fn(formatSubmittedEcho({ buffer: stripEscapeSequences(turn.user), promptText: buildPrompt('default'), isTTY: Boolean(process.stdout.isTTY) }));
  }
  // Invariant: one renderer per model ROUND, each disposed before the next
  // starts. dispose() is the flush gate that commits pending markdown, and on
  // the non-TTY path the ToolLane commits its tool summary at dispose too, so
  // a single per-turn renderer would print every tool call after ALL of the
  // turn's text. Per-round renderers keep each round's tools directly under
  // the text that issued them, in live order.
  for (const round of splitRounds(turn.body)) await renderRound(round, sink);
}

/** Load and group without writing anything; `null` when there is nothing to replay. */
export function loadReplayTurns(sessionId: string | undefined, hintTexts: readonly string[] = []): ReplayTurn[] | null {
  if (!sessionId || isMessageJournalDisabled()) return null;
  try {
    const turns = groupTurns(loadDisplayMessages(sessionId), hintTexts);
    return turns.length > 0 ? turns : null;
  } catch {
    return null;
  }
}

/** Render pre-loaded turns (most recent `maxTurns`). Returns the count rendered. */
export async function renderReplayTurns(
  turns: readonly ReplayTurn[],
  sink: WriterSink,
  opts: { maxTurns?: number } = {},
): Promise<number> {
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  const omitted = Math.max(0, turns.length - maxTurns);
  if (omitted > 0) sink.fn(palette.dim(`    ... ${omitted} earlier turn${omitted === 1 ? '' : 's'} omitted`));
  const slice = omitted > 0 ? turns.slice(omitted) : turns;
  try {
    for (const turn of slice) await renderTurn(turn, sink);
  } catch {
    sink.fn(palette.dim('    (history replay incomplete)'));
  }
  return slice.length;
}

/**
 * See the module contract. `hints` are the sidecar's `TurnRecord.user` texts,
 * used to recover exactly what the human typed from preamble-wrapped messages.
 */
export async function replayJournal(
  sessionId: string | undefined,
  sink: WriterSink,
  opts: { maxTurns?: number; hints?: readonly string[] } = {},
): Promise<number | null> {
  const turns = loadReplayTurns(sessionId, opts.hints);
  if (!turns) return null;
  return renderReplayTurns(turns, sink, opts);
}
