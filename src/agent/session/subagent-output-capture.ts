/**
 * Opt-in capture of what a subagent actually SAYS — the mirror of
 * `subagent-prompt-capture.ts`, which captures only what a child was *asked*.
 *
 * Writes one append-only markdown transcript per child under
 * `state/witness/<sessionLabel>/outputs/<subagentId>.md`, recording assistant
 * text interleaved with each tool call AND its arguments. As with prompt
 * capture, the directory IS the index — no trace event references these files.
 *
 * Invariant (why capture is INCREMENTAL, flushed at every tool-call boundary):
 * the failure this exists to debug is a child that runs to its timeout and
 * produces zero final output. At that point every aggregate source is empty by
 * construction — `AgentSession.conversationHistory` only gains an entry on
 * `assistant.message`, which fires once per completed `run()`; `SubagentStop`'s
 * `lastMessage` is `undefined`; and the trace's `partialOutputBytes` is 0. A
 * capture pinned to any end-of-run boundary would therefore record nothing in
 * exactly the case it is needed. Flushing when the child emits a tool call
 * means a killed child still leaves one record per tool call it made.
 *
 * Invariant (why this lives in the CHILD session): identical to prompt capture —
 * a fork resumes its parent's sessionId and shares its TraceWriter, so
 * `getSubagentOutputsDir(this.sessionId)` inside a child resolves to the
 * PARENT's directory, and all six dispatch paths converge on
 * `AgentSession.sendMessageStream*` with no per-path plumbing.
 *
 * @module agent/session/subagent-output-capture
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { env } from '../../config/env.js';
import { getSubagentOutputsDir } from '../../paths.js';
import type { OutputEvent } from '../types/session-types.js';
import { debugLog } from '../../utils/debug.js';
import { redactInlineSecrets } from './prompt-dump.js';
import { truncateToBytes } from './subagent-prompt-capture.js';

/**
 * Byte ceiling for one captured record's text (assistant prose, or one tool's
 * serialized arguments). Generous enough to keep a real command or a paragraph
 * of reasoning intact, small enough that a runaway loop cannot fill a disk.
 */
export const MAX_RECORD_BYTES = 4 * 1024;

/**
 * Byte ceiling for a single child's whole transcript. Once exceeded the
 * recorder writes one final `CAP REACHED` marker and goes inert, so an agent
 * stuck in a 100-iteration tool loop bounds its own artifact.
 */
export const MAX_TRANSCRIPT_BYTES = 512 * 1024;

/** Frontmatter warning: regex redaction is best-effort, not a guarantee. */
export const OUTPUT_CAPTURE_BANNER =
  '<!-- Best-effort secret redaction only. Connection strings, PEM blocks, and PII are NOT caught. -->';

export interface SubagentOutputCaptureInput {
  /** Witness session label — a fork resumes its parent's, which is the point. */
  sessionId: string | undefined;
  /** This fork's own id, stamped on every child config by `forkSubagent`. */
  subagentId: string | undefined;
  /** `config.isSubagentFork` — the only reliable fork marker. */
  isSubagentFork: boolean;
  /** Effective child model, for attribution. */
  model: string | undefined;
}

/**
 * Whether capture is enabled AND this session is a fork with the identity
 * needed to key an artifact. Exported for direct testing — the gate is the
 * whole safety story, so it should be assertable without touching the disk.
 */
export function shouldCaptureSubagentOutput(input: SubagentOutputCaptureInput): boolean {
  if (env.AFK_CAPTURE_SUBAGENT_OUTPUT !== '1') return false;
  if (!input.isSubagentFork) return false;
  if (!input.sessionId || !input.subagentId) return false;
  return true;
}

/** Filesystem-safe slug for an id used in a filename. */
function safeSlug(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 60);
}

/** Escape a YAML scalar conservatively — quote and escape embedded quotes. */
function yamlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Truncate then redact, dropping a trailing partial token first.
 *
 * Order matters and mirrors `captureSubagentPrompt`: a byte-cut can split a
 * secret into a prefix shorter than the redactor's minimum quantifier, leaving
 * partial key material unredacted, so the dangling token is removed before the
 * regex pass runs.
 */
export function sanitizeRecordText(text: string): string {
  const capped = truncateToBytes(text, MAX_RECORD_BYTES);
  const safe = capped.truncated ? capped.text.replace(/\S+$/, '') : capped.text;
  const body = redactInlineSecrets(safe);
  return capped.truncated ? `${body}\n<!-- TRUNCATED at ${MAX_RECORD_BYTES} bytes of ${capped.originalBytes} -->` : body;
}

/** Header written once, on the transcript's first record. */
export function buildOutputHeader(input: SubagentOutputCaptureInput): string {
  const lines = [
    '---',
    `subagentId: ${yamlString(input.subagentId ?? 'unknown')}`,
    `sessionLabel: ${yamlString(input.sessionId ?? 'unknown')}`,
    `startedAt: ${yamlString(new Date().toISOString())}`,
    'redaction: best-effort',
    'capture: incremental (flushed at each tool-call boundary)',
  ];
  if (input.model !== undefined) lines.push(`model: ${yamlString(input.model)}`);
  lines.push('---', OUTPUT_CAPTURE_BANNER, '');
  return `${lines.join('\n')}\n`;
}

