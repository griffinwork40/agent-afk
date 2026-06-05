#!/usr/bin/env tsx
/**
 * Audit env-var access patterns in `src/`.
 *
 * Enforces the invariant: every `process.env.*` read in production code goes
 * through `src/config/env.ts`. CI gate. Mirrors `scripts/audit-sdk-dependency.ts`.
 *
 * Modes:
 *   (default)   — print a report of every direct `process.env` reference outside
 *                 the allowlist. Non-zero exit on any violation.
 *   --check     — same as default. Alias retained for CI clarity.
 *   --list      — list every `process.env` reference (including allowed) with
 *                 file:line — useful for spelunking when a migration misses a site.
 *
 * Allowlist contract:
 *   - `src/config/env.ts` is the canonical read-point and is unconditionally
 *     allowed.
 *   - Files where `process.env` is used dynamically (loops over arbitrary keys,
 *     forwarding to child processes, accepting env as an injectable option) are
 *     listed in `ALLOWED_FILES` with rationale. Keep the list small and explicit.
 *   - Tests (`*.test.ts`) are skipped entirely. They mutate `process.env` per
 *     case via `beforeEach`; that's expected and not a target of this audit.
 *
 * Failure mode is intentional: drift fails CI loudly, not silently in a daily
 * PR a reviewer ignores. See docs/specs/env-flag-registry.md for the design
 * decision history.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const SCAN_ROOT = path.join(repoRoot, 'src');

/**
 * Files that are allowed to access `process.env` directly. Each entry needs an
 * inline rationale; new entries should be added sparingly. When in doubt, route
 * through `src/config/env.ts` instead.
 */
const ALLOWED_FILES: ReadonlyArray<{ file: string; reason: string }> = [
  {
    file: 'src/config/env.ts',
    reason: 'The canonical read-point — every getter wraps a `process.env[...]` access.',
  },
  // src/threads.ts is intentionally NOT whole-file allowlisted. The four
  // static reads (AFK_THREADS_ALLOWED_USERNAMES, AFK_THREADS_POLL_INTERVAL_MS,
  // AFK_THREADS_DRY_RUN, AFK_THREADS_REPLY_MODE) are migrated to env.X.
  // Only the loop at ~line 314 is truly dynamic; it is tagged inline.
  {
    file: 'src/agent/tools/handlers/bash.ts',
    reason:
      'Forwards process.env to child processes via `{ ...process.env, ...context.env }`. This is whole-env forwarding, not a read of a specific var.',
  },
  {
    file: 'src/agent/tools/handlers/web-scrape.ts',
    reason: 'Accepts `env` as an injectable opt for testing; default is `process.env` (whole object).',
  },
  {
    file: 'src/agent/mcp/transport.ts',
    reason:
      'Inherits a fixed allowlist of OS-level env vars (PATH, USER, SHELL, TERM, TMPDIR, etc.) into spawned MCP server child processes. The keys are bounded but include vars outside the AFK domain (TMP, SYSTEMROOT, APPDATA) that do not belong in ENV_REGISTRY.',
  },
  {
    file: 'src/agent/providers/openai-compatible/auth.ts',
    reason:
      'Defines an injectable `readEnv?: (key: string) => string | undefined` dep for tests; the default impl is `(k) => process.env[k]`. The injectable design is the test seam and intentionally dynamic.',
  },
  {
    file: 'src/threads/token-loader.ts',
    reason:
      'Accepts `envOverride?: NodeJS.ProcessEnv` for tests; defaults to `process.env` (whole object). Same injectable-test-seam pattern as web-scrape.ts. Production callers pass neither argument.',
  },
  {
    file: 'src/cli/terminal-spawn/index.ts',
    reason:
      'Accepts `env?: NodeJS.ProcessEnv` as an injectable test opt; defaults to `process.env` (whole object) which is handed to `detectTerminal()`. That probes ~10 OS-level terminal vars (TMUX, TERM_PROGRAM, TERM, WT_SESSION, KITTY_WINDOW_ID, …) that are outside the AFK domain and do not belong in ENV_REGISTRY. Same injectable-test-seam + whole-env pattern as web-scrape.ts / token-loader.ts.',
  },
  {
    file: 'src/agent/hooks/command-executor.ts',
    reason:
      'Reads process.env to build a MINIMAL allowlist for spawned hook subprocesses: a fixed set of runtime-safe vars (PATH/HOME/SHELL/LANG/TERM/TMPDIR/TMP/TEMP/USER/LOGNAME) plus non-secret AFK_* context vars, then named additions (AFK_PROJECT_DIR/SESSION_ID/HOOK_EVENT/TOOL_NAME). NOT whole-env forwarding — secrets, including AFK_-prefixed credential aliases (AFK_TELEGRAM_BOT_TOKEN/AFK_LOCAL_API_KEY/AFK_OPENAI_API_KEY), are deliberately excluded.',
  },
];

