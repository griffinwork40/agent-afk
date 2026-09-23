/**
 * SPINE classifier — analyses a git diff against the current SPINE.md and
 * returns structured classification items.
 *
 * Uses a single `oneShotCompletion` call (no tool loop, no session lifecycle)
 * because the task is purely classificatory: give the model a diff + the
 * current spine, get back a JSON array of labeled items. The 30s hook timeout
 * applies to the whole operation.
 *
 * Prompt lives in `prompts/classifier.md` (loaded via readFileSync at module
 * init so the hook has no async I/O on the prompt-load path).
 *
 * @module agent/spine/spine-classifier
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { oneShotCompletion } from '../providers/anthropic-direct/oneshot.js';
import { loadAnthropicCredential } from '../auth/credential-resolver.js';
import type { SpineIdPrefix } from './spine-store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single classifier output item, one per architectural signal found. */
export type ClassifierLabel =
  | 'new-addition'
  | 'strengthens'
  | 'weakens'
  | 'contradicts';

export interface SpineAdditionItem {
  label: 'new-addition';
  prefix: SpineIdPrefix;
  description: string;
  rationale: string;
}

export interface SpineRelationItem {
  label: 'strengthens' | 'weakens' | 'contradicts';
  existingId: string;
  existingDescription: string;
  description: string;
  rationale: string;
}

export type SpineClassifierItem = SpineAdditionItem | SpineRelationItem;

export interface ClassifierResult {
  items: SpineClassifierItem[];
  /** Raw model output, preserved for debugging when parse fails */
  rawOutput: string;
  /** True when the JSON parse succeeded */
  parsed: boolean;
}

// ---------------------------------------------------------------------------
// Prompt loading
// ---------------------------------------------------------------------------

// Invariant: prompts are loaded via the inline `readFileSync(join(__dirname, ...))`
// pattern so the esbuild inliner (`scripts/esbuild-plugin-inline-prompts.mjs`,
// Pattern A) can replace them with string literals at bundle time. Intermediate
// variable forms (`const path = join(...); readFileSync(path)`) silently escape
// the inliner regex and produce runtime "file not found" errors in the published
// npm package — this was the root cause of the hook being dead since launch.

const CLASSIFIER_PROMPT = readFileSync(join(__dirname, 'prompts/classifier.md'), 'utf-8');
const INIT_CLASSIFIER_PROMPT = readFileSync(join(__dirname, 'prompts/init-classifier.md'), 'utf-8');

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

const CLASSIFIER_MODEL = 'haiku'; // cheapest sufficient for classification
const MAX_TOKENS = 4096; // generous for a JSON array of items
const DIFF_CHAR_LIMIT = 20_000; // truncate enormous diffs before sending

/**
 * Classify the architectural signals in a git diff against the current
 * SPINE.md. Returns an empty `items` array when the diff is empty or when
 * no architectural signals are found.
 *
 * Errors (auth failure, network, model error) propagate to the caller for
 * best-effort handling in the hook.
 */
export async function classifyDiff(
  diff: string,
  spineContent: string,
  signal?: AbortSignal,
): Promise<ClassifierResult> {
  const token = loadAnthropicCredential();
  if (!token) {
    throw new Error('No Anthropic credential available for SPINE classifier');
  }

  const systemPrompt = CLASSIFIER_PROMPT;

  // Truncate enormous diffs to avoid token budget blowout. The classifier
  // only needs architectural signals, which appear early in most diffs.
  const truncatedDiff =
    diff.length > DIFF_CHAR_LIMIT
      ? diff.slice(0, DIFF_CHAR_LIMIT) + '\n\n… (diff truncated at 20k chars)'
      : diff;

  const userMessage = buildUserMessage(truncatedDiff, spineContent);

  const rawOutput = await oneShotCompletion({
    token,
    model: CLASSIFIER_MODEL,
    system: systemPrompt,
    user: userMessage,
    maxTokens: MAX_TOKENS,
    ...(signal !== undefined ? { signal } : {}),
  });

  return parseClassifierOutput(rawOutput);
}

