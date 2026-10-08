/**
 * Handler for the `model_complete` tool: one tool-less chat completion against
 * any configured model.
 *
 * Contract:
 *   - `model` defaults to the operator's configured default model
 *     (`AFK_MODEL` → legacy `CLAUDE_MODEL` → `medium`; see
 *     {@link defaultModelCompleteModel}).
 *   - `model` resolves through the slot table (`resolveOneShotTarget`), so a
 *     slot / custom name / identity alias / raw id gets the same provider,
 *     endpoint, and per-slot API key a session on that model would use.
 *   - An unconfigured slot is rejected via `unconfiguredSlotError` BEFORE any
 *     network call: never a silent fallback to a cloud default.
 *   - `input_path` goes through `resolveAndContain` (the read_file policy:
 *     read roots, symlink containment, credential denylist) and must be UTF-8
 *     text of at most {@link MAX_INPUT_BYTES}.
 *   - Errors are returned as `isError` results with secrets redacted; provider
 *     SDK errors can echo partial keys.
 *
 * @module agent/tools/handlers/model-complete
 */

import { promises as fs } from 'fs';
import type { ToolHandler, ToolHandlerContext, ToolResult } from '../types.js';
import { resolveAndContain } from './_cwd-utils.js';
import { fsErrorToToolResult } from './_fs-error.js';
import { errorMessage } from '../../../utils/errors.js';
import { env } from '../../../config/env.js';
import { redactSecrets } from '../../redact-secrets.js';
import { unconfiguredSlotError } from '../../session/model-slots.js';
import {
  resolveOneShotTarget,
  routedOneShotWithStop,
  type OneShotLabel,
  type OneShotStopReason,
} from '../../providers/shared/one-shot-router.js';

/** Tier used when no default model is configured (matches `AFK_MODEL`'s own default). */
const FALLBACK_MODEL = 'medium';

/**
 * Model used when the caller names none: the operator's configured default,
 * `AFK_MODEL` (legacy `CLAUDE_MODEL`), else the `medium` tier. The `auto`
 * routing sentinel is not a model, so it maps to the fallback tier too.
 * Read per call so a changed env is honoured without a restart.
 */
export function defaultModelCompleteModel(): string {
  const raw = (env.AFK_MODEL ?? env.CLAUDE_MODEL ?? '').trim();
  return raw === '' || raw.toLowerCase() === 'auto' ? FALLBACK_MODEL : raw;
}
const DEFAULT_MAX_TOKENS = 4096;
const MAX_MAX_TOKENS = 32_000;
/** Largest `input_path` file accepted (1 MB). */
export const MAX_INPUT_BYTES = 1024 * 1024;
/** Reply characters returned before truncation. */
export const MAX_REPLY_CHARS = 100_000;
/** Wall-clock bound on one completion, independent of the turn's signal. */
const TIMEOUT_MS = 300_000;
const DEFAULT_SYSTEM =
  'You are a helpful assistant. Answer the request directly and concisely, without preamble.';
const LABEL: OneShotLabel = {
  tag: '[model_complete]',
  purpose: 'model_complete',
  unsupportedHint: 'Pass a model on anthropic, openai(-compatible), or xai.',
};

interface ModelCompleteInput {
  prompt: string;
  system?: string;
  model: string;
  maxTokens: number;
  inputPath?: string;
}

function fail(message: string): ToolResult {
  return { content: `model_complete: ${message}`, isError: true };
}

/** Validate raw tool input. Returns the parsed input or an error result. */
export function parseModelCompleteInput(raw: unknown): ModelCompleteInput | ToolResult {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const prompt = obj['prompt'];
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    return fail('`prompt` must be a non-empty string.');
  }
  const model = typeof obj['model'] === 'string' && obj['model'].trim() !== ''
    ? obj['model'].trim()
    : defaultModelCompleteModel();
  if (model.toLowerCase() === 'auto') {
    return fail('`model: "auto"` is a session routing sentinel, not a model. Name a slot or id.');
  }
  const rawMax = obj['max_tokens'];
  const maxTokens = typeof rawMax === 'number' && Number.isFinite(rawMax)
    ? Math.min(MAX_MAX_TOKENS, Math.max(1, Math.floor(rawMax)))
    : DEFAULT_MAX_TOKENS;
  const parsed: ModelCompleteInput = { prompt, model, maxTokens };
  if (typeof obj['system'] === 'string' && obj['system'].trim() !== '') parsed.system = obj['system'];
  if (typeof obj['input_path'] === 'string' && obj['input_path'].trim() !== '') {
    parsed.inputPath = obj['input_path'];
  }
  return parsed;
}

