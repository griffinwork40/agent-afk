#!/usr/bin/env tsx
/**
 * Measure `read_file` deduplication across sibling subagents in a session.
 *
 * Thin CLI entry point. Analysis logic lives in
 * `scripts/workspace-ab/analyze-read-dedup.ts` (tested).
 *
 * Usage:
 *   tsx scripts/measure-read-dedup.ts --session <id>   # one session
 *   tsx scripts/measure-read-dedup.ts --file <path>     # one trace.jsonl
 *   tsx scripts/measure-read-dedup.ts --latest           # most recent session
 *   tsx scripts/measure-read-dedup.ts --json             # machine-readable
 *   tsx scripts/measure-read-dedup.ts --all-tools        # measure ALL tools
 *
 * Exit codes: 0 on success, 2 on bad arguments.
 *
 * @module scripts/measure-read-dedup
 */

import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { analyze, validate } from './workspace-ab/analyze-read-dedup.js';
import type { ToolCallStarted } from './workspace-ab/types.js';
import type { DedupReport } from './workspace-ab/types.js';

// ─── AFK_HOME resolution ─────────────────────────────────────────────────────
const AFK_HOME = process.env['AFK_HOME'] || join(homedir(), '.afk');
const STATE_DIR = process.env['AFK_STATE_DIR'] || join(AFK_HOME, 'state');
const WITNESS_DIR = join(STATE_DIR, 'witness');

// ─── CLI args ────────────────────────────────────────────────────────────────

