/**
 * Snapshot extraction helpers for the AFK runner.
 *
 * Extracted from `afk-runner.ts` to stay within the 350-line ceiling.
 * Owns: parsing a captured Anthropic Messages request body into a
 * {@link RequestSnapshot}, and building CLI args for the snapshot spawn.
 *
 * @module whatif/runner/afk-runner.snapshot
 */

import type { RequestSnapshot } from '../types.js';
import type { CapturedRequest } from './capture-server.js';

// ---------------------------------------------------------------------------
// Body extraction helpers (pure functions)
// ---------------------------------------------------------------------------

/** Concatenate system prompt parts into a single string. */
function extractSystem(system: unknown): string {
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system
      .map((block: unknown) => {
        if (typeof block === 'string') return block;
        if (block !== null && typeof block === 'object') {
          const b = block as Record<string, unknown>;
          if (b['type'] === 'text' && typeof b['text'] === 'string') return b['text'];
        }
        return '';
      })
      .filter(Boolean)
      .join('\n\n');
  }
  return '';
}

/** Extract tool definitions from the request body. */
function extractTools(tools: unknown): { name: string; description: string }[] {
  if (!Array.isArray(tools)) return [];
  const result: { name: string; description: string }[] = [];
  for (const t of tools) {
    if (t === null || typeof t !== 'object') continue;
    const tool = t as Record<string, unknown>;
    if (typeof tool['name'] !== 'string') continue;
    result.push({
      name: tool['name'],
      description: typeof tool['description'] === 'string' ? tool['description'] : '',
    });
  }
  return result;
}

/** Extract text from the first user message content. */
function extractFirstUserMessage(messages: unknown): string {
  if (!Array.isArray(messages)) return '';
  const firstUser = messages.find(
    (m: unknown) => m !== null && typeof m === 'object' && (m as Record<string, unknown>)['role'] === 'user',
  );
  if (!firstUser) return '';
  const msg = firstUser as Record<string, unknown>;
  const content = msg['content'];
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block: unknown) => {
        if (typeof block === 'string') return block;
        if (block !== null && typeof block === 'object') {
          const b = block as Record<string, unknown>;
          if (b['type'] === 'text' && typeof b['text'] === 'string') return b['text'];
        }
        return '';
      })
      .filter(Boolean)
      .join('');
  }
  return '';
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

/** Regex for Anthropic API key redaction. */
const SK_ANT_PATTERN = /sk-ant-[A-Za-z0-9_-]+/g;

function redactSecrets(s: string): string {
  return s.replace(SK_ANT_PATTERN, '[REDACTED]');
}

/**
 * Build a {@link RequestSnapshot} from the list of captured /messages requests.
 *
 * Uses the FIRST captured request (the probe turn's initial request).
 * Throws if nothing was captured.
 */
export function buildSnapshotFromRequests(
  requests: CapturedRequest[],
  stderrTail: string,
): RequestSnapshot {
  if (requests.length === 0) {
    throw new Error(
      `whatif snapshot: no /messages request was captured — the child may have ` +
      `failed before making a model call. ` +
      `stderr tail: ${redactSecrets(stderrTail.slice(-500))}`,
    );
  }

  const body = requests[0]?.body as Record<string, unknown>;
  const model = typeof body['model'] === 'string' ? body['model'] : '';
  const system = extractSystem(body['system']);
  const tools = extractTools(body['tools']);
  const firstUserMessage = extractFirstUserMessage(body['messages']);

  return { model, system, tools, firstUserMessage };
}

/**
 * Build the CLI args array for the snapshot spawn.
 *
 * Kept separate so tests can verify the arg list without spawning.
 */
export function buildSnapshotCliArgs(
  baseEntryArgs: string[],
  prompt: string,
  model?: string,
  effort?: string,
): string[] {
  return [
    ...baseEntryArgs,
    '--format', 'json',
    '--max-turns', '1',
    ...(model ? ['--model', model] : []),
    ...(effort ? ['--effort', effort] : []),
    prompt,
  ];
}
