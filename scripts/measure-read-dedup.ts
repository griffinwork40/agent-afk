#!/usr/bin/env tsx
/**
 * Measure `read_file` deduplication across sibling subagents in a session.
 *
 * Reads a root session's witness trace, groups `read_file` tool calls by
 * `argsFingerprint` (SHA-256 of the serialized tool input — file path + offset
 * + limit), and reports how many distinct subagents read the same file with the
 * same arguments.
 *
 * The primary metric is the **deduplication ratio**: what fraction of all
 * `read_file` calls are redundant (i.e. read identical args already read by a
 * sibling). A ratio of 0% means no overlap; 59% was the empirical baseline
 * before the shared workspace feature.
 *
 * Traces live at $AFK_HOME/state/witness/<sessionLabel>/trace.jsonl
 * (default ~/.afk/state/witness/...). Each line is { ts, seq, kind, payload }.
 *
 * Usage:
 *   tsx scripts/measure-read-dedup.ts --session <id>   # one session
 *   tsx scripts/measure-read-dedup.ts --file <path>     # one trace.jsonl
 *   tsx scripts/measure-read-dedup.ts --latest           # most recent session
 *   tsx scripts/measure-read-dedup.ts --json             # machine-readable
 *   tsx scripts/measure-read-dedup.ts --all-tools        # measure ALL tools, not just read_file
 *
 * Requires the `argsFingerprint` field on `tool_call.started` events. Traces
 * recorded before that field was added will show 0 reads (the events are
 * skipped with a warning).
 *
 * Exit codes: 0 on success, 2 on bad arguments.
 *
 * @module scripts/measure-read-dedup
 */

import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

// ─── AFK_HOME resolution ─────────────────────────────────────────────────────
// Mirrors getAfkHome() in src/paths.ts. Resolved inline (not imported) so this
// script runs without building.
const AFK_HOME = process.env['AFK_HOME'] || join(homedir(), '.afk');
const WITNESS_DIR = join(AFK_HOME, 'state', 'witness');

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
  if (specified === 0) result.latest = true; // default to --latest
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
    .filter(d => {
      const full = join(WITNESS_DIR, d, 'trace.jsonl');
      return existsSync(full);
    })
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

  // --session: prefix match
  const match = sessions.filter(s => s.name.startsWith(args.session!));
  if (match.length === 0) {
    console.error(`No session matching prefix: ${args.session}`);
    process.exit(2);
  }
  if (match.length > 1) {
    console.error(`Ambiguous session prefix "${args.session}" — matches: ${match.map(m => m.name).join(', ')}`);
    process.exit(2);
  }
  return match[0]!.tracePath;
}

// ─── Trace parsing ───────────────────────────────────────────────────────────

interface ToolCallStarted {
  name: string;
  argsFingerprint: string;
  subagentId: string; // 'root' for top-level session
  toolUseId: string;
  seq: number;
  ts: string;
}

async function parseTrace(tracePath: string, allTools: boolean): Promise<{
  calls: ToolCallStarted[];
  skippedNoFingerprint: number;
  totalToolCallStarted: number;
}> {
  const calls: ToolCallStarted[] = [];
  let skippedNoFingerprint = 0;
  let totalToolCallStarted = 0;

  const rl = createInterface({ input: createReadStream(tracePath), crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let event: { kind: string; payload: Record<string, unknown>; seq: number; ts: string };
    try { event = JSON.parse(line); } catch { continue; }

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
      subagentId: (p['subagentId'] as string) ?? 'root',
      toolUseId: p['toolUseId'] as string,
      seq: event.seq,
      ts: event.ts,
    });
  }

  return { calls, skippedNoFingerprint, totalToolCallStarted };
}

// ─── Analysis ────────────────────────────────────────────────────────────────

interface FingerprintGroup {
  fingerprint: string;
  toolName: string;
  agents: Set<string>;
  totalCalls: number;
  callDetails: Array<{ subagentId: string; seq: number; ts: string }>;
}

