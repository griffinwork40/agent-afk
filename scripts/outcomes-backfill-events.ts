/**
 * Events.jsonl reader for the outcomes backfill.
 *
 * Converts per-session events.jsonl files (the format used by the 16k+
 * directory-based sessions that predate or outlive the 1,001-file JSON sidecar
 * store) into the Turn[] shape that the immediate LFs and artifact recovery
 * functions expect.
 *
 * Event kinds handled:
 *   meta          → session cwd
 *   user          → Turn.user
 *   assistant     → Turn.assistant (self-report text lives here)
 *   tool          → ToolEvent stub (input captured; result is in tool_result)
 *   tool_result   → completes the ToolEvent with result and isError=false
 *   tool_error    → completes the ToolEvent with isError=true
 *   closed        → ClosureInfo when reason == "abort"
 *
 * Event kinds deliberately ignored:
 *   thinking, progress, done, plan_mode, paused, resumed, rate_limit,
 *   background_job, subagent_lifecycle, error, tool_activity, elicitation
 *   (carry no signal for the immediate LFs).
 *
 * Directories named agent-tool-* are subagent handoff dirs, not sessions.
 * The caller is responsible for filtering them; this module does not skip them.
 */

import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

import type { Turn, ToolEvent } from '../src/agent/outcomes/artifacts.js';
import type { ClosureInfo } from '../src/agent/outcomes/lf-immediate.js';

// ---------------------------------------------------------------------------
// Raw event shapes (subset — only fields we use)
// ---------------------------------------------------------------------------

interface RawMeta {
  kind: 'meta';
  sessionId?: string;
  cwd?: string;
}

interface RawUser {
  kind: 'user';
  text?: string;
}

interface RawAssistant {
  kind: 'assistant';
  text?: string;
}

interface RawTool {
  kind: 'tool';
  toolName?: string;
  toolUseId?: string;
  input?: unknown;
}

interface RawToolResult {
  kind: 'tool_result';
  toolUseId?: string;
  content?: string;
}

interface RawToolError {
  kind: 'tool_error';
  content?: string;
  toolUseId?: string;
}

interface RawClosed {
  kind: 'closed';
  reason?: string;
}

type RawEvent =
  | RawMeta
  | RawUser
  | RawAssistant
  | RawTool
  | RawToolResult
  | RawToolError
  | RawClosed
  | { kind: string };

// ---------------------------------------------------------------------------
// Parse result
// ---------------------------------------------------------------------------

export interface EventsParseResult {
  sessionId: string | null;
  cwd: string | null;
  turns: Turn[];
  closureInfo: ClosureInfo | null;
}

// ---------------------------------------------------------------------------
// Meta returned alongside turns
// ---------------------------------------------------------------------------

export interface EventsSessionMeta {
  cwd: string | null;
  closureInfo: ClosureInfo | null;
}

// ---------------------------------------------------------------------------
// Input serialisation for tool events
// ---------------------------------------------------------------------------

function serializeInput(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (raw === null || raw === undefined) return '';
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
}

// ---------------------------------------------------------------------------
// Core parser — reads one events.jsonl and returns structured result
// ---------------------------------------------------------------------------

type PendingTool = ToolEvent & { _toolUseId: string };

interface TurnBuffer {
  userText: string;
  assistantText: string;
  toolEvents: ToolEvent[];
}

function freshBuffer(): TurnBuffer {
  return { userText: '', assistantText: '', toolEvents: [] };
}

function bufferToTurn(buf: TurnBuffer): Turn | null {
  const turn: Turn = {};
  if (buf.userText) turn.user = buf.userText;
  if (buf.assistantText) turn.assistant = buf.assistantText;
  if (buf.toolEvents.length > 0) turn.toolEvents = buf.toolEvents;
  if (Object.keys(turn).length === 0) return null;
  return turn;
}