/**
 * Render one transcript record. Pure and exported so the on-disk contract is
 * testable without filesystem setup.
 */
export function buildRecord(
  kind: 'say' | 'tool' | 'end',
  detail: { text?: string; toolName?: string; toolInput?: string; reason?: string },
): string {
  const ts = new Date().toISOString();
  if (kind === 'say') {
    return `\n### assistant · ${ts}\n\n${sanitizeRecordText(detail.text ?? '')}\n`;
  }
  if (kind === 'tool') {
    const args = detail.toolInput ? sanitizeRecordText(detail.toolInput) : '(no arguments recorded)';
    return `\n### tool · ${detail.toolName ?? 'unknown'} · ${ts}\n\n\`\`\`\n${args}\n\`\`\`\n`;
  }
  return `\n### end · ${detail.reason ?? 'unknown'} · ${ts}\n`;
}

/** Live recorder bound to one child session. */
export interface SubagentOutputRecorder {
  /** Feed every `OutputEvent` the child yields. Never throws. */
  observe(event: OutputEvent): void;
  /** Record terminal state. Never throws. */
  end(reason: string): void;
}

/**
 * Create a recorder, or `null` when capture is disabled — callers branch on
 * null so a disabled build pays no per-event cost beyond one null check.
 *
 * Writes are serialized through a promise chain because `appendFile` calls
 * issued concurrently can interleave; the chain also means a slow disk applies
 * backpressure to itself rather than to the child's stream loop, which never
 * awaits it.
 */
export function createSubagentOutputRecorder(
  input: SubagentOutputCaptureInput,
): SubagentOutputRecorder | null {
  if (!shouldCaptureSubagentOutput(input)) return null;

  const dir = getSubagentOutputsDir(input.sessionId as string);
  const file = join(dir, `${safeSlug(input.subagentId as string)}.md`);

  let pending: string[] = [];
  let written = 0;
  let capped = false;
  let headerDone = false;
  // Per-turn guard for the non-streaming fallback below. Reset on `done`.
  let wroteSayThisTurn = false;
  let chain: Promise<void> = Promise.resolve();

  const write = (chunk: string): void => {
    if (capped) return;
    if (written >= MAX_TRANSCRIPT_BYTES) {
      capped = true;
      chunk = `\n<!-- CAP REACHED at ${MAX_TRANSCRIPT_BYTES} bytes — capture stopped -->\n`;
    }
    written += Buffer.byteLength(chunk, 'utf8');
    const body = headerDone ? chunk : `${buildOutputHeader(input)}${chunk}`;
    headerDone = true;
    chain = chain
      .then(async () => {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        // mode at creation, not a later chmod — no TOCTOU window on a file that
        // may hold secrets (same idiom as the transcript writer).
        await appendFile(file, body, { encoding: 'utf8', mode: 0o600 });
      })
      .catch((err: unknown) => {
        debugLog(`subagent-output-capture failed: ${String(err)}`);
      });
  };

  /** Emit accumulated assistant prose, if any, as one `say` record. */
  const flushSaid = (): void => {
    if (pending.length === 0) return;
    const text = pending.join('').trim();
    pending = [];
    if (text.length > 0) {
      write(buildRecord('say', { text }));
      wroteSayThisTurn = true;
    }
  };

  return {
    observe(event: OutputEvent): void {
      try {
        if (event.type === 'chunk') {
          const chunk = event.chunk;
          if (chunk.type === 'content') {
            pending.push(chunk.content);
            return;
          }
          if (chunk.type === 'tool_use_detail') {
            // Invariant: flush prose BEFORE the tool record, so the transcript
            // preserves the causal order the child produced — reasoning, then
            // the call it justified.
            flushSaid();
            write(
              buildRecord('tool', {
                toolName: chunk.toolName,
                toolInput: chunk.toolInputRaw ?? chunk.toolInput,
              }),
            );
          }
          return;
        }
        // Contract: `message` carries the WHOLE assistant turn and arrives after
        // any `delta.text` chunks. Recording it unconditionally would duplicate
        // streamed prose, so it is used only as a fallback for providers that
        // emit no text deltas at all (non-streaming paths) — detected by having
        // neither buffered nor already-written prose for this turn.
        if (event.type === 'message') {
          if (!wroteSayThisTurn && pending.length === 0) {
            const text = event.message.content.trim();
            if (text.length > 0) {
              write(buildRecord('say', { text }));
              wroteSayThisTurn = true;
            }
          }
          return;
        }
        if (event.type === 'done' || event.type === 'error') {
          flushSaid();
          wroteSayThisTurn = false;
        }
      } catch (err) {
        debugLog(`subagent-output-capture observe failed: ${String(err)}`);
      }
    },
    end(reason: string): void {
      try {
        flushSaid();
        write(buildRecord('end', { reason }));
      } catch (err) {
        debugLog(`subagent-output-capture end failed: ${String(err)}`);
      }
    },
  };
}
