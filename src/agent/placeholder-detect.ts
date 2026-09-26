/**
 * Placeholder detection for agent output.
 *
 * Scans the turn's code-block register for unresolved placeholder tokens
 * in shellable code blocks — the failure class where the agent hands the
 * user a command like `ssh your-user@mac-mini-ip` and the user runs it
 * literally.
 *
 * Two layers:
 *   1. {@link detectPlaceholdersInBlocks} — pure detection against provided
 *      code block text, returns every match.
 *   2. {@link createPlaceholderDetectHook} — Stop hook that reads the
 *      code-block register, filters to shellable languages, runs detection,
 *      and injects a correction into the next turn via `injectContext`.
 *
 * The hook reads from the existing code-block register
 * (`src/cli/code-block-register.ts`) which already captures every fenced
 * block at render time, is reset per turn, and is enabled exclusively in
 * the REPL loop — so the hook is automatically a no-op on non-REPL
 * surfaces without any guard code.
 *
 * @module agent/placeholder-detect
 */

import type { HookContext, HookDecision, HookHandler } from './hooks.js';
import { debugLog } from '../utils/debug.js';

// ─── Shellable language filter ───────────────────────────────────────────────

/**
 * Language tags that indicate a code block contains runnable shell commands.
 * Scoping detection to these languages eliminates TypeScript generics,
 * Java constants, and other programming-language false positives at the
 * source rather than via regex counter-patterns.
 */
const SHELLABLE_LANGS = new Set([
  'bash', 'sh', 'zsh', 'shell', 'powershell', 'ps1',
  'console', 'terminal', 'command', 'cmd',
  '', // unlabeled fenced blocks are often shell commands
]);

/** True when a code block's language tag indicates shellable content. */
export function isShellableBlock(lang: string): boolean {
  return SHELLABLE_LANGS.has(lang.toLowerCase());
}

// ─── Placeholder patterns ────────────────────────────────────────────────────

/**
 * Each pattern has a name (for diagnostics), a regex, and an optional
 * validator that filters false positives from the regex match.
 */
interface PlaceholderPattern {
  name: string;
  regex: RegExp;
  /** Return false to suppress the match (false positive). */
  validate?: (match: string, fullBlock: string) => boolean;
}

// Contract: every regex uses the global flag so matchAll works. Patterns are
// ordered most-specific-first; the dedup in detectPlaceholdersInBlocks
// collapses overlapping matches by span.
//
// Invariant: PLACEHOLDER_PATTERNS is module-scope and every regex carries /g.
// Global regexes are stateful (lastIndex). This is safe because the module is
// single-threaded (Node.js event loop) AND detectPlaceholdersInBlocks resets
// pattern.regex.lastIndex = 0 before every matchAll call — so concurrent
// reentrant calls are not possible and stale lastIndex cannot leak between
// invocations.