/** Read `input_path` under the read_file containment policy. */
async function readInputFile(
  rawPath: string,
  context: ToolHandlerContext | undefined,
  cwd: string | undefined,
): Promise<{ path: string; text: string } | ToolResult> {
  let filePath: string;
  try {
    filePath = resolveAndContain(rawPath, context, 'read', cwd);
  } catch (err) {
    return fail(errorMessage(err));
  }
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return fail(`input_path is not a regular file: ${filePath}`);
    if (stat.size > MAX_INPUT_BYTES) {
      return fail(`input_path is ${stat.size} bytes; the limit is ${MAX_INPUT_BYTES}.`);
    }
    const buf = await fs.readFile(filePath);
    if (buf.includes(0)) return fail(`input_path looks binary (NUL byte): ${filePath}`);
    return { path: filePath, text: buf.toString('utf-8') };
  } catch (err) {
    return fsErrorToToolResult(err, filePath, 'File') ?? fail(errorMessage(err));
  }
}

function isToolResult(v: unknown): v is ToolResult {
  return typeof v === 'object' && v !== null && 'content' in v && typeof (v as ToolResult).content === 'string';
}

async function modelCompleteImpl(
  raw: unknown,
  signal: AbortSignal,
  context: ToolHandlerContext | undefined,
  cwd: string | undefined,
): Promise<ToolResult> {
  const input = parseModelCompleteInput(raw);
  if (isToolResult(input)) return input;

  const slotError = unconfiguredSlotError(input.model);
  if (slotError) return fail(slotError);

  let user = input.prompt;
  if (input.inputPath !== undefined) {
    const file = await readInputFile(input.inputPath, context, cwd);
    if (isToolResult(file)) return file;
    user = `${input.prompt}\n\n<input path="${file.path}">\n${file.text}\n</input>`;
  }

  const target = resolveOneShotTarget(input.model);
  const callSignal = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]);
  let reply: string;
  let stopReason: OneShotStopReason;
  try {
    ({ text: reply, stopReason } = await routedOneShotWithStop({
      ...target,
      system: input.system ?? DEFAULT_SYSTEM,
      user,
      maxTokens: input.maxTokens,
      label: LABEL,
      signal: callSignal,
    }));
  } catch (err) {
    if (signal.aborted) return fail('aborted.');
    const timedOut = callSignal.aborted;
    const detail = timedOut ? `timed out after ${TIMEOUT_MS / 1000}s.` : errorMessage(err);
    return fail(`${target.model} (${target.provider}) failed: ${redactSecrets(detail)}`);
  }

  const footer = `\n\n[model_complete: ${target.model} via ${target.provider}]`;
  if (reply.trim() === '') {
    return { content: `(empty reply; try a larger max_tokens if this is a reasoning model)${footer}` };
  }
  // Append a visible note when the model was cut off by the token limit so the
  // caller knows the output is partial and can retry with a larger max_tokens.
  const truncNote = stopReason === 'max_tokens'
    ? '\n\n[stopped at max_tokens: output may be incomplete; retry with a larger max_tokens]'
    : '';
  if (reply.length > MAX_REPLY_CHARS) {
    return {
      content: `${reply.slice(0, MAX_REPLY_CHARS)}\n… [truncated at ${MAX_REPLY_CHARS} chars]${truncNote}${footer}`,
      truncated: true,
    };
  }
  return { content: `${reply}${truncNote}${footer}` };
}

/**
 * Create a `model_complete` handler closed over a session cwd; `cwd` is the
 * last-tier resolve base for a relative `input_path` (mirrors json_query).
 */
export function createModelCompleteHandler(cwd?: string): ToolHandler {
  return (input, signal, context) => modelCompleteImpl(input, signal, context, cwd);
}

/** Bare `model_complete` handler with no session cwd. */
export const modelCompleteHandler: ToolHandler = createModelCompleteHandler();
