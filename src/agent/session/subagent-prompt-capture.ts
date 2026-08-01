/**
 * Opt-in capture of the prompts a parent session sends to its subagents.
 *
 * Writes one markdown file per inbound child message (YAML frontmatter for
 * attribution + the verbatim prompt body) under
 * `state/witness/<sessionLabel>/prompts/`. The directory IS the index — no trace
 * event references these files, so capture works whether or not a `TraceWriter`
 * is wired.
 *
 * Invariant (why this lives in the CHILD session, not the parent's dispatch
 * site): a forked child resumes its parent's sessionId and shares the parent's
 * TraceWriter by reference (`SubagentManager.forkSubagent`), so
 * `getPromptsDir(this.sessionId)` inside a child resolves to the PARENT's
 * directory — one directory holds every prompt a session dispatched. The child's
 * own `config.subagentId` names the file. Capturing here also covers all six
 * dispatch paths (agent fg/bg, worktree-isolated, compose/DAG, skill forks, and
 * in-process callers such as mint phases) with no per-path plumbing, because all
 * of them deliver their prompt through `AgentSession.sendMessageStream*`.
 *
 * @module agent/session/subagent-prompt-capture
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { env } from '../../config/env.js';
import { getPromptsDir } from '../../paths.js';
import { debugLog } from '../../utils/debug.js';
import { redactInlineSecrets } from './prompt-dump.js';

/**
 * Byte ceiling for a captured prompt body. Dispatch prompts in this repo run
 * 1–4 KB; 8 KB keeps a long brief intact while bounding a pasted-file outlier.
 * Oversized bodies are truncated with an explicit marker — never silently.
 */
export const MAX_CAPTURED_PROMPT_BYTES = 8 * 1024;

/** Frontmatter warning: regex redaction is best-effort, not a guarantee. */
export const PROMPT_CAPTURE_BANNER =
  '<!-- Best-effort secret redaction only. Connection strings, PEM blocks, and PII are NOT caught. -->';

export interface CaptureSubagentPromptInput {
  /** Witness session label — a fork resumes its parent's, which is the point. */
  sessionId: string | undefined;
  /** This fork's own id, stamped on every child config by `forkSubagent`. */
  subagentId: string | undefined;
  /** `config.isSubagentFork` — the only reliable fork marker (see module doc). */
  isSubagentFork: boolean;
  /** Effective child model, for attribution. */
  model: string | undefined;
  /** 1-based index of this inbound message on the child (multi-turn safe). */
  turn: number;
  /** The composed prompt the child actually received. */
  prompt: string;
}

/**
 * Whether capture is enabled AND this session is a fork with the identity
 * needed to key an artifact. Exported for direct testing — the gate is the
 * whole safety story, so it should be assertable without touching the disk.
 */
export function shouldCaptureSubagentPrompt(input: CaptureSubagentPromptInput): boolean {
  if (env.AFK_CAPTURE_SUBAGENT_PROMPTS !== '1') return false;
  if (!input.isSubagentFork) return false;
  if (!input.sessionId || !input.subagentId) return false;
  return input.prompt.length > 0;
}

/**
 * Contract: truncate to a byte budget, returning the kept text plus the original
 * byte length when truncation occurred. Cutting on a byte boundary can split a
 * multi-byte character, so a trailing U+FFFD replacement char produced by the
 * lossy decode is stripped rather than surfaced as mojibake.
 *
 * Order matters: the caller truncates BEFORE redacting, so a multi-megabyte
 * paste never pays the full regex cost on bytes that are about to be discarded.
 */
export function truncateToBytes(
  text: string,
  maxBytes: number,
): { text: string; originalBytes: number; truncated: boolean } {
  const originalBytes = Buffer.byteLength(text, 'utf8');
  if (originalBytes <= maxBytes) return { text, originalBytes, truncated: false };
  const decoded = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8');
  return { text: decoded.replace(/\uFFFD+$/, ''), originalBytes, truncated: true };
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
 * Render the markdown document. Pure and exported so the frontmatter contract is
 * testable without filesystem setup.
 *
 * The body is written verbatim after the frontmatter block. A prompt containing
 * `---` or code fences is therefore safe: only the FIRST two delimiters bound
 * the frontmatter, so no escaping of the body is required.
 */
export function buildPromptDocument(
  input: CaptureSubagentPromptInput,
  capture: { text: string; originalBytes: number; truncated: boolean },
): string {
  const lines = [
    '---',
    `subagentId: ${yamlString(input.subagentId ?? 'unknown')}`,
    `sessionLabel: ${yamlString(input.sessionId ?? 'unknown')}`,
    `turn: ${input.turn}`,
    `capturedAt: ${yamlString(new Date().toISOString())}`,
    `promptBytes: ${input.prompt.length > 0 ? capture.originalBytes : 0}`,
    `truncated: ${capture.truncated}`,
    'redaction: best-effort',
  ];
  if (input.model !== undefined) lines.push(`model: ${yamlString(input.model)}`);
  lines.push('---', PROMPT_CAPTURE_BANNER, '');
  lines.push(capture.text);
  if (capture.truncated) {
    lines.push('', `<!-- TRUNCATED at ${MAX_CAPTURED_PROMPT_BYTES} bytes of ${capture.originalBytes} -->`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Fire-and-forget capture. Never throws and never rejects: a forensics artifact
 * must not be able to fail a turn, matching the `void emitSessionPhase(...)`
 * convention already used on this path. Callers use `void captureSubagentPrompt(...)`.
 */
export async function captureSubagentPrompt(input: CaptureSubagentPromptInput): Promise<void> {
  try {
    if (!shouldCaptureSubagentPrompt(input)) return;
    // Invariant: truncate before redacting (see truncateToBytes).
    const capped = truncateToBytes(input.prompt, MAX_CAPTURED_PROMPT_BYTES);
    const body = redactInlineSecrets(capped.text);
    const doc = buildPromptDocument(input, { ...capped, text: body });

    // sessionId/subagentId are non-empty here — shouldCapture guarantees it.
    const dir = getPromptsDir(input.sessionId as string);
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = join(dir, `${stamp}-${safeSlug(input.subagentId as string)}-t${input.turn}.md`);
    // mode at creation, not a later chmod — no TOCTOU window on a file that may
    // hold secrets (same idiom as the transcript writer).
    await writeFile(file, doc, { encoding: 'utf8', mode: 0o600, flag: 'w' });
  } catch (err) {
    debugLog(`subagent-prompt-capture failed: ${String(err)}`);
  }
}
