#!/usr/bin/env tsx
/**
 * Measure tool-use rounds per subagent in a session.
 *
 * A "round" is one assistant turn that requested ≥1 tool call — 5 parallel
 * calls in one reply cost 1 round, not 5. This is the unit the subagent
 * budget system uses, and the metric the architect critic identified as the
 * right proxy for "redundant work" in the workspace A/B experiment.
 *
 * Reads a session's witness trace and reports:
 *   - Total tool rounds per subagent (and root)
 *   - Total tool calls per subagent
 *   - Tool breakdown by name per subagent
 *   - Aggregate totals for the session
 *
 * Usage:
 *   tsx scripts/measure-tool-rounds.ts --session <id>
 *   tsx scripts/measure-tool-rounds.ts --latest
 *   tsx scripts/measure-tool-rounds.ts --json
 *
 * @module scripts/measure-tool-rounds
 */

import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

const AFK_HOME = process.env['AFK_HOME'] || join(homedir(), '.afk');
const STATE_DIR = process.env['AFK_STATE_DIR'] || join(AFK_HOME, 'state');
const WITNESS_DIR = join(STATE_DIR, 'witness');

// ─── CLI args ────────────────────────────────────────────────────────────

interface CliArgs {
  session?: string;
  latest: boolean;
  json: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const result: CliArgs = { latest: false, json: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--session' && args[i + 1]) { result.session = args[++i]; }
    else if (arg === '--latest') { result.latest = true; }
    else if (arg === '--json') { result.json = true; }
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: tsx scripts/measure-tool-rounds.ts [--session <id>] [--latest] [--json]');
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  const specified = [result.session, result.latest].filter(Boolean).length;
  if (specified === 0) result.latest = true;
  if (specified > 1) {
    console.error('Specify at most one of --session or --latest.');
    process.exit(2);
  }
  return result;
}

// ─── Trace resolution ────────────────────────────────────────────────────

function resolveTraceFile(args: CliArgs): string {
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
  if (match.length === 0) { console.error(`No session matching: ${args.session}`); process.exit(2); }
  if (match.length > 1) { console.error(`Ambiguous: ${match.map(m => m.name).join(', ')}`); process.exit(2); }
  return match[0]!.tracePath;
}

// ─── Trace parsing ───────────────────────────────────────────────────────

interface ToolCallEvent {
  name: string;
  subagentId: string;
  toolUseId: string;
  seq: number;
  ts: string;
  phase: 'started' | 'completed';
  ok?: boolean;
  durationMs?: number;
}

interface SubagentLifecycle {
  subagentId: string;
  phase: string; // 'started' | 'completed' | 'failed'
  seq: number;
}

async function parseTrace(tracePath: string): Promise<{
  toolCalls: ToolCallEvent[];
  subagentLifecycles: SubagentLifecycle[];
}> {
  const toolCalls: ToolCallEvent[] = [];
  const subagentLifecycles: SubagentLifecycle[] = [];

  const rl = createInterface({ input: createReadStream(tracePath), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let event: { kind: string; payload: Record<string, unknown>; seq: number; ts: string };
    try { event = JSON.parse(line); } catch { continue; }

    if (event.kind === 'tool_call') {
      const p = event.payload;
      toolCalls.push({
        name: p['name'] as string,
        subagentId: (p['subagentId'] as string) ?? 'root',
        toolUseId: p['toolUseId'] as string,
        seq: event.seq,
        ts: event.ts,
        phase: p['phase'] as 'started' | 'completed',
        ok: p['ok'] as boolean | undefined,
        durationMs: p['durationMs'] as number | undefined,
      });
    }

    if (event.kind === 'subagent_lifecycle') {
      const p = event.payload;
      subagentLifecycles.push({
        subagentId: p['id'] as string ?? p['subagentId'] as string ?? 'unknown',
        phase: p['phase'] as string,
        seq: event.seq,
      });
    }
  }

  return { toolCalls, subagentLifecycles };
}

// ─── Analysis ────────────────────────────────────────────────────────────

interface AgentStats {
  agentId: string;
  totalCalls: number;
  totalRounds: number;
  toolBreakdown: Record<string, number>;
  /** Unique toolUseIds seen in 'started' events — each is one call. */
  uniqueCallIds: Set<string>;
}

interface RoundReport {
  tracePath: string;
  agents: Array<{
    agentId: string;
    totalCalls: number;
    totalRounds: number;
    toolBreakdown: Record<string, number>;
  }>;
  totals: {
    agents: number;
    calls: number;
    rounds: number;
  };
  workspacePublishCalls: number;
  workspaceQueryCalls: number;
}

function analyze(toolCalls: ToolCallEvent[], tracePath: string): RoundReport {
  // Group started events by agent
  const agentMap = new Map<string, AgentStats>();

  // Track rounds: a "round" = a group of tool calls with consecutive seqs
  // from the same agent. In practice, tool calls in the same round share
  // the same assistant turn — they have close seq numbers. We approximate
  // rounds by counting unique "batches" of tool_call.started events for
  // each agent, where a batch is a group with seq gaps ≤ 2 (completed
  // events interleave with started events).
  //
  // Simpler approximation: count unique toolUseIds per agent = total calls.
  // Count "rounds" by looking at started events and grouping those with
  // seq numbers within a small window.

  const startedByAgent = new Map<string, number[]>();

  for (const tc of toolCalls) {
    if (tc.phase !== 'started') continue;

    let stats = agentMap.get(tc.subagentId);
    if (!stats) {
      stats = {
        agentId: tc.subagentId,
        totalCalls: 0,
        totalRounds: 0,
        toolBreakdown: {},
        uniqueCallIds: new Set(),
      };
      agentMap.set(tc.subagentId, stats);
    }

    if (!stats.uniqueCallIds.has(tc.toolUseId)) {
      stats.uniqueCallIds.add(tc.toolUseId);
      stats.totalCalls++;
      stats.toolBreakdown[tc.name] = (stats.toolBreakdown[tc.name] ?? 0) + 1;
    }

    // Track seq numbers for round detection
    let seqs = startedByAgent.get(tc.subagentId);
    if (!seqs) { seqs = []; startedByAgent.set(tc.subagentId, seqs); }
    seqs.push(tc.seq);
  }

  // Detect rounds: sort seqs per agent, then group where gap > 3
  // (tool_call.started and tool_call.completed interleave, so parallel
  // calls in one round have seqs like 10,11,12,13,14,15 where odds are
  // started and evens are completed — gap of 2 is normal within a round).
  for (const [agentId, seqs] of startedByAgent) {
    seqs.sort((a, b) => a - b);
    let rounds = 1;
    for (let i = 1; i < seqs.length; i++) {
      // A gap > 5 between consecutive started events means a new round
      // (the model produced a new assistant turn with more tool calls)
      if (seqs[i]! - seqs[i - 1]! > 5) rounds++;
    }
    const stats = agentMap.get(agentId)!;
    stats.totalRounds = rounds;
  }

  // Count workspace tool usage
  let workspacePublishCalls = 0;
  let workspaceQueryCalls = 0;
  for (const tc of toolCalls) {
    if (tc.phase !== 'started') continue;
    if (tc.name === 'workspace_publish') workspacePublishCalls++;
    if (tc.name === 'workspace_query') workspaceQueryCalls++;
  }

  const agents = [...agentMap.values()].map(s => ({
    agentId: s.agentId,
    totalCalls: s.totalCalls,
    totalRounds: s.totalRounds,
    toolBreakdown: s.toolBreakdown,
  }));

  // Sort by seq order (root first, then subagents)
  agents.sort((a, b) => {
    if (a.agentId === 'root') return -1;
    if (b.agentId === 'root') return 1;
    return a.agentId.localeCompare(b.agentId);
  });

  return {
    tracePath,
    agents,
    totals: {
      agents: agents.length,
      calls: agents.reduce((s, a) => s + a.totalCalls, 0),
      rounds: agents.reduce((s, a) => s + a.totalRounds, 0),
    },
    workspacePublishCalls,
    workspaceQueryCalls,
  };
}

// ─── Output ──────────────────────────────────────────────────────────────

function printHuman(report: RoundReport): void {
  console.log(`\n╭─ Tool-Round Report ────────────────────────────────────────╮`);
  console.log(`│  Trace: ${report.tracePath.replace(homedir(), '~')}`);
  console.log(`╰────────────────────────────────────────────────────────────╯\n`);

  console.log(`  Agents:              ${report.totals.agents}`);
  console.log(`  Total tool calls:    ${report.totals.calls}`);
  console.log(`  Total tool rounds:   ${report.totals.rounds}`);
  console.log(`  workspace_publish:   ${report.workspacePublishCalls}`);
  console.log(`  workspace_query:     ${report.workspaceQueryCalls}`);
  console.log();

  for (const a of report.agents) {
    const label = a.agentId === 'root' ? 'root (orchestrator)' : a.agentId;
    console.log(`  ┌─ ${label}`);
    console.log(`  │  Calls: ${a.totalCalls}  Rounds: ${a.totalRounds}`);
    const tools = Object.entries(a.toolBreakdown).sort((x, y) => y[1] - x[1]);
    for (const [name, count] of tools.slice(0, 8)) {
      console.log(`  │    ${name}: ${count}`);
    }
    console.log(`  └──────────────────────`);
  }
  console.log();
}

// ─── Main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();
  const tracePath = resolveTraceFile(args);
  const { toolCalls } = await parseTrace(tracePath);
  const report = analyze(toolCalls, tracePath);

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHuman(report);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
