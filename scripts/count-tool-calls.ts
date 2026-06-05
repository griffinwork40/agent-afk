#!/usr/bin/env tsx
// Counts how many times each tool was called, from the witness-layer traces.
//
// Source of truth: every tool dispatch emits a `tool_call` event twice —
// `phase: "started"` before dispatch and `phase: "completed"` after (see
// src/agent/trace/types.ts). Both lines share a `toolUseId`, so we dedupe by
// (file, toolUseId) to count each call exactly once. A call seen only as
// `started` (no `completed`) is tallied as in-flight/aborted.
//
// Traces live at $AFK_HOME/state/witness/<sessionId>/trace.jsonl
// (default ~/.afk/state/witness/...). Each line is { ts, seq, kind, payload }.
//
// Usage:
//   tsx scripts/count-tool-calls.ts                 # all sessions
//   tsx scripts/count-tool-calls.ts --session <id>  # one session (id or prefix)
//   tsx scripts/count-tool-calls.ts --file <path>   # one trace.jsonl
//   tsx scripts/count-tool-calls.ts --days 7        # only the last 7 days
//   tsx scripts/count-tool-calls.ts --since 2026-05-01T00:00:00Z
//   tsx scripts/count-tool-calls.ts --top 10        # show only the top 10 tools
//   tsx scripts/count-tool-calls.ts --json          # machine-readable output
//
// Exit codes: 0 on success (even with zero traces), 2 on bad arguments.

import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

// ─── AFK_HOME resolution ─────────────────────────────────────────────────────
// Mirrors getAfkHome() in src/paths.ts. Resolved inline (not imported) so this
// analysis script stays standalone and free of the config/env import graph.
function getAfkHome(): string {
  const envVal = process.env['AFK_HOME'];
  if (envVal !== undefined && envVal !== '') {
    if (!isAbsolute(envVal) || envVal === '/') {
      throw new Error(`AFK_HOME must be an absolute path that is not /, got: ${envVal}`);
    }
    return envVal;
  }
  return join(homedir(), '.afk');
}

const WITNESS_ROOT = join(getAfkHome(), 'state', 'witness');