interface CliArgs {
  file?: string;
  session?: string;
  latest: boolean;
  json: boolean;
  allTools: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const result: CliArgs = { latest: false, json: false, allTools: false };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--file' && args[i + 1]) {
      result.file = args[++i];
    } else if (arg === '--session' && args[i + 1]) {
      result.session = args[++i];
    } else if (arg === '--latest') {
      result.latest = true;
    } else if (arg === '--json') {
      result.json = true;
    } else if (arg === '--all-tools') {
      result.allTools = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: tsx scripts/measure-read-dedup.ts [--session <id>] [--file <path>] [--latest] [--json] [--all-tools]`);
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }

  const specified = [result.file, result.session, result.latest].filter(Boolean).length;
  if (specified === 0) result.latest = true;
  if (specified > 1) {
    console.error('Specify at most one of --file, --session, or --latest.');
    process.exit(2);
  }
  return result;
}

// ─── Trace resolution ────────────────────────────────────────────────────────

function resolveTraceFile(args: CliArgs): string {
  if (args.file) {
    const p = isAbsolute(args.file) ? args.file : join(process.cwd(), args.file);
    if (!existsSync(p)) { console.error(`File not found: ${p}`); process.exit(2); }
    return p;
  }

  if (!existsSync(WITNESS_DIR)) {
    console.error(`Witness directory not found: ${WITNESS_DIR}`);
    process.exit(2);
  }

  const sessions = readdirSync(WITNESS_DIR)
    .filter(d => existsSync(join(WITNESS_DIR, d, 'trace.jsonl')))
    .map(d => ({
      name: d,
      tracePath: join(WITNESS_DIR, d, 'trace.jsonl'),
      mtime: statSync(join(WITNESS_DIR, d, 'trace.jsonl')).mtime.getTime(),
    }))
    .sort((a, b) => b.mtime - a.mtime);

  if (sessions.length === 0) {
    console.error('No sessions with traces found.');
    process.exit(2);
  }

  if (args.latest) return sessions[0]!.tracePath;

  const match = sessions.filter(s => s.name.startsWith(args.session!));
  if (match.length === 0) {
    console.error(`No session matching prefix: ${args.session}`);
    process.exit(2);
  }
  if (match.length > 1) {
    console.error(`Ambiguous session prefix "${args.session}" -- matches: ${match.map(m => m.name).join(', ')}`);
    process.exit(2);
  }
  return match[0]!.tracePath;
}

// ─── Trace parsing ──────────────────────────────────────────────────────────

async function parseTrace(tracePath: string, allTools: boolean): Promise<{
  calls: ToolCallStarted[];
  skippedNoFingerprint: number;
  totalToolCallStarted: number;
  hasValidClosure: boolean;
  childFailureRate: number;
}> {
  const calls: ToolCallStarted[] = [];
  let skippedNoFingerprint = 0;
  let totalToolCallStarted = 0;

  // Subagent lifecycle counters for childFailureRate.
  let subagentSucceeded = 0;
  let subagentFailed = 0;
  let subagentCancelled = 0;

  // Whether the trace includes at least one successful (non-error) closure.
  let hasValidClosure = false;

  const rl = createInterface({ input: createReadStream(tracePath), crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let event: { kind: string; payload: Record<string, unknown>; seq: number; ts: string };
    try { event = JSON.parse(line); } catch { continue; }

    if (event.kind === 'closure') {
      // A closure whose reason is not 'budget_exceeded' / 'aborted' counts as
      // valid.  The closure.payload.reason field is the authoritative signal.
      const reason = event.payload['reason'] as string | undefined;
      if (reason !== 'aborted' && reason !== 'budget_exceeded') hasValidClosure = true;
      continue;
    }

    if (event.kind === 'subagent_lifecycle') {
      const transition = event.payload['transition'] as string | undefined;
      if (transition === 'succeeded') subagentSucceeded++;
      else if (transition === 'failed') subagentFailed++;
      else if (transition === 'cancelled') subagentCancelled++;
      continue;
    }

    if (event.kind !== 'tool_call') continue;
    const p = event.payload;
    if (p['phase'] !== 'started') continue;

    totalToolCallStarted++;

    const name = p['name'] as string;
    if (!allTools && name !== 'read_file') continue;

    const fp = p['argsFingerprint'] as string | undefined;
    if (!fp) { skippedNoFingerprint++; continue; }

    calls.push({
      name,
      argsFingerprint: fp,
      resourceFingerprint: p['resourceFingerprint'] as string | undefined,
      subagentId: (p['subagentId'] as string) ?? 'root',
      toolUseId: p['toolUseId'] as string,
      seq: event.seq,
      ts: event.ts,
    });
  }

  const totalTerminal = subagentSucceeded + subagentFailed + subagentCancelled;
  const childFailureRate =
    totalTerminal > 0 ? (subagentFailed + subagentCancelled) / totalTerminal : 0;

  return { calls, skippedNoFingerprint, totalToolCallStarted, hasValidClosure, childFailureRate };
}

// ─── Output ─────────────────────────────────────────────────────────────────

function printHuman(report: DedupReport): void {
  console.log(`\n╭─ Read Deduplication Report ────────────────────────────────╮`);
  console.log(`│  Trace: ${report.tracePath}`);
  console.log(`│  Filter: ${report.toolFilter}`);
  console.log(`│  Agents: ${report.distinctAgents}`);
  console.log(`╰────────────────────────────────────────────────────────────╯\n`);

  if (report.skippedNoFingerprint > 0) {
    console.log(`⚠  ${report.skippedNoFingerprint} ${report.toolFilter} events lacked argsFingerprint (pre-upgrade trace)\n`);
  }

  console.log(`  Total calls:              ${report.totalCalls}`);
  console.log(`  Unique fingerprints:      ${report.uniqueFingerprints}`);
  console.log(`  Cross-agent duplicates:   ${report.crossAgentDuplicates}  (sibling read same args)`);
  console.log(`  Self-duplicates:          ${report.selfDuplicates}  (same agent repeated)`);
  console.log(`  Cross-agent dedup ratio:  ${(report.crossAgentDedupRatio * 100).toFixed(1)}%`);
  if (report.crossAgentFileOverlapRatio !== null) {
    console.log(`  File-level overlap ratio: ${(report.crossAgentFileOverlapRatio * 100).toFixed(1)}%  (resource fingerprint)`);
  }
  console.log();

  if (report.hotFingerprints.length > 0) {
    console.log(`  Cross-agent hot reads (fingerprint → agent count × total calls):`);
    for (const h of report.hotFingerprints.filter(f => f.agentCount > 1).slice(0, 10)) {
      console.log(`    ${h.fingerprint}…  ${h.toolName}  ${h.agentCount} agents × ${h.totalCalls} calls`);
    }
    console.log();
  }

  if (report.totalCalls === 0 && report.totalToolCallStarted > 0) {
    console.log(`  (${report.totalToolCallStarted} total tool_call.started events in trace, but none matched the filter.)`);
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();
  const tracePath = resolveTraceFile(args);
  const { calls, skippedNoFingerprint, totalToolCallStarted, hasValidClosure, childFailureRate } =
    await parseTrace(tracePath, args.allTools);
  const report = analyze({ calls, tracePath, allTools: args.allTools, skippedNoFingerprint, totalToolCallStarted });
  const validationOpts = { hasValidClosure, childFailureRate };

  if (args.json) {
    const validation = validate(report, validationOpts);
    console.log(JSON.stringify({ ...report, validation }, null, 2));
  } else {
    printHuman(report);
    const validation = validate(report, validationOpts);
    if (!validation.valid) {
      console.log('  ⚠ Validation failures:');
      for (const f of validation.failures) {
        console.log(`    - [${f.rule}] ${f.message}`);
      }
      console.log();
    }
  }
}

main().catch(err => { console.error(err); process.exit(1); });
