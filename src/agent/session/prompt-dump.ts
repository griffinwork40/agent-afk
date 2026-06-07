/**
 * System prompt provenance tracking and debugging dump.
 *
 * Provides:
 * - deriveResolution: classify systemPrompt union shapes
 * - dumpIfEnabled: optional env-driven logging to stderr or file
 *
 * @module agent/session/prompt-dump
 */

import { env } from '../../config/env.js';
import { mkdirSync, appendFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { dirname } from 'path';

export type PromptShape = 'string' | 'string[]' | 'preset' | 'undefined';

export interface SystemPromptProvenance {
  // e.g. "env:AFK_SYSTEM_PROMPT", "file:/abs/path", "afk-md:/abs/path/AFK.md", "none".
  // Top-level surfaces layer the framework base under the operator overlay and
  // report a composed value: "framework" (base only), "framework+afk-md:/path"
  // (base + overlay), etc. See resolveBaseSystemPrompt() in cli/shared-helpers.ts.
  source: string;
  shape: PromptShape;
  length?: number; // chars for string, joined length for string[], append length for preset
}

export interface Provenance {
  systemPrompt?: SystemPromptProvenance;
  model?: { source: string };
  apiKey?: { source: string };
}

export type ResolutionKind =
  | 'custom-string'
  | 'custom-string-array'
  | 'preset-claude-code'
  | 'undefined';

export interface Resolution {
  kind: ResolutionKind;
  note: string;
  append?: { length: number };
  excludeDynamicSections?: boolean;
}

export interface DumpPayload {
  prompt: unknown; // pass through as-is (user prompt or iterable summary)
  options: unknown; // SDK Options object
  provenance: Provenance;
}

/**
 * Warning banner prepended to every dump file. Defense-in-depth reminder that
 * the dump may contain plaintext secrets from the system prompt or messages.
 */
export const DUMP_FILE_BANNER =
  '# AFK PROMPT DUMP — May contain secrets. Inspect before sharing.\n';

const SECRET_KEY_PATTERN = /key|token|secret|password|credential|auth/i;

/**
 * Inline secret patterns used to redact high-risk strings inside arbitrary
 * text fields (system prompt, message content).  Covers:
 *   - Anthropic API keys: sk-ant-*
 *   - Bearer tokens: Bearer <value>
 *   - AWS access keys: AKIA…
 *   - Slack bot tokens: xoxb-*
 *   - Generic KEY=value pairs where the value looks like a high-entropy secret
 *     (≥16 chars of non-whitespace after the '=').
 */
const INLINE_SECRET_PATTERNS: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
  // Anthropic key: sk-ant-... (up to 200 chars)
  [/sk-ant-[A-Za-z0-9_\-]{8,200}/g, (m) => `<REDACTED sk-ant length=${m[0].length}>`],
  // OpenAI key: sk-... (up to 200 chars, not overlapping sk-ant pattern above)
  [/sk-(?!ant-)[A-Za-z0-9_\-]{20,200}/g, (m) => `<REDACTED sk- length=${m[0].length}>`],
  // Bearer token
  [/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, (m) => `<REDACTED Bearer length=${m[0].length}>`],
  // AWS access key
  [/AKIA[A-Z0-9]{16}/g, (m) => `<REDACTED AKIA length=${m[0].length}>`],
  // Slack bot/user tokens
  [/xox[baprs]-[A-Za-z0-9\-]{10,200}/g, (m) => `<REDACTED xox token length=${m[0].length}>`],
  // Telegram bot token: <digits>:<alphanum 35 chars>
  [/\d{8,12}:[A-Za-z0-9_\-]{35}/g, (m) => `<REDACTED Telegram token length=${m[0].length}>`],
  // Generic TOKEN=<value ≥16 chars> — catches OPENAI_API_KEY=, TELEGRAM_BOT_TOKEN=, etc.
  // (The existing generic pattern already covers most of these; this is belt-and-suspenders
  //  for lowercase variants, e.g. openai_api_key=...)
  // Both capture groups are required by the regex structure: group 1 is [A-Za-z_]{3,}...
  // and group 2 is [^\s]{16,}, so neither can be absent on a successful match.
  // We assert (non-null assertion) rather than using ?? '' to avoid a misleading length=0
  // in the redaction marker if the regex were ever changed to make groups optional.
  [/([A-Za-z_]{3,}(?:[Kk][Ee][Yy]|[Tt][Oo][Kk][Ee][Nn]|[Ss][Ee][Cc][Rr][Ee][Tt]|[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]|[Cc][Rr][Ee][Dd][Ee][Nn][Tt][Ii][Aa][Ll])[A-Za-z_]*)=([^\s]{16,})/g,
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    (m) => `${m[1]!}=<REDACTED length=${m[2]!.length}>`],
  // Generic KEY=<high-entropy value> — UPPERCASE variant (kept for backward compat)
  // Same invariant: both groups are structural requirements of the regex.
  [/([A-Z_]{3,}(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)[A-Z_]*)=([^\s]{16,})/g,
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    (m) => `${m[1]!}=<REDACTED length=${m[2]!.length}>`],
];