// ─── CLI args ────────────────────────────────────────────────────────────────
interface Options {
  file?: string;
  session?: string;
  sinceMs?: number;
  top?: number;
  json: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const opts: Options = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '-h':
      case '--help':
        printHelp();
        process.exit(0);
        break;
      case '--json':
        opts.json = true;
        break;
      case '--file':
        opts.file = requireValue(argv, ++i, '--file');
        break;
      case '--session':
        opts.session = requireValue(argv, ++i, '--session');
        break;
      case '--since': {
        const raw = requireValue(argv, ++i, '--since');
        const ms = Date.parse(raw);
        if (Number.isNaN(ms)) fail(`--since: not a valid date: ${raw}`);
        opts.sinceMs = ms;
        break;
      }
      case '--days': {
        const raw = requireValue(argv, ++i, '--days');
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0) fail(`--days: expected a positive number, got: ${raw}`);
        opts.sinceMs = Date.now() - n * 86_400_000;
        break;
      }
      case '--top': {
        const raw = requireValue(argv, ++i, '--top');
        const n = Number(raw);
        if (!Number.isInteger(n) || n <= 0) fail(`--top: expected a positive integer, got: ${raw}`);
        opts.top = n;
        break;
      }
      default:
        fail(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

function requireValue(argv: readonly string[], idx: number, flag: string): string {
  const v = argv[idx];
  if (v === undefined) fail(`${flag} requires a value`);
  return v as string;
}

function fail(msg: string): never {
  process.stderr.write(`count-tool-calls: ${msg}\n`);
  process.stderr.write(`Run with --help for usage.\n`);
  process.exit(2);
}

function printHelp(): void {
  process.stdout.write(
    [
      'Count how many times each tool was called, from witness traces.',
      '',
      'Usage: tsx scripts/count-tool-calls.ts [options]',
      '',
      'Options:',
      '  --session <id>   Scope to one session (full id or unique prefix).',
      '  --file <path>    Analyze a single trace.jsonl file.',
      '  --since <ISO>    Only count events at/after this timestamp.',
      '  --days <N>       Only count events from the last N days.',
      '  --top <N>        Show only the top N tools.',
      '  --json           Emit JSON instead of a table.',
      '  -h, --help       Show this help.',
      '',
      `Witness root: ${WITNESS_ROOT}`,
    ].join('\n') + '\n',
  );
}

// ─── Trace file discovery ────────────────────────────────────────────────────
function discoverTraceFiles(opts: Options): string[] {
  if (opts.file !== undefined) {
    if (!existsSync(opts.file)) fail(`--file: no such file: ${opts.file}`);
    return [opts.file];
  }
  if (!existsSync(WITNESS_ROOT)) {
    process.stderr.write(`count-tool-calls: witness root does not exist: ${WITNESS_ROOT}\n`);
    return [];
  }
  let dirs: string[];
  try {
    dirs = readdirSync(WITNESS_ROOT);
  } catch (err) {
    fail(`cannot read witness root ${WITNESS_ROOT}: ${(err as Error).message}`);
  }
  if (opts.session !== undefined) {
    const prefix = opts.session;
    dirs = dirs.filter((d) => d === prefix || d.startsWith(prefix));
    if (dirs.length === 0) fail(`--session: no session directory matches: ${prefix}`);
  }
  const files: string[] = [];
  for (const d of dirs) {
    const candidate = join(WITNESS_ROOT, d, 'trace.jsonl');
    try {
      if (statSync(candidate).isFile()) files.push(candidate);
    } catch {
      // No trace.jsonl in this dir (e.g. only sidecars) — skip silently.
    }
  }
  return files;
}

// ─── Aggregation ─────────────────────────────────────────────────────────────
interface ToolStat {
  calls: number; // distinct toolUseIds attributed to this tool
  errors: number; // completed calls whose result was is_error
  incomplete: number; // started but never seen completed (aborted/in-flight)
}

interface PerCallState {
  name: string;
  completed: boolean;
  isError: boolean;
}

interface Totals {
  filesScanned: number;
  filesEmpty: number;
  malformedLines: number;
  minTs: string | undefined;
  maxTs: string | undefined;
}

function emptyStat(): ToolStat {
  return { calls: 0, errors: 0, incomplete: 0 };
}

async function scanFile(
  path: string,
  sinceMs: number | undefined,
  stats: Map<string, ToolStat>,
  totals: Totals,
): Promise<void> {
  // Per-file dedupe: toolUseId is only unique within a single trace (the
  // OpenAI-compatible provider emits ids like "call_1" that recur across
  // sessions), so the dedupe key is scoped to this file.
  const perCall = new Map<string, PerCallState>();
  let sawAnyToolCall = false;

  const rl = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed === '' || !trimmed.includes('"tool_call"')) continue;

      let rec: unknown;
      try {
        rec = JSON.parse(trimmed);
      } catch {
        totals.malformedLines++;
        continue;
      }
      if (typeof rec !== 'object' || rec === null) continue;
      const r = rec as { ts?: unknown; kind?: unknown; seq?: unknown; payload?: unknown };
      if (r.kind !== 'tool_call' || typeof r.payload !== 'object' || r.payload === null) continue;

      const ts = typeof r.ts === 'string' ? r.ts : undefined;
      if (sinceMs !== undefined && ts !== undefined) {
        const ms = Date.parse(ts);
        if (!Number.isNaN(ms) && ms < sinceMs) continue;
      }

      const p = r.payload as {
        phase?: unknown;
        toolUseId?: unknown;
        name?: unknown;
        isError?: unknown;
      };
      const name = typeof p.name === 'string' && p.name !== '' ? p.name : '<unknown>';
      const phase = p.phase === 'started' || p.phase === 'completed' ? p.phase : undefined;
      if (phase === undefined) continue;

      // Key each call by its toolUseId; fall back to a per-line synthetic key
      // (using seq) when absent so the call is still counted exactly once.
      const id =
        typeof p.toolUseId === 'string' && p.toolUseId !== ''
          ? p.toolUseId
          : `__noid_${typeof r.seq === 'number' ? r.seq : Math.random()}`;

      sawAnyToolCall = true;
      if (ts !== undefined) {
        if (totals.minTs === undefined || ts < totals.minTs) totals.minTs = ts;
        if (totals.maxTs === undefined || ts > totals.maxTs) totals.maxTs = ts;
      }

      const existing = perCall.get(id);
      const state: PerCallState = existing ?? { name, completed: false, isError: false };
      if (existing === undefined) perCall.set(id, state);
      // `completed` carries the authoritative name + error flag.
      if (phase === 'completed') {
        state.name = name;
        state.completed = true;
        state.isError = p.isError === true;
      }
    }
  } finally {
    rl.close();
  }

  // Fold this file's calls into the global tally.
  for (const state of perCall.values()) {
    const stat = stats.get(state.name) ?? emptyStat();
    if (!stats.has(state.name)) stats.set(state.name, stat);
    stat.calls++;
    if (state.isError) stat.errors++;
    if (!state.completed) stat.incomplete++;
  }

  totals.filesScanned++;
  if (!sawAnyToolCall) totals.filesEmpty++;
}