interface DedupReport {
  tracePath: string;
  toolFilter: string;
  totalCalls: number;
  uniqueFingerprints: number;
  duplicatedCalls: number;
  deduplicationRatio: number;
  distinctAgents: number;
  /** Fingerprints read by >1 agent, sorted by total calls descending. */
  hotFingerprints: Array<{
    fingerprint: string;
    toolName: string;
    agentCount: number;
    totalCalls: number;
    agents: string[];
  }>;
  skippedNoFingerprint: number;
  totalToolCallStarted: number;
}

function analyze(
  calls: ToolCallStarted[],
  tracePath: string,
  allTools: boolean,
  skippedNoFingerprint: number,
  totalToolCallStarted: number,
): DedupReport {
  // Group by argsFingerprint
  const groups = new Map<string, FingerprintGroup>();
  const allAgents = new Set<string>();

  for (const c of calls) {
    allAgents.add(c.subagentId);
    let g = groups.get(c.argsFingerprint);
    if (!g) {
      g = {
        fingerprint: c.argsFingerprint,
        toolName: c.name,
        agents: new Set(),
        totalCalls: 0,
        callDetails: [],
      };
      groups.set(c.argsFingerprint, g);
    }
    g.agents.add(c.subagentId);
    g.totalCalls++;
    g.callDetails.push({ subagentId: c.subagentId, seq: c.seq, ts: c.ts });
  }

  // A call is "duplicated" if its fingerprint was seen by >1 distinct agent.
  // The first occurrence per fingerprint is the "unique" read; every subsequent
  // call with the same fingerprint from a different agent is redundant.
  let duplicatedCalls = 0;
  const hotFingerprints: DedupReport['hotFingerprints'] = [];

  for (const g of groups.values()) {
    if (g.agents.size > 1) {
      // All calls beyond one-per-unique-agent are duplicates.
      // Simple metric: totalCalls - 1 = redundant (the first was needed).
      duplicatedCalls += g.totalCalls - 1;
      hotFingerprints.push({
        fingerprint: g.fingerprint.slice(0, 16),
        toolName: g.toolName,
        agentCount: g.agents.size,
        totalCalls: g.totalCalls,
        agents: [...g.agents],
      });
    } else if (g.totalCalls > 1) {
      // Same agent, same args — still redundant (self-dedup).
      duplicatedCalls += g.totalCalls - 1;
    }
  }

  hotFingerprints.sort((a, b) => b.totalCalls - a.totalCalls);

  const totalCalls = calls.length;
  const deduplicationRatio = totalCalls > 0 ? duplicatedCalls / totalCalls : 0;

  return {
    tracePath,
    toolFilter: allTools ? 'all tools' : 'read_file only',
    totalCalls,
    uniqueFingerprints: groups.size,
    duplicatedCalls,
    deduplicationRatio,
    distinctAgents: allAgents.size,
    hotFingerprints: hotFingerprints.slice(0, 20),
    skippedNoFingerprint,
    totalToolCallStarted,
  };
}

// ─── Output ──────────────────────────────────────────────────────────────────

function printHuman(report: DedupReport): void {
  console.log(`\n╭─ Read Deduplication Report ────────────────────────────────╮`);
  console.log(`│  Trace: ${report.tracePath}`);
  console.log(`│  Filter: ${report.toolFilter}`);
  console.log(`│  Agents: ${report.distinctAgents}`);
  console.log(`╰────────────────────────────────────────────────────────────╯\n`);

  if (report.skippedNoFingerprint > 0) {
    console.log(`⚠  ${report.skippedNoFingerprint} tool_call events lacked argsFingerprint (pre-upgrade trace)\n`);
  }

  console.log(`  Total calls:           ${report.totalCalls}`);
  console.log(`  Unique fingerprints:   ${report.uniqueFingerprints}`);
  console.log(`  Duplicated calls:      ${report.duplicatedCalls}`);
  console.log(`  Deduplication ratio:   ${(report.deduplicationRatio * 100).toFixed(1)}%`);
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

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();
  const tracePath = resolveTraceFile(args);
  const { calls, skippedNoFingerprint, totalToolCallStarted } = await parseTrace(tracePath, args.allTools);
  const report = analyze(calls, tracePath, args.allTools, skippedNoFingerprint, totalToolCallStarted);

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHuman(report);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