/**
 * Apply inline secret redaction patterns to a string.
 * Returns a new string with matched secrets replaced by redaction markers.
 */
export function redactInlineSecrets(text: string): string {
  let result = text;
  for (const [pattern, replacer] of INLINE_SECRET_PATTERNS) {
    result = result.replace(pattern, (...args) => {
      // args: full match + capture groups + offset + original string
      // Build a fake RegExpMatchArray with index 0 = full match, 1..n = groups
      const m = args.slice(0, args.length - 2) as unknown as RegExpMatchArray;
      return replacer(m);
    });
  }
  return result;
}

/**
 * Redact a string value in an unknown payload — applies inline secret patterns.
 */
function redactStringValue(v: unknown): unknown {
  if (typeof v === 'string') return redactInlineSecrets(v);
  if (Array.isArray(v)) return v.map(redactStringValue);
  return v;
}

/**
 * Shallow-clone `options` with:
 *   1. Any secret-looking values in `options.env` replaced by `"<REDACTED length=N>"`.
 *   2. `options.system` (assembled system prompt string) run through inline-secret redaction.
 *   3. `options.systemPrompt` (SDK preset/string) run through inline-secret redaction.
 *
 * Prevents `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, and secrets
 * embedded in AFK.md or env-injected prompts from landing in dump files.
 */
function redactSecrets(options: unknown): unknown {
  if (options === null || typeof options !== 'object') return options;
  const src = options as Record<string, unknown>;
  const out: Record<string, unknown> = { ...src };

  // Redact secret-named keys in options.env
  const env = src['env'];
  if (env && typeof env === 'object') {
    const redactedEnv: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
      if (SECRET_KEY_PATTERN.test(k) && typeof v === 'string') {
        redactedEnv[k] = `<REDACTED length=${v.length}>`;
      } else {
        redactedEnv[k] = v;
      }
    }
    out['env'] = redactedEnv;
  }

  // Redact inline secrets in options.system (assembled system prompt in anthropic-direct)
  if ('system' in src) {
    out['system'] = redactStringValue(src['system']);
  }

  // Redact inline secrets in options.systemPrompt (SDK preset/string/array)
  if ('systemPrompt' in src) {
    out['systemPrompt'] = redactStringValue(src['systemPrompt']);
  }

  return out;
}

/**
 * Derive the resolution kind and note for a given systemPrompt value.
 * Handles the SDK's systemPrompt union: undefined | string | string[] | {type:'preset', preset:'claude_code', ...}
 */
export function deriveResolution(systemPrompt: unknown): Resolution {
  // Undefined / null case
  if (systemPrompt === undefined || systemPrompt === null) {
    return {
      kind: 'undefined',
      note: 'SDK uses minimal prompt; claude_code preset NOT loaded',
    };
  }

  // String case
  if (typeof systemPrompt === 'string') {
    return {
      kind: 'custom-string',
      note: 'SDK uses this string as full system prompt; claude_code preset NOT loaded',
    };
  }

  // Array case
  if (Array.isArray(systemPrompt)) {
    return {
      kind: 'custom-string-array',
      note: 'SDK uses array as full system prompt with cache boundaries; claude_code preset NOT loaded',
    };
  }

  // Object case
  if (typeof systemPrompt === 'object') {
    const obj = systemPrompt as Record<string, unknown>;

    // Check for preset claude_code shape
    if (
      obj['type'] === 'preset' &&
      obj['preset'] === 'claude_code'
    ) {
      const resolution: Resolution = {
        kind: 'preset-claude-code',
        note: 'claude_code preset loaded',
      };

      // Add append length if present
      if (typeof obj['append'] === 'string') {
        resolution.append = { length: (obj['append'] as string).length };
      }

      // Add excludeDynamicSections if present
      if (obj['excludeDynamicSections'] === true) {
        resolution.excludeDynamicSections = true;
      }

      return resolution;
    }

    // Unrecognized object shape
    return {
      kind: 'custom-string',
      note: 'Unrecognized systemPrompt shape; treated as opaque',
    };
  }

  // Default fallback
  return {
    kind: 'custom-string',
    note: 'Unrecognized systemPrompt shape; treated as opaque',
  };
}

