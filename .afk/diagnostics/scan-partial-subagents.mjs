#!/usr/bin/env node
// One-shot forensic scanner: find instances of "partial subagent results"
// across every witness trace under $AFK_HOME/state/witness/<sid>/trace.jsonl.
//
// Signatures scanned:
//  A. ORPHAN            — subagent_lifecycle 'started' with NO terminal for that subagentId
//  B. FAILED_PARTIAL    — transition 'failed' with partialOutputBytes > 0
//  C. FAILED_ANY        — transition 'failed' (all, grouped by errorClass)
//  D. SUCCEEDED_TINY    — transition 'succeeded' with outputBytes < 200
//  E. BG_ORPHAN         — background_agent 'started' with no completed/failed/cancelled
//  F. CANCELLED         — transition 'cancelled' (by source)
//  Also: was the SESSION sealed? incomplete seal? seal status?

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const HOME = process.env.AFK_HOME || join(process.env.HOME, '.afk');
const WITNESS = join(HOME, 'state', 'witness');

const dirs = readdirSync(WITNESS).filter((d) => {
  try { return statSync(join(WITNESS, d)).isDirectory(); } catch { return false; }
});

const stats = {
  totalTraces: 0,
  tracesWithSubagents: 0,
  totalSubagents: 0,
  orphans: 0,
  failedPartial: 0,
  failedAny: 0,
  succeededTiny: 0,
  bgStarted: 0,
  bgOrphan: 0,
  cancelled: 0,
  sealed: 0,
  incompleteSeal: 0,
};

const errorClassCounts = {};
const orphanExamples = [];
const failedPartialExamples = [];
const tinyExamples = [];
const bgOrphanExamples = [];

for (const d of dirs) {
  const f = join(WITNESS, d, 'trace.jsonl');
  if (!existsSync(f)) continue;
  let lines;
  try { lines = readFileSync(f, 'utf8').split('\n').filter(Boolean); } catch { continue; }
  stats.totalTraces++;

  // Per-subagent state
  const sub = new Map();  // subagentId -> { started, terminal, model, outputBytes, errorClass, errorMessage, partialOutputBytes, cancelSource }
  const bg = new Map();   // jobId -> { started, terminal }
  let sealed = null;

  for (const line of lines) {
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.kind === 'subagent_lifecycle') {
      const p = ev.payload;
      const id = p.subagentId;
      if (!sub.has(id)) sub.set(id, { started: false, terminal: null });
      const s = sub.get(id);
      if (p.transition === 'started') { s.started = true; s.model = p.model; s.startTs = ev.ts; }
      else { s.terminal = p.transition; s.termTs = ev.ts;
        if (p.transition === 'succeeded') s.outputBytes = p.outputBytes;
        if (p.transition === 'failed') { s.errorClass = p.errorClass; s.errorMessage = p.errorMessage; s.partialOutputBytes = p.partialOutputBytes; }
        if (p.transition === 'cancelled') s.cancelSource = p.source;
      }
    } else if (ev.kind === 'background_agent') {
      const p = ev.payload;
      const id = p.jobId;
      if (!bg.has(id)) bg.set(id, { started: false, terminal: null });
      const b = bg.get(id);
      if (p.transition === 'started') b.started = true;
      else if (['completed', 'failed', 'cancelled'].includes(p.transition)) b.terminal = p.transition;
      else if (['joined', 'delivered'].includes(p.transition)) b.joinedOnly = p.transition;
    } else if (ev.kind === 'session_sealed') {
      sealed = ev.payload;
    }
  }

  if (sub.size > 0) stats.tracesWithSubagents++;
  if (sealed) { stats.sealed++; if (sealed.incomplete) stats.incompleteSeal++; }

  for (const [id, s] of sub) {
    if (!s.started) continue; // only count things that actually started
    stats.totalSubagents++;
    if (!s.terminal) {
      stats.orphans++;
      if (orphanExamples.length < 25) orphanExamples.push({ session: d, id, model: s.model, startTs: s.startTs, sealed: sealed ? sealed.status : 'NO_SEAL', incomplete: sealed?.incomplete || false });
    } else if (s.terminal === 'failed') {
      stats.failedAny++;
      errorClassCounts[s.errorClass] = (errorClassCounts[s.errorClass] || 0) + 1;
      if (s.partialOutputBytes > 0) {
        stats.failedPartial++;
        if (failedPartialExamples.length < 25) failedPartialExamples.push({ session: d, id, errorClass: s.errorClass, errorMessage: (s.errorMessage||'').slice(0,120), partialOutputBytes: s.partialOutputBytes });
      }
    } else if (s.terminal === 'succeeded') {
      if (s.outputBytes < 200) {
        stats.succeededTiny++;
        if (tinyExamples.length < 20) tinyExamples.push({ session: d, id, outputBytes: s.outputBytes, model: s.model });
      }
    } else if (s.terminal === 'cancelled') {
      stats.cancelled++;
    }
  }

  for (const [id, b] of bg) {
    if (!b.started) continue;
    stats.bgStarted++;
    if (!b.terminal) {
      stats.bgOrphan++;
      if (bgOrphanExamples.length < 15) bgOrphanExamples.push({ session: d, id, joinedOnly: b.joinedOnly || null });
    }
  }
}

console.log('=== AGGREGATE ===');
console.log(JSON.stringify(stats, null, 2));
console.log('\n=== FAILED errorClass distribution ===');
console.log(JSON.stringify(Object.fromEntries(Object.entries(errorClassCounts).sort((a,b)=>b[1]-a[1])), null, 2));
console.log('\n=== ORPHAN examples (started, no terminal) ===');
console.log(JSON.stringify(orphanExamples, null, 2));
console.log('\n=== FAILED_PARTIAL examples (failed with partialOutputBytes>0) ===');
console.log(JSON.stringify(failedPartialExamples, null, 2));
console.log('\n=== SUCCEEDED_TINY examples (outputBytes<200) ===');
console.log(JSON.stringify(tinyExamples, null, 2));
console.log('\n=== BG_ORPHAN examples ===');
console.log(JSON.stringify(bgOrphanExamples, null, 2));
