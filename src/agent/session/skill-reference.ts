/**
 * Mid-message skill references: detection + logging-only telemetry.
 *
 * A message that STARTS with `/name` goes through the slash path and arrives
 * here carrying a `<command-name>` breadcrumb. A `/name` typed partway
 * through a normal message ("lets run /session-handoff") is plain text, and
 * the model alone decides whether to call the `skill` tool. This module
 * records, per referenced skill, whether that call happened, so the miss rate
 * can be measured from `routing-decisions.jsonl` (`skill.reference_seen`).
 *
 * Invariant: observation only. The wrapped stream yields every event
 * unchanged and in order; nothing here mutates the turn, the content sent to
 * the model, or the conversation. Telemetry is fire-and-forget (INV-040).
 *
 * Privacy: rows carry only a skill name that resolved to an installed skill
 * plus two booleans. Unresolved tokens (e.g. `/tmp`) are never written.
 */

import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import type { OutputEvent } from '../types.js';
import { appendRoutingDecision } from '../routing-telemetry.js';
import type { TraceOrigin } from './session-identity.js';

/** A candidate reference extracted from the user's own text. */
export interface SkillReferenceScan {
  /** Bare candidate names in first-seen order, deduplicated. */
  names: string[];
  /** Whether the scanned text contained a question mark. */
  inQuestion: boolean;
}

// Optional `plugin:` qualifier, then a kebab-case name. The lookbehind admits
// only start-of-text, whitespace, or opening punctuation, so URL and path
// segments ("https://x/y", "src/foo") never match. The lookahead refuses a
// following "/" (paths like "/tmp/x"), "." + word char (files like
// "/foo.md"), or a further name character.
const REFERENCE_RE =
  /(?<=^|[\s(["'])\/((?:[a-z0-9][a-z0-9-]*:)?[a-z][a-z0-9]*(?:-[a-z0-9]+)*)(?![\w/:-]|\.\w)/g;

// Framework-wrapped blocks (`<background-subagent-result>`,
// `<peer-session-message>`, `<bash-passthrough>`, …) are not the user's words.
const WRAPPED_BLOCK_RE = /<([a-z][\w-]*)\b[^>]*>[\s\S]*?<\/\1>/g;
const FENCED_CODE_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`\n]*`/g;
const QUOTED_LINE_RE = /^[ \t]*>.*$/gm;

function contentText(content: string | ContentBlockParam[]): string {
  if (typeof content === 'string') return content;
  return content
    .map((b) => (b.type === 'text' ? b.text : ''))
    .filter((t) => t.length > 0)
    .join('\n');
}

/**
 * Extract mid-message `/name` candidates from user content. Pure.
 *
 * Returns no names when the content is a slash-path dispatch (it carries a
 * `<command-name>` breadcrumb), so a typed `/x` is never counted as a
 * mid-message mention. A token at the very start of the remaining text is
 * skipped for the same reason on surfaces that did not add a breadcrumb.
 */
export function scanSkillReferences(content: string | ContentBlockParam[]): SkillReferenceScan {
  const raw = contentText(content);
  if (raw.includes('<command-name>')) return { names: [], inQuestion: false };
  const text = raw
    .replace(FENCED_CODE_RE, ' ')
    .replace(WRAPPED_BLOCK_RE, ' ')
    .replace(INLINE_CODE_RE, ' ')
    .replace(QUOTED_LINE_RE, ' ');
  const leading = text.search(/\S/);
  const names: string[] = [];
  for (const m of text.matchAll(REFERENCE_RE)) {
    if (m.index === leading) continue;
    const name = bareSkillName(m[1]!);
    if (!names.includes(name)) names.push(name);
  }
  return { names, inQuestion: text.includes('?') };
}

/** Strip any `plugin:` / `user:` qualifier — the comparison key everywhere. */
export function bareSkillName(name: string): string {
  return name.split(':').pop()!;
}

/**
 * Pull the invoked skill name out of an orchestrator `skill` tool call, or
 * undefined for any other event. Pending paints (arguments still streaming)
 * are skipped; their final chunk arrives later with the real input.
 */
export function invokedSkillName(event: OutputEvent): string | undefined {
  if (event.type !== 'chunk') return undefined;
  const chunk = event.chunk;
  if (chunk.type !== 'tool_use_detail' || chunk.toolName !== 'skill' || chunk.pending) return undefined;
  try {
    const input = JSON.parse(chunk.toolInputRaw ?? chunk.toolInput) as { name?: unknown };
    return typeof input.name === 'string' ? bareSkillName(input.name) : undefined;
  } catch {
    return undefined;
  }
}

/** Identity fields stamped on every row. */
export interface SkillReferenceRowContext {
  origin?: TraceOrigin;
  sessionId?: string;
  /** Resolves which candidate names are installed skills. Called off the hot path. */
  resolveKnownNames: (candidates: readonly string[]) => Promise<ReadonlySet<string>>;
}

/**
 * Pass `stream` through untouched while noting `skill` calls, then — only if
 * the turn ran to completion — log one `skill.reference_seen` row per
 * referenced installed skill. An interrupted turn (consumer stopped early)
 * or one that yielded an `error` event logs nothing, so neither reads as a
 * miss.
 */
export async function* observeSkillReferences(
  scan: SkillReferenceScan,
  stream: AsyncIterable<OutputEvent>,
  ctx: SkillReferenceRowContext,
): AsyncIterableIterator<OutputEvent> {
  const invoked = new Set<string>();
  let failed = false;
  for await (const event of stream) {
    const name = invokedSkillName(event);
    if (name !== undefined) invoked.add(name);
    if (event.type === 'error') failed = true;
    yield event;
  }
  if (failed) return;
  void emitReferenceRows(scan, invoked, ctx).catch(() => {});
}

/** Resolve candidates and append rows. Exported for tests. */
export async function emitReferenceRows(
  scan: SkillReferenceScan,
  invoked: ReadonlySet<string>,
  ctx: SkillReferenceRowContext,
): Promise<void> {
  const known = await ctx.resolveKnownNames(scan.names);
  for (const name of scan.names) {
    // A name the model successfully dispatched is a real skill by definition.
    if (!known.has(name) && !invoked.has(name)) continue;
    await appendRoutingDecision({
      event: 'skill.reference_seen',
      ...(ctx.origin !== undefined ? { origin: ctx.origin } : {}),
      actor: 'main',
      requested_name: name,
      parent_session_id: ctx.sessionId,
      depth: 0,
      invoked: invoked.has(name),
      in_question: scan.inQuestion,
    });
  }
}