/**
 * Optionally dump prompt, options, and provenance to stderr or a file,
 * controlled by the AFK_DUMP_PROMPT environment variable.
 *
 * Behavior:
 * - Unset / empty / "0" / "false" (case-insensitive) → no-op
 * - "1" / "true" / "stderr" (case-insensitive) → write JSON to stderr
 * - Any other value → treat as file path, append JSONL
 *
 * File mode:
 * - Resolves relative paths relative to cwd
 * - Creates parent directories with mkdir -p
 * - Prepends DUMP_FILE_BANNER on first write (if file is new/empty)
 * - Appends one JSON line per call (JSONL)
 * - On write failure, logs to stderr with [prompt-dump] prefix and continues
 *
 * Security:
 * - options.env secret-named keys are replaced by "<REDACTED length=N>"
 * - options.system and options.systemPrompt are run through inline-secret
 *   redaction (covers sk-ant-*, Bearer, AKIA, xox tokens, KEY=value patterns)
 * - A warning is always emitted to stderr when the flag is active, reminding
 *   the user to inspect the output for secrets before sharing
 *
 * Output JSON shape:
 * {
 *   "timestamp": "<ISO string>",
 *   "prompt": <payload.prompt>,
 *   "options": <payload.options>,
 *   "provenance": <payload.provenance>,
 *   "resolution": <deriveResolution(payload.options?.systemPrompt)>
 * }
 */
export function dumpIfEnabled(payload: DumpPayload): void {
  // Read env var fresh on each call
  const envValue = env.AFK_DUMP_PROMPT;

  // Check if disabled
  if (!envValue || envValue === '' || envValue === '0' || envValue.toLowerCase() === 'false') {
    return;
  }

  // Emit security warning to stderr on every call — defense in depth
  process.stderr.write(
    '[--dump-prompt] WARNING: dump may contain secrets from system prompt or messages. Inspect before sharing.\n',
  );

  // Derive resolution from systemPrompt in options
  const options = payload.options as Record<string, unknown> | unknown;
  const systemPrompt = typeof options === 'object' && options !== null
    ? (options as Record<string, unknown>)['systemPrompt']
    : undefined;
  const resolution = deriveResolution(systemPrompt);

  // Construct output object — redact secrets from options before writing
  const output = {
    timestamp: new Date().toISOString(),
    prompt: payload.prompt,
    options: redactSecrets(payload.options),
    provenance: payload.provenance,
    resolution,
  };

  // Check if stderr mode
  if (
    envValue === '1' ||
    envValue.toLowerCase() === 'true' ||
    envValue.toLowerCase() === 'stderr'
  ) {
    // For stderr: pretty-print with 2-space indent, followed by newline
    const prettyJson = JSON.stringify(output, null, 2) + '\n';
    process.stderr.write(prettyJson);
    return;
  }

  // File mode: resolve path, create parent dirs, append (compact JSONL)
  const filePath = resolve(envValue);
  const parentDir = dirname(filePath);

  try {
    // Create parent directory
    mkdirSync(parentDir, { recursive: true });
    // Write banner comment only when the file is new (first write)
    const isNewFile = !existsSync(filePath);
    const jsonLine = (isNewFile ? DUMP_FILE_BANNER : '') + JSON.stringify(output) + '\n';
    appendFileSync(filePath, jsonLine);
  } catch (err) {
    const errorMsg = `[prompt-dump] Failed to write to ${filePath}: ${String(err)}\n`;
    process.stderr.write(errorMsg);
  }
}
