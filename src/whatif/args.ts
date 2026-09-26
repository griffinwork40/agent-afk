/**
 * Shared argument parser for `afk whatif` and `/whatif`.
 *
 * Both surfaces call `parseWhatifArgs(argv)` with a raw argv array to get a
 * `ParsedWhatifArgs` result. The CLI constructs argv from Commander's parsed
 * values; the REPL constructs argv via `tokenizeSlashArgs` (shell-like
 * tokeniser: single/double quotes, backslash escapes).
 *
 * Grammar:
 *   positional text    → joined with spaces; plain-English change description.
 *   --spec <file>      → ChangeSpec JSON/YAML file path; mutually exclusive with text.
 *   --append <text>    → append to user AFK.md
 *   --append-project   → append to project AFK.md
 *   --file <p>=<f>     → set file (path must be home:<rel> or project:<rel>)
 *   --hot <f>          → replace HOT.md
 *   --memory-add <t>   → add memory fact
 *   --memory-category  → category for the next --memory-add (default: preference)
 *   --memory-remove <id> → remove memory fact by id
 *   --disable-skill <n> → disable a skill
 *   --disable-plugin <n> → disable a plugin
 *   --model <id>       → candidate model change
 *   --effort <level>   → candidate effort level
 *   --env KEY=VALUE    → candidate env var
 *   --agent-model <id> → model under test
 *   --analyst-model <id> → analyst model (compile/predict/judge)
 *   --verify           → run episodes and verify predictions
 *   --quick            → maxTurns=1 episode mode
 *   --turns <n>        → number of real turns to replay (default 12)
 *   --samples <n>      → samples per episode per env (default 3)
 *   --max-usd <n>      → budget cap (default 5)
 *   --judge auto|jev|claude → judge selector (default auto)
 *   --concurrency <n>  → parallel episodes (default 4)
 *   --max-turns <n>    → turns per episode (default 3)
 *   --timeout <sec>    → episode timeout in seconds (default 180)
 *   --keep-sandboxes   → retain sandbox dirs after run
 *   --yes              → skip confirmation of compiled spec
 *   --json             → print JSON to stdout instead of terminal output
 *
 * Repeated flag-changes accumulate in order (e.g. multiple --memory-add).
 *
 * @module whatif/args
 */

import { readFileSync } from 'node:fs';
import type { Change, ChangeSpec } from './types.js';
export { WHATIF_USAGE } from './args.usage.js';

// ---------------------------------------------------------------------------
// Tokeniser
// ---------------------------------------------------------------------------

/**
 * Shell-like tokeniser for the `/whatif` REPL surface.
 *
 * Splits on whitespace; respects single-quoted strings (literal), double-quoted
 * strings (backslash escapes for \", \\, \n), and bare backslash escapes.
 * Returns the array of tokens in order.
 */