/**
 * Classify seed material (invariant comments, CHANGELOG, AFK.md, git reverts)
 * into proposed SPINE.md entries during `/spine init`. Uses a purpose-built
 * init prompt rather than the diff-oriented classifier prompt.
 */
export async function classifySeedMaterial(
  seedText: string,
  signal?: AbortSignal,
): Promise<ClassifierResult> {
  const token = loadAnthropicCredential();
  if (!token) {
    throw new Error('No Anthropic credential available for SPINE init classifier');
  }

  const systemPrompt = INIT_CLASSIFIER_PROMPT;
  const truncated =
    seedText.length > DIFF_CHAR_LIMIT
      ? seedText.slice(0, DIFF_CHAR_LIMIT) + '\n\n... (seed material truncated at 20k chars)'
      : seedText;

  const userMessage = [
    '<seed-material>',
    escapeDataBlock(truncated),
    '</seed-material>',
    '',
    'Classify the architectural signals in this seed material. Return ONLY the JSON array.',
  ].join('\n');

  const rawOutput = await oneShotCompletion({
    token,
    model: CLASSIFIER_MODEL,
    system: systemPrompt,
    user: userMessage,
    maxTokens: MAX_TOKENS,
    ...(signal !== undefined ? { signal } : {}),
  });

  return parseClassifierOutput(rawOutput);
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

/**
 * Escape prompt-injection vectors in untrusted data block content.
 *
 * Two threats are neutralised:
 * 1. Triple-backtick sequences — a diff containing ``` would break out of the
 *    enclosing code fence and could terminate/reopen markdown blocks.
 * 2. XML closing-tag sequences (`</`) — a diff or spine file containing the
 *    literal string `</git-diff>` or `</spine-content>` would terminate the
 *    XML data block early, letting content after the fake tag be interpreted
 *    as model instructions rather than data.
 *
 * Both are escaped so they are visually equivalent but structurally inert.
 */
export function escapeDataBlock(text: string): string {
  return text.replace(/```/g, '` ` `').replace(/</g, '&lt;');
}

function buildUserMessage(diff: string, spineContent: string): string {
  const spineSection = spineContent.trim()
    ? ['<spine-content>', escapeDataBlock(spineContent), '</spine-content>'].join('\n')
    : '<spine-content>\n_(No SPINE.md exists yet — this may be the first session)_\n</spine-content>';

  return [
    '## Git Diff (this session)',
    '',
    '<git-diff>',
    '```diff',
    escapeDataBlock(diff),
    '```',
    '</git-diff>',
    '',
    '## Current SPINE.md',
    '',
    spineSection,
    '',
    'Classify the architectural signals in this diff. Return ONLY the JSON array.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

const VALID_LABELS = new Set<string>([
  'new-addition',
  'strengthens',
  'weakens',
  'contradicts',
]);
const VALID_PREFIXES = new Set<string>(['INV', 'REJ', 'TST']);

/**
 * Parse and validate the model's JSON output. Returns a best-effort result
 * even on partial parse failures so the hook can still act on valid items.
 *
 * Exported for direct unit testing of the parse pipeline.
 */
export function parseClassifierOutput(raw: string): ClassifierResult {
  // Extract JSON array from the raw output — the model may wrap it in markdown
  const jsonStr = extractJsonArray(raw);
  if (!jsonStr) {
    return { items: [], rawOutput: raw, parsed: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return { items: [], rawOutput: raw, parsed: false };
  }

  if (!Array.isArray(parsed)) {
    return { items: [], rawOutput: raw, parsed: false };
  }

  const items: SpineClassifierItem[] = [];
  for (const item of parsed) {
    const validated = validateItem(item);
    if (validated) items.push(validated);
  }

  return { items, rawOutput: raw, parsed: true };
}

function extractJsonArray(text: string): string | null {
  // Strip markdown code fences — prefer fenced content when it is a valid JSON
  // array. If the model emits a non-JSON fence first (e.g. a ```diff block),
  // fall through to the bare-array scan so we don't return unparseable content.
  const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenceMatch) {
    const content = (fenceMatch[1] ?? '').trim();
    if (content.startsWith('[')) {
      // Prefer fenced content only when it parses successfully as a JSON array
      try {
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed)) return content;
      } catch {
        // Fenced content did not parse — fall through to bare-array scan
      }
    }
    // Fence was not a parseable JSON array — fall through to bare-array scan below.
  }

  // Find the outermost [ ... ] and walk leftward on parse failure so trailing
  // prose that contains ']' does not permanently break the extraction.
  const start = text.indexOf('[');
  if (start === -1) return null;

  let end = text.lastIndexOf(']');
  while (end > start) {
    const candidate = text.slice(start, end + 1);
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) return candidate;
    } catch {
      // Not valid JSON — try the next ']' to the left
    }
    end = text.lastIndexOf(']', end - 1);
  }
  return null;
}