const PLACEHOLDER_PATTERNS: PlaceholderPattern[] = [
  // ── Angle-bracket placeholders ──────────────────────────────────────────
  // <your-api-key>, <YOUR_TOKEN>, <hostname>, <port>, <user>, etc.
  {
    name: 'angle-bracket',
    regex: /<([a-zA-Z][a-zA-Z0-9_-]*(?:\s+[a-zA-Z_-]+)*)>/g,
    validate: (match) => {
      const inner = match.slice(1, -1).toLowerCase();
      if (/^\//.test(inner)) return false; // closing tags
      // Must look like a placeholder — contains a separator or known prefix
      return /[-_\s]/.test(inner) ||
        /^(?:your|my|the|this|replace|insert|enter|add|put|set|specify|provide|fill|change|update|edit|example|sample|placeholder|todo|fixme|xxx|host|user|pass|token|key|secret|name|email|domain|server|port|path|url|uri|ip|address|database|db|api|app|project|org|repo|bucket|region|account|id|value|file|dir|folder|endpoint)/.test(inner);
    },
  },

  // ── SCREAMING_SNAKE placeholders ────────────────────────────────────────
  // YOUR_API_KEY, REPLACE_WITH_TOKEN, MY_PLACEHOLDER_TOKEN
  //
  // Invariant: the prefix set MUST contain only words that are NEVER valid
  // env-var name fragments. Words like SET, ADD, UPDATE, CHANGE, ENTER,
  // INSERT, PUT, THE, EDIT were removed because they produce false positives
  // on real env vars: SET_HOME, ADD_USER, UPDATE_DB, CHANGE_LOG, INSERT_ID,
  // THE_SERVER, ENTER_KEY, PUT_OBJECT. Only keep words whose sole idiomatic
  // use is as a placeholder signal: YOUR, MY, REPLACE, PLACEHOLDER, TODO,
  // FIXME, XXX, EXAMPLE, SAMPLE.
  {
    name: 'screaming-snake',
    regex: /\b(?:YOUR|MY|REPLACE|PLACEHOLDER|TODO|FIXME|XXX|EXAMPLE|SAMPLE)[_A-Z0-9]{2,}\b/g,
    validate: (match) => {
      if (!match.includes('_')) return false;
      if (/^(?:TODO|FIXME)$/.test(match)) return false;
      return true;
    },
  },

  // ── your-* / your_* kebab/snake placeholders ───────────────────────────
  // your-user, your-api-key, your_password, your_hostname
  {
    name: 'your-prefix',
    regex: /\byour[-_][a-z][a-z0-9_-]*\b/gi,
  },

  // ── example.com family ─────────────────────────────────────────────────
  // example.com, example.org, example.net, user@example.com
  {
    name: 'example-domain',
    regex: /\b[a-zA-Z0-9._%+-]*@?example\.(?:com|org|net)\b/g,
  },

  // ── xxx / xxxx placeholder runs ────────────────────────────────────────
  // xxx.xxx.xxx.xxx, xxxx-xxxx, but not hex or common abbreviations
  {
    name: 'xxx-run',
    regex: /\bx{3,}(?:[-._]x{2,})*\b/gi,
    validate: (match) => /x{3}/i.test(match),
  },

  // ── REPLACE_ME / CHANGEME / PLACEHOLDER family ─────────────────────────
  {
    name: 'replace-me',
    regex: /\b(?:REPLACE_?ME|CHANGE_?ME|FILL_?(?:IN|ME|THIS)|FIX_?ME|TODO_?HERE|PLACEHOLDER)\b/gi,
  },
];

// ─── Detection ───────────────────────────────────────────────────────────────

export interface PlaceholderMatch {
  pattern: string;
  match: string;
  /** The code block text the match was found in. */
  block: string;
}

/**
 * Scan code block texts for unresolved placeholder tokens. Returns all
 * matches, deduplicated by the matched string.
 *
 * Pure function — no I/O, no module-state reads.
 */
export function detectPlaceholdersInBlocks(codeBlocks: string[]): PlaceholderMatch[] {
  if (codeBlocks.length === 0) return [];

  const seen = new Set<string>();
  const matches: PlaceholderMatch[] = [];

  for (const block of codeBlocks) {
    for (const pattern of PLACEHOLDER_PATTERNS) {
      pattern.regex.lastIndex = 0;
      for (const m of block.matchAll(pattern.regex)) {
        const matched = m[0];
        if (seen.has(matched)) continue;
        if (pattern.validate && !pattern.validate(matched, block)) continue;
        seen.add(matched);
        matches.push({ pattern: pattern.name, match: matched, block });
      }
    }
  }

  return matches;
}

// ─── Stop hook ───────────────────────────────────────────────────────────────

/**
 * Maximum corrections per session. After this many bounces the hook goes
 * quiet — same fail-open model as the terminal-state gate.
 */
const MAX_INJECTIONS_PER_SESSION = 2;

/**
 * The correction injected into the next turn when placeholders are detected
 * in the assistant's output code blocks. Names the specific placeholders
 * found and instructs the model to resolve them or explicitly mark them.
 */
function buildCorrection(matches: PlaceholderMatch[]): string {
  const placeholders = matches.map((m) => `\`${m.match}\``).join(', ');
  return (
    '[placeholder-detect] The previous turn contained shell code blocks with ' +
    `unresolved placeholder values: ${placeholders}. ` +
    'Before presenting commands to the user, do ONE of:\n' +
    '  (a) resolve the actual values (run a discovery command, read config, ' +
    'or ask the user) and restate the command with real values; or\n' +
    '  (b) if the values genuinely cannot be resolved, wrap each placeholder ' +
    'in a prominent callout (e.g. "⚠ Replace `<your-token>` with ...") so ' +
    'the user cannot miss that substitution is required.\n' +
    'Do not restate the same command with the same placeholders.'
  );
}

/**
 * Build a `Stop` hook handler that detects unresolved placeholders in the
 * turn's shellable code blocks and injects a correction into the next turn.
 *
 * Reads from the code-block register (`src/cli/code-block-register.ts`)
 * which is enabled exclusively in the REPL loop — the hook is automatically
 * a no-op on non-REPL surfaces without any guard code.
 *
 * Accepts a `getCodeBlocks` getter to decouple from the module-scope
 * register (testable without module state).
 *
 * Same lifecycle contract as the terminal-state gate: never blocks, never
 * throws, bounded injections per session, fails open.
 */
export function createPlaceholderDetectHook(deps?: {
  getCodeBlocks?: () => readonly { type: string; lang: string; text: string }[];
}): HookHandler {
  let injections = 0;
  // Lazy-import to avoid a circular dep at module load time (agent/ → cli/).
  // The register is module-scope singleton state, so the import is deferred
  // to first invocation. In tests, deps.getCodeBlocks bypasses this entirely.
  let resolvedGetter: (() => readonly { type: string; lang: string; text: string }[]) | undefined =
    deps?.getCodeBlocks;

  return (context: HookContext): HookDecision => {
    if (context.event !== 'Stop') return {};
    if (context.parentSessionId) return {};
    if (injections >= MAX_INJECTIONS_PER_SESSION) return {};

    // Resolve the getter on first call (lazy import avoids load-time dep).
    if (!resolvedGetter) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mod = require('../../cli/code-block-register.js') as
          { getCodeBlocks: () => readonly { type: string; lang: string; text: string }[] };
        resolvedGetter = mod.getCodeBlocks;
      } catch {
        return {}; // register not available (non-REPL surface)
      }
    }

    const allBlocks = resolvedGetter();
    if (allBlocks.length === 0) return {};

    // Filter to shellable code blocks only — eliminates TS generics,
    // Java constants, and other programming-language false positives.
    const shellTexts = allBlocks
      .filter((b) => b.type === 'code_block' && isShellableBlock(b.lang))
      .map((b) => b.text);

    const matches = detectPlaceholdersInBlocks(shellTexts);
    if (matches.length === 0) return {};

    injections += 1;
    debugLog(
      `[placeholder-detect] found ${matches.length} placeholder(s) in shell code blocks ` +
        `(${injections}/${MAX_INJECTIONS_PER_SESSION})`,
      { sessionId: context.sessionId, placeholders: matches.map((m) => m.match) },
    );

    return { injectContext: buildCorrection(matches) };
  };
}