interface Violation {
  file: string;
  line: number;
  text: string;
  varName: string | null; // null when dynamic (process.env[key])
}

/**
 * Matches `process.env.NAME`, `process.env['NAME']`, `process.env["NAME"]`,
 * `` process.env[`NAME`] ``, `process.env?.NAME`, `process['env']['NAME']`,
 * and bare variable-key forms like `process.env[key]`.
 *
 * Does NOT match (by design — handled by ENV_BARE_RE):
 *   - Destructuring: `const { KEY } = process.env`
 *   - Spread: `{ ...process.env }`
 */
const ENV_ACCESS_RE = /(?:process\.env|process\[['"]env['"]\])(?:(?:\?\.|\.)([A-Za-z_][A-Za-z0-9_]*)|\[(?:['"`]([A-Za-z_][A-Za-z0-9_]*)['"`]|([A-Za-z_$][A-Za-z0-9_$]*))\])/g;

/**
 * Matches bare `process.env` references with no trailing `.PROP` or `[PROP]`.
 * Catches destructuring (`const { KEY } = process.env`) and spread
 * (`{ ...process.env }`) that `ENV_ACCESS_RE` would miss.
 */
const ENV_BARE_RE = /(?:process\.env|process\[['"]env['"]\])(?![?.\[])/g;

/**
 * Detect whether a `process.env[...]` access is on the LHS of an assignment.
 * Writes are out of scope for this audit — the centralization goal is "no
 * scattered reads", which is the drift source. Writes are rare CLI-flag
 * propagations and are visible in code review; they don't accumulate silently
 * the way reads do.
 *
 * Recognizes simple assignment (`=`) and compound assignments: `??=`, `||=`,
 * `&&=`, `+=`, `-=`, `*=`, `/=`, `%=`, `**=`, `|=`, `&=`, `^=`, `<<=`, `>>=`,
 * `>>>=`. Does NOT match comparison (`==`, `===`) or arrow (`=>`).
 */
function isAssignment(line: string, endIndex: number): boolean {
  // Strip leading whitespace.
  const suffix = line.slice(endIndex).replace(/^\s+/, '');
  // Compound assignment operators (longest first to avoid prefix matches).
  const compound = ['>>>=', '**=', '<<=', '>>=', '??=', '||=', '&&=', '+=', '-=', '*=', '/=', '%=', '|=', '&=', '^='];
  for (const op of compound) {
    if (suffix.startsWith(op)) return true;
  }
  // Plain `=` but not `==` (comparison) or `=>` (arrow).
  if (suffix.startsWith('=') && !suffix.startsWith('==') && !suffix.startsWith('=>')) return true;
  return false;
}

/**
 * Allow a specific call site to escape the audit by tagging the same line
 * with `// audit-env-access: allow <rationale>`. Used for narrow dynamic-access
 * cases inside otherwise-migrated files (e.g., a single loop body inside a
 * file whose other reads should still be enforced).
 *
 * Prefer this over whole-file allowlisting when the file contains both
 * legitimate dynamic access AND static reads that benefit from enforcement.
 */
function hasInlineAllowMarker(line: string): boolean {
  // Locate the first `//` that is not preceded by a quote character.
  // This is a heuristic guard against injection via a string literal that
  // contains the marker text verbatim (e.g. `const s = "// audit-env-access: allow trick"`).
  // We skip the `//` if the immediately preceding non-whitespace char is a quote.
  const commentIdx = line.search(/\/{2}/);
  if (commentIdx === -1) return false;
  // Check the character immediately before `//` (ignoring whitespace) to
  // detect the inside-string pattern: `"...// audit-env-access: allow"`.
  const before = line.slice(0, commentIdx).trimEnd();
  if (before.length > 0 && /['"`]/.test(before[before.length - 1]!)) return false;
  return /audit-env-access:\s*allow\b/.test(line.slice(commentIdx));
}

function walk(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
      walk(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
}

function isAllowedFile(relPath: string): boolean {
  return ALLOWED_FILES.some((entry) => entry.file === relPath);
}

function scan(file: string, source: string): Violation[] {
  const violations: Violation[] = [];
  const lines = source.split('\n');
  const rel = path.relative(repoRoot, file);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    if (hasInlineAllowMarker(line)) continue; // narrow per-line escape hatch

    // --- Pass 1: named / indexed / dynamic accesses (process.env.X, process.env['X'], etc.) ---
    ENV_ACCESS_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ENV_ACCESS_RE.exec(line)) !== null) {
      const endIndex = match.index + match[0].length;
      if (isAssignment(line, endIndex)) continue; // writes are out of scope
      const varName = match[1] ?? match[2] ?? null; // null on dynamic (variable key)
      violations.push({
        file: rel,
        line: i + 1,
        text: line.trim(),
        varName,
      });
    }

    // --- Pass 2: bare `process.env` references (destructuring, spread) ---
    // e.g. `const { KEY } = process.env` and `{ ...process.env }`.
    // These escape Pass 1 because they have no trailing .X or [X].
    //
    // Skip lines that are purely comment content — JSDoc lines (`*`) and
    // single-line comment lines (`//`) mention `process.env` in prose
    // constantly and are not code. Default parameter values
    // (`source = process.env`) are legitimate injectable test seams and
    // are caught by the whole-file allowlist for those modules.
    const trimmed = line.trimStart();
    const isCommentLine = trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
    if (!isCommentLine) {
      ENV_BARE_RE.lastIndex = 0;
      while ((match = ENV_BARE_RE.exec(line)) !== null) {
        const endIndex = match.index + match[0].length;
        if (isAssignment(line, endIndex)) continue; // write/inject is out of scope
        // Skip default parameter values: `source: NodeJS.ProcessEnv = process.env`
        // These are injectable test seams, not scattered reads. The module
        // itself belongs in ALLOWED_FILES if it uses them.
        const suffix = line.slice(endIndex).trimStart();
        if (suffix.startsWith(')') || suffix.startsWith(',')) continue; // default param
        violations.push({
          file: rel,
          line: i + 1,
          text: line.trim(),
          varName: '<bare-ref>', // destructure / spread — var name not statically known
        });
      }
    }
  }

  return violations;
}

function main(): void {
  const args = new Set(process.argv.slice(2));
  const listMode = args.has('--list');

  const files: string[] = [];
  walk(SCAN_ROOT, files);

  const allViolations: Violation[] = [];
  const allowedHits: Violation[] = [];

  for (const file of files) {
    const rel = path.relative(repoRoot, file);
    const source = fs.readFileSync(file, 'utf8');
    const v = scan(file, source);
    if (v.length === 0) continue;
    if (isAllowedFile(rel)) {
      allowedHits.push(...v);
    } else {
      allViolations.push(...v);
    }
  }

  if (listMode) {
    console.log(`\n=== All process.env accesses in src/ ===`);
    console.log(`Allowed files: ${allowedHits.length} access(es)`);
    for (const hit of allowedHits) {
      console.log(`  ${hit.file}:${hit.line} → ${hit.varName ?? '<dynamic>'}`);
    }
    console.log(`Other files: ${allViolations.length} access(es)`);
    for (const hit of allViolations) {
      console.log(`  ${hit.file}:${hit.line} → ${hit.varName ?? '<dynamic>'}`);
    }
  }

  if (allViolations.length === 0) {
    console.log(
      `✓ audit-env-access: ${files.length} files scanned, ${allowedHits.length} legitimate process.env accesses inside allowlist, 0 violations.`,
    );
    process.exit(0);
  }

  console.error(`\n✗ audit-env-access: ${allViolations.length} direct process.env access(es) outside src/config/env.ts:\n`);

  // Group by file for readability.
  const byFile = new Map<string, Violation[]>();
  for (const v of allViolations) {
    const existing = byFile.get(v.file);
    if (existing) existing.push(v);
    else byFile.set(v.file, [v]);
  }
  for (const [file, vs] of [...byFile.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    console.error(`  ${file}`);
    for (const v of vs) {
      const name = v.varName ?? '<dynamic>';
      console.error(`    L${v.line}: process.env access (${name})`);
      console.error(`         ${v.text}`);
    }
    console.error('');
  }

  console.error('Fix:');
  console.error('  1. Replace direct process.env reads with imports from src/config/env.ts:');
  console.error("     import { env } from '<path>/config/env.js';");
  console.error("     env.AFK_MODEL   // ← was: process.env['AFK_MODEL']");
  console.error('  2. If this is a legitimate dynamic-access case (loop over arbitrary keys, child-process env');
  console.error('     forwarding), add the file to ALLOWED_FILES in scripts/audit-env-access.ts with rationale.');
  console.error('  3. Add the env var to ENV_REGISTRY + the env object in src/config/env.ts if it is new.\n');

  process.exit(1);
}

main();