/** Maximum allowed length for description fields written into SPINE.md. */
export const MAX_DESCRIPTION_LEN = 300;
/** Generous cap for rationale/existingDescription — not written as entry lines. */
const MAX_RATIONALE_LEN = 500;

/**
 * Sanitize a model-returned string field: collapse embedded newlines/carriage
 * returns to a single space (preventing multi-line SPINE.md entry injection),
 * then trim and truncate to `maxLen`.
 */
function sanitizeField(value: string, maxLen: number): string {
  const cleaned = value.replace(/[\r\n]+/g, ' ').trim();
  if (cleaned.length > maxLen) {
    console.warn(
      `[spine] sanitizeField: description truncated from ${cleaned.length} to ${maxLen} chars. ` +
      `Consider raising MAX_DESCRIPTION_LEN or shortening the description. ` +
      `Truncated tail: "${cleaned.slice(maxLen, maxLen + 40)}…"`
    );
  }
  return cleaned.slice(0, maxLen);
}

function validateItem(item: unknown): SpineClassifierItem | null {
  if (typeof item !== 'object' || item === null) return null;
  const obj = item as Record<string, unknown>;

  const label = obj['label'];
  if (typeof label !== 'string' || !VALID_LABELS.has(label)) return null;

  if (label === 'new-addition') {
    const prefix = obj['prefix'];
    const description = obj['description'];
    const rationale = obj['rationale'];
    if (
      typeof prefix !== 'string' ||
      !VALID_PREFIXES.has(prefix) ||
      typeof description !== 'string' ||
      typeof rationale !== 'string'
    ) {
      return null;
    }
    return {
      label: 'new-addition',
      prefix: prefix as SpineIdPrefix,
      description: sanitizeField(description, MAX_DESCRIPTION_LEN),
      rationale: sanitizeField(rationale, MAX_RATIONALE_LEN),
    };
  }

  // strengthens / weakens / contradicts
  const existingId = obj['existingId'];
  const existingDescription = obj['existingDescription'];
  const description = obj['description'];
  const rationale = obj['rationale'];
  if (
    typeof existingId !== 'string' ||
    typeof existingDescription !== 'string' ||
    typeof description !== 'string' ||
    typeof rationale !== 'string'
  ) {
    return null;
  }
  return {
    label: label as 'strengthens' | 'weakens' | 'contradicts',
    existingId: sanitizeField(existingId, MAX_DESCRIPTION_LEN),
    existingDescription: sanitizeField(existingDescription, MAX_DESCRIPTION_LEN),
    description: sanitizeField(description, MAX_DESCRIPTION_LEN),
    rationale: sanitizeField(rationale, MAX_RATIONALE_LEN),
  };
}