// ─── Output ──────────────────────────────────────────────────────────────────
function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}
function padLeft(s: string, width: number): string {
  return s.length >= width ? s : ' '.repeat(width - s.length) + s;
}

function render(stats: Map<string, ToolStat>, totals: Totals, opts: Options): void {
  const rows = [...stats.entries()].sort((a, b) => {
    if (b[1].calls !== a[1].calls) return b[1].calls - a[1].calls;
    return a[0].localeCompare(b[0]);
  });
  const totalCalls = rows.reduce((sum, [, s]) => sum + s.calls, 0);
  const totalErrors = rows.reduce((sum, [, s]) => sum + s.errors, 0);
  const totalIncomplete = rows.reduce((sum, [, s]) => sum + s.incomplete, 0);

  const shown = opts.top !== undefined ? rows.slice(0, opts.top) : rows;

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          witnessRoot: WITNESS_ROOT,
          filesScanned: totals.filesScanned,
          filesWithNoToolCalls: totals.filesEmpty,
          malformedLines: totals.malformedLines,
          earliestEvent: totals.minTs ?? null,
          latestEvent: totals.maxTs ?? null,
          totalCalls,
          totalErrors,
          totalIncomplete,
          distinctTools: rows.length,
          tools: shown.map(([name, s]) => ({
            name,
            calls: s.calls,
            errors: s.errors,
            incomplete: s.incomplete,
            share: totalCalls > 0 ? Number((s.calls / totalCalls).toFixed(4)) : 0,
          })),
        },
        null,
        2,
      ) + '\n',
    );
    return;
  }

  if (totalCalls === 0) {
    process.stdout.write(`No tool calls found across ${totals.filesScanned} trace file(s).\n`);
    return;
  }

  const nameWidth = Math.max(4, ...shown.map(([n]) => n.length));
  const callsWidth = Math.max(5, ...shown.map(([, s]) => String(s.calls).length));
  const header =
    pad('TOOL', nameWidth) +
    '  ' +
    padLeft('CALLS', callsWidth) +
    '  ' +
    padLeft('ERR', 5) +
    '  ' +
    padLeft('SHARE', 6);
  process.stdout.write(header + '\n');
  process.stdout.write('─'.repeat(header.length) + '\n');
  for (const [name, s] of shown) {
    const share = ((s.calls / totalCalls) * 100).toFixed(1) + '%';
    process.stdout.write(
      pad(name, nameWidth) +
        '  ' +
        padLeft(String(s.calls), callsWidth) +
        '  ' +
        padLeft(String(s.errors), 5) +
        '  ' +
        padLeft(share, 6) +
        '\n',
    );
  }
  process.stdout.write('─'.repeat(header.length) + '\n');
  process.stdout.write(
    pad(`${rows.length} tools`, nameWidth) +
      '  ' +
      padLeft(String(totalCalls), callsWidth) +
      '  ' +
      padLeft(String(totalErrors), 5) +
      '  ' +
      padLeft('100%', 6) +
      '\n',
  );
  if (opts.top !== undefined && rows.length > opts.top) {
    process.stdout.write(`(showing top ${opts.top} of ${rows.length} tools)\n`);
  }

  // Scan summary footer.
  const range =
    totals.minTs !== undefined && totals.maxTs !== undefined
      ? `${totals.minTs} → ${totals.maxTs}`
      : 'n/a';
  process.stdout.write('\n');
  process.stdout.write(
    `Scanned ${totals.filesScanned} trace file(s) ` +
      `(${totals.filesEmpty} with no tool calls), ${totalIncomplete} in-flight/aborted, ` +
      `${totals.malformedLines} malformed line(s).\n`,
  );
  process.stdout.write(`Event range: ${range}\n`);
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const files = discoverTraceFiles(opts);

  const stats = new Map<string, ToolStat>();
  const totals: Totals = {
    filesScanned: 0,
    filesEmpty: 0,
    malformedLines: 0,
    minTs: undefined,
    maxTs: undefined,
  };

  for (const file of files) {
    try {
      await scanFile(file, opts.sinceMs, stats, totals);
    } catch (err) {
      process.stderr.write(`count-tool-calls: skipping ${file}: ${(err as Error).message}\n`);
    }
  }

  render(stats, totals, opts);
}

void main();