export function tokenizeSlashArgs(raw: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let i = 0;

  while (i < raw.length) {
    const ch = raw[i]!;

    if (ch === "'") {
      // Single-quote: everything literal until closing '
      i++;
      while (i < raw.length && raw[i] !== "'") {
        current += raw[i]!;
        i++;
      }
      i++; // consume closing '
    } else if (ch === '"') {
      // Double-quote: backslash escapes for \", \\, \n; rest literal
      i++;
      while (i < raw.length && raw[i] !== '"') {
        if (raw[i] === '\\' && i + 1 < raw.length) {
          const next = raw[i + 1]!;
          if (next === '"') { current += '"'; i += 2; }
          else if (next === '\\') { current += '\\'; i += 2; }
          else if (next === 'n') { current += '\n'; i += 2; }
          else { current += '\\'; i++; }
        } else {
          current += raw[i]!;
          i++;
        }
      }
      i++; // consume closing "
    } else if (ch === '\\' && i + 1 < raw.length) {
      // Bare backslash escape
      current += raw[i + 1]!;
      i += 2;
    } else if (/\s/.test(ch)) {
      if (current.length > 0) { tokens.push(current); current = ''; }
      i++;
    } else {
      current += ch;
      i++;
    }
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/** Partial WhatifOptions fields that can be set from flags. */
export interface WhatifFlagOptions {
  agentModel?: string;
  analystModel?: string;
  verify: boolean;
  turns: number;
  samples: number;
  maxUsd: number;
  judge: 'auto' | 'jev' | 'claude';
  concurrency: number;
  maxTurns: number;
  episodeTimeoutMs: number;
  keepSandboxes: boolean;
}

export interface ParsedWhatifArgs {
  /** Changes assembled from explicit flags (--append, --file, etc.) */
  flagChanges: Change[];
  /** Plain-English description text (positional args joined). */
  text?: string;
  /** Path to a --spec file. */
  specFile?: string;
  /** Parsed runtime/run options. */
  options: WhatifFlagOptions;
  /** Skip confirmation of compiled plain-English spec. */
  yes: boolean;
  /** Emit JSON output. */
  json: boolean;
}

// WHATIF_USAGE is re-exported from args.usage.ts (extracted for the 350-line ceiling).
import { WHATIF_USAGE } from './args.usage.js';

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/** Returned as a string (the error message) when parsing fails. */
export type ParseResult = ParsedWhatifArgs | string;

const MEMORY_CATEGORIES = new Set<string>(['preference', 'convention', 'decision', 'learning']);
const JUDGE_VALUES = new Set<string>(['auto', 'jev', 'claude']);

/** Mutable state container for parseWhatifArgs run-option flags. */
interface RunState {
  agentModel?: string;
  analystModel?: string;
  verify: boolean;
  turns: number;
  samples: number;
  maxUsd: number;
  judge: 'auto' | 'jev' | 'claude';
  concurrency: number;
  maxTurns: number;
  episodeTimeoutMs: number;
  keepSandboxes: boolean;
  yes: boolean;
  json: boolean;
  specFile?: string;
}

/**
 * Parse a single run-option flag, mutating `state`.
 * Returns advance count (1 or 2) on success, error string on failure,
 * or 0 when the token is not a run-option flag.
 */
function parseRunOptionFlag(token: string, nextVal: string | undefined, state: RunState): number | string {
  switch (token) {
    case '--agent-model':
      if (!nextVal) return `--agent-model requires a model id\n\n${WHATIF_USAGE}`;
      state.agentModel = nextVal; return 2;
    case '--analyst-model':
      if (!nextVal) return `--analyst-model requires a model id\n\n${WHATIF_USAGE}`;
      state.analystModel = nextVal; return 2;
    case '--spec':
      if (!nextVal) return `--spec requires a file path\n\n${WHATIF_USAGE}`;
      state.specFile = nextVal; return 2;
    case '--verify': state.verify = true; return 1;
    case '--quick': state.maxTurns = 1; return 1;
    case '--yes': state.yes = true; return 1;
    case '--json': state.json = true; return 1;
    case '--keep-sandboxes': state.keepSandboxes = true; return 1;
    case '--turns': {
      if (!nextVal) return `--turns requires a number\n\n${WHATIF_USAGE}`;
      const n = parseInt(nextVal, 10);
      if (isNaN(n) || n < 1) return `--turns: must be a positive integer, got: ${nextVal}`;
      state.turns = n; return 2;
    }
    case '--samples': {
      if (!nextVal) return `--samples requires a number\n\n${WHATIF_USAGE}`;
      const n = parseInt(nextVal, 10);
      if (isNaN(n) || n < 1) return `--samples: must be a positive integer, got: ${nextVal}`;
      state.samples = n; return 2;
    }
    case '--max-usd': {
      if (!nextVal) return `--max-usd requires a number\n\n${WHATIF_USAGE}`;
      const n = parseFloat(nextVal);
      if (isNaN(n) || n <= 0) return `--max-usd: must be a positive number, got: ${nextVal}`;
      state.maxUsd = n; return 2;
    }
    case '--judge': {
      if (!nextVal || !JUDGE_VALUES.has(nextVal)) {
        return `--judge must be one of: auto|jev|claude\n\n${WHATIF_USAGE}`;
      }
      state.judge = nextVal as 'auto' | 'jev' | 'claude'; return 2;
    }
    case '--concurrency': {
      if (!nextVal) return `--concurrency requires a number\n\n${WHATIF_USAGE}`;
      const n = parseInt(nextVal, 10);
      if (isNaN(n) || n < 1) return `--concurrency: must be a positive integer, got: ${nextVal}`;
      state.concurrency = n; return 2;
    }
    case '--max-turns': {
      if (!nextVal) return `--max-turns requires a number\n\n${WHATIF_USAGE}`;
      const n = parseInt(nextVal, 10);
      if (isNaN(n) || n < 1) return `--max-turns: must be a positive integer, got: ${nextVal}`;
      state.maxTurns = n; return 2;
    }
    case '--timeout': {
      if (!nextVal) return `--timeout requires a number (seconds)\n\n${WHATIF_USAGE}`;
      const n = parseInt(nextVal, 10);
      if (isNaN(n) || n < 1) return `--timeout: must be a positive integer, got: ${nextVal}`;
      state.episodeTimeoutMs = n * 1000; return 2;
    }
    default: return 0; // not a run-option flag
  }
}

/**
 * Parse an argv array (no process name, no command name) into `ParsedWhatifArgs`
 * or an error string.
 *
 * Flags are consumed left-to-right; positional tokens (neither `-`-prefixed nor
 * flag argument values) are joined as the plain-English text.
 */
export function parseWhatifArgs(argv: string[]): ParseResult {
  const flagChanges: Change[] = [];
  const positionals: string[] = [];
  let pendingMemoryCategory: 'preference' | 'convention' | 'decision' | 'learning' = 'preference';

  const state: RunState = {
    verify: false,
    turns: 12,
    samples: 3,
    maxUsd: 5,
    judge: 'auto',
    concurrency: 4,
    maxTurns: 3,
    episodeTimeoutMs: 180_000,
    keepSandboxes: false,
    yes: false,
    json: false,
  };

  let i = 0;
  while (i < argv.length) {
    const token = argv[i]!;

    // -- terminates flag parsing
    if (token === '--') { i++; while (i < argv.length) { positionals.push(argv[i]!); i++; } break; }

    if (!token.startsWith('-')) { positionals.push(token); i++; continue; }

    const nextVal = argv[i + 1];

    // Delegate run-option flags to the named helper.
    const runResult = parseRunOptionFlag(token, nextVal, state);
    if (typeof runResult === 'string') return runResult;
    if (runResult > 0) { i += runResult; continue; }

    // Change flags (accumulate into flagChanges).
    const changeResult = parseChangeFlagToken(token, nextVal, pendingMemoryCategory);
    if (typeof changeResult === 'string') return changeResult;
    if (changeResult !== null) {
      if (changeResult.change) flagChanges.push(changeResult.change);
      if (changeResult.newCategory) pendingMemoryCategory = changeResult.newCategory;
      i += changeResult.advance;
      continue;
    }

    return `Unknown flag: ${token}\n\n${WHATIF_USAGE}`;
  }

  const text = positionals.length > 0 ? positionals.join(' ') : undefined;

  if (state.specFile && (flagChanges.length > 0 || text)) {
    return `--spec cannot be combined with change flags or plain-text\n\n${WHATIF_USAGE}`;
  }

  if (!text && !state.specFile && flagChanges.length === 0) {
    return `whatif: nothing to predict — provide a description, flags, or --spec\n\n${WHATIF_USAGE}`;
  }

  return {
    flagChanges,
    text,
    specFile: state.specFile,
    options: {
      agentModel: state.agentModel,
      analystModel: state.analystModel,
      verify: state.verify,
      turns: state.turns,
      samples: state.samples,
      maxUsd: state.maxUsd,
      judge: state.judge,
      concurrency: state.concurrency,
      maxTurns: state.maxTurns,
      episodeTimeoutMs: state.episodeTimeoutMs,
      keepSandboxes: state.keepSandboxes,
    },
    yes: state.yes,
    json: state.json,
  };
}

/** Result from parseChangeFlagToken. */
interface ChangeFlagResult {
  change?: Change;
  newCategory?: 'preference' | 'convention' | 'decision' | 'learning';
  advance: number;
}

/**
 * Parse a single change flag, returning a `ChangeFlagResult` on success,
 * an error string on failure, or `null` when the token is not a change flag.
 */
function parseChangeFlagToken(
  token: string,
  nextVal: string | undefined,
  pendingMemoryCategory: 'preference' | 'convention' | 'decision' | 'learning',
): ChangeFlagResult | string | null {
  switch (token) {
    case '--append': {
      if (!nextVal) return `--append requires a text argument\n\n${WHATIF_USAGE}`;
      return { change: { kind: 'append', target: 'user-afk-md', text: nextVal }, advance: 2 };
    }
    case '--append-project': {
      if (!nextVal) return `--append-project requires a text argument\n\n${WHATIF_USAGE}`;
      return { change: { kind: 'append', target: 'project-afk-md', text: nextVal }, advance: 2 };
    }
    case '--file': {
      if (!nextVal) return `--file requires a <path>=<localfile> argument\n\n${WHATIF_USAGE}`;
      const eqIdx = nextVal.indexOf('=');
      if (eqIdx < 1) return `--file: expected <path>=<localfile>, got: ${nextVal}\n\n${WHATIF_USAGE}`;
      const path = nextVal.slice(0, eqIdx);
      const localFile = nextVal.slice(eqIdx + 1);
      if (!path.startsWith('home:') && !path.startsWith('project:')) {
        return `--file: path must start with home: or project:, got: ${path}\n\n${WHATIF_USAGE}`;
      }
      let content: string;
      try { content = readFileSync(localFile, 'utf8'); }
      catch { return `--file: cannot read local file: ${localFile}`; }
      return { change: { kind: 'file', path, content }, advance: 2 };
    }
    case '--hot': {
      if (!nextVal) return `--hot requires a local file path\n\n${WHATIF_USAGE}`;
      let content: string;
      try { content = readFileSync(nextVal, 'utf8'); }
      catch { return `--hot: cannot read local file: ${nextVal}`; }
      return { change: { kind: 'hot', content }, advance: 2 };
    }
    case '--memory-add': {
      if (!nextVal) return `--memory-add requires a text argument\n\n${WHATIF_USAGE}`;
      return {
        change: { kind: 'memory-add', content: nextVal, category: pendingMemoryCategory },
        newCategory: 'preference',
        advance: 2,
      };
    }
    case '--memory-category': {
      if (!nextVal || !MEMORY_CATEGORIES.has(nextVal)) {
        return `--memory-category must be one of: preference|convention|decision|learning\n\n${WHATIF_USAGE}`;
      }
      return {
        newCategory: nextVal as 'preference' | 'convention' | 'decision' | 'learning',
        advance: 2,
      };
    }
    case '--memory-remove': {
      if (!nextVal) return `--memory-remove requires a numeric id\n\n${WHATIF_USAGE}`;
      const id = parseInt(nextVal, 10);
      if (isNaN(id)) return `--memory-remove: id must be a number, got: ${nextVal}\n\n${WHATIF_USAGE}`;
      return { change: { kind: 'memory-remove', id }, advance: 2 };
    }
    case '--disable-skill': {
      if (!nextVal) return `--disable-skill requires a name\n\n${WHATIF_USAGE}`;
      return { change: { kind: 'disable-skill', name: nextVal }, advance: 2 };
    }
    case '--disable-plugin': {
      if (!nextVal) return `--disable-plugin requires a name\n\n${WHATIF_USAGE}`;
      return { change: { kind: 'disable-plugin', name: nextVal }, advance: 2 };
    }
    case '--model': {
      if (!nextVal) return `--model requires a model id\n\n${WHATIF_USAGE}`;
      return { change: { kind: 'model', model: nextVal }, advance: 2 };
    }
    case '--effort': {
      if (!nextVal) return `--effort requires a level\n\n${WHATIF_USAGE}`;
      return { change: { kind: 'effort', effort: nextVal }, advance: 2 };
    }
    case '--env': {
      if (!nextVal) return `--env requires KEY=VALUE\n\n${WHATIF_USAGE}`;
      const eqIdx = nextVal.indexOf('=');
      if (eqIdx < 1) return `--env: expected KEY=VALUE, got: ${nextVal}\n\n${WHATIF_USAGE}`;
      const key = nextVal.slice(0, eqIdx);
      const value = nextVal.slice(eqIdx + 1);
      return { change: { kind: 'env', key, value }, advance: 2 };
    }
    default: return null; // not a change flag
  }
}

/**
 * Build a ChangeSpec title from the flag changes, falling back to the
 * plain-text description.
 */
export function buildFlagSpecTitle(flagChanges: Change[], text?: string): string {
  if (flagChanges.length === 0 && text) return text.slice(0, 80);
  if (flagChanges.length === 1) {
    // A one-line title suffices; describeChange is called in surface.ts
    return `${flagChanges.length} change`;
  }
  return `${flagChanges.length} changes`;
}

/**
 * Parse a ChangeSpec JSON file from disk.
 * Throws on I/O or JSON parse error.
 */
export function loadSpecFile(filePath: string): ChangeSpec {
  let raw: string;
  try { raw = readFileSync(filePath, 'utf8'); }
  catch { throw new Error(`whatif: cannot read spec file: ${filePath}`); }
  try { return JSON.parse(raw) as ChangeSpec; }
  catch { throw new Error(`whatif: spec file is not valid JSON: ${filePath}`); }
}