export async function parseEventsFile(path: string): Promise<EventsParseResult> {
  const rl = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  let sessionId: string | null = null;
  let cwd: string | null = null;
  let closureInfo: ClosureInfo | null = null;

  const turns: Turn[] = [];
  const pendingTools = new Map<string, PendingTool>();
  let buf = freshBuffer();
  let hasContent = false;

  function flushBuffer(): void {
    if (!hasContent) return;
    const t = bufferToTurn(buf);
    if (t !== null) turns.push(t);
    buf = freshBuffer();
    hasContent = false;
  }

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let ev: RawEvent;
    try {
      ev = JSON.parse(trimmed) as RawEvent;
    } catch {
      continue;
    }

    const kind = ev.kind;

    if (kind === 'meta') {
      const m = ev as RawMeta;
      if (m.sessionId) sessionId = m.sessionId;
      if (m.cwd) cwd = m.cwd;
      continue;
    }

    if (kind === 'user') {
      // A new user message starts a new turn
      flushBuffer();
      hasContent = true;
      buf.userText = (ev as RawUser).text ?? '';
      continue;
    }

    if (kind === 'assistant') {
      hasContent = true;
      const text = (ev as RawAssistant).text ?? '';
      buf.assistantText = buf.assistantText
        ? buf.assistantText + '\n' + text
        : text;
      continue;
    }

    if (kind === 'tool') {
      hasContent = true;
      const t = ev as RawTool;
      const toolUseId = t.toolUseId ?? '';
      const stub: PendingTool = {
        _toolUseId: toolUseId,
        toolName: t.toolName ?? 'unknown',
        input: serializeInput(t.input),
      };
      pendingTools.set(toolUseId, stub);
      buf.toolEvents.push(stub);
      continue;
    }

    if (kind === 'tool_result') {
      const tr = ev as RawToolResult;
      const toolUseId = tr.toolUseId ?? '';
      const pending = pendingTools.get(toolUseId);
      if (pending !== undefined) {
        pending.result = tr.content ?? '';
        pending.isError = false;
        pendingTools.delete(toolUseId);
      } else {
        // Orphaned result — add as a bare event
        buf.toolEvents.push({
          toolName: 'unknown',
          result: tr.content ?? '',
          isError: false,
        });
        hasContent = true;
      }
      continue;
    }

    if (kind === 'tool_error') {
      const te = ev as RawToolError;
      const toolUseId = te.toolUseId ?? '';
      const pending = pendingTools.get(toolUseId);
      if (pending !== undefined) {
        pending.result = te.content ?? '';
        pending.isError = true;
        pendingTools.delete(toolUseId);
      } else {
        buf.toolEvents.push({
          toolName: 'unknown',
          result: te.content ?? '',
          isError: true,
        });
        hasContent = true;
      }
      continue;
    }

    if (kind === 'closed') {
      const c = ev as RawClosed;
      const reason = c.reason ?? '';
      if (reason === 'abort') {
        closureInfo = { reason: 'abort' };
      } else {
        closureInfo = { reason: 'normal' };
      }
      continue;
    }
  }

  flushBuffer();

  return { sessionId, cwd, turns, closureInfo };
}

// ---------------------------------------------------------------------------
// Discover events-only sessions (no JSON sidecar counterpart)
// ---------------------------------------------------------------------------

/**
 * Returns session IDs for directories that have an events.jsonl but no
 * matching JSON sidecar in the same directory (sidecar wins deduplication).
 * Skips directories matching the agent-tool-* naming convention.
 */
export function discoverEventsSessionsSync(sessionsDir: string): string[] {
  if (!existsSync(sessionsDir)) return [];

  const entries = readdirSync(sessionsDir);
  const jsonSidecars = new Set(
    entries.filter((e) => e.endsWith('.json')).map((e) => e.slice(0, -5)),
  );

  const result: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith('agent-tool-')) continue;
    if (jsonSidecars.has(entry)) continue; // JSON sidecar wins; skip events-only
    try {
      const st = statSync(join(sessionsDir, entry));
      if (!st.isDirectory()) continue;
    } catch {
      continue;
    }
    const evPath = join(sessionsDir, entry, 'events.jsonl');
    if (existsSync(evPath)) {
      result.push(entry);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Load events as Turn[] for a single session — primary interface
// ---------------------------------------------------------------------------

export async function loadEventsSessionTurns(
  sessionId: string,
  sessionsDir: string,
): Promise<{ turns: Turn[]; meta: EventsSessionMeta } | null> {
  const evPath = join(sessionsDir, sessionId, 'events.jsonl');
  if (!existsSync(evPath)) return null;

  try {
    const result = await parseEventsFile(evPath);
    return {
      turns: result.turns,
      meta: { cwd: result.cwd, closureInfo: result.closureInfo },
    };
  } catch {
    return null;
  }
}
