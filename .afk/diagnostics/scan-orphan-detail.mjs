#!/usr/bin/env node
// Deep-dive on orphans: categorize by id prefix, and for each orphan correlate
// with the tool_call.completed event for that subagent's dispatching tool
// (skill / agent) to see if the PARENT actually got a result and whether it was
// flagged truncated / isError.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const HOME = process.env.AFK_HOME || join(process.env.HOME, '.afk');
const WITNESS = join(HOME, 'state', 'witness');
const dirs = readdirSync(WITNESS).filter((d) => { try { return statSync(join(WITNESS, d)).isDirectory(); } catch { return false; } });

const prefixCounts = {};        // orphan id prefix -> count
const prefixTotal = {};         // ALL subagent id prefix -> count (started)
const orphanSessionsWithClosure = {}; // did orphan session have a closure event? reason dist
// Correlate orphan subagent -> was there a completed tool_call for the dispatching tool in same session?
let orphanWithToolCompleted = 0, orphanWithoutToolCompleted = 0, orphanToolTruncated = 0, orphanToolError = 0;
const sampleTails = [];

function prefixOf(id) {
  // skill-review-1783122486136-1 -> skill-review ; agent-... -> agent ; else first token
  const m = id.match(/^(skill-[a-z-]+?)-\d{6,}/);
  if (m) return m[1];
  const m2 = id.match(/^([a-z]+)[-_]/i);
  return m2 ? m2[1] : id;
}

for (const d of dirs) {
  const f = join(WITNESS, d, 'trace.jsonl');
  if (!existsSync(f)) continue;
  let lines;
  try { lines = readFileSync(f, 'utf8').split('\n').filter(Boolean); } catch { continue; }

  const sub = new Map();
  const toolCompletedBySub = new Map(); // subagentId -> {truncated,isError,resultBytes}
  let closureReason = null;
  const evs = [];
  for (const line of lines) { let ev; try { ev = JSON.parse(line); } catch { continue; } evs.push(ev);
    if (ev.kind === 'subagent_lifecycle') {
      const p = ev.payload, id = p.subagentId;
      if (!sub.has(id)) sub.set(id, { started:false, terminal:null });
      const s = sub.get(id);
      if (p.transition === 'started') s.started = true; else s.terminal = p.transition;
    } else if (ev.kind === 'tool_call' && ev.payload.phase === 'completed' && ev.payload.subagentId) {
      toolCompletedBySub.set(ev.payload.subagentId, { truncated: ev.payload.truncated, isError: ev.payload.isError, resultBytes: ev.payload.resultBytes });
    } else if (ev.kind === 'closure') closureReason = ev.payload.reason;
  }

  for (const [id, s] of sub) {
    if (!s.started) continue;
    const pfx = prefixOf(id);
    prefixTotal[pfx] = (prefixTotal[pfx] || 0) + 1;
    if (!s.terminal) {
      prefixCounts[pfx] = (prefixCounts[pfx] || 0) + 1;
      orphanSessionsWithClosure[closureReason || 'NO_CLOSURE'] = (orphanSessionsWithClosure[closureReason || 'NO_CLOSURE'] || 0) + 1;
      const tc = toolCompletedBySub.get(id);
      if (tc) { orphanWithToolCompleted++; if (tc.truncated) orphanToolTruncated++; if (tc.isError) orphanToolError++; }
      else orphanWithoutToolCompleted++;
      if (sampleTails.length < 4) {
        // capture last 6 events mentioning this subagent id or lifecycle/closure
        const rel = evs.filter(e => JSON.stringify(e).includes(id) || e.kind==='closure' || e.kind==='session_sealed').slice(-8);
        sampleTails.push({ session: d, id, hasToolCompleted: !!tc, toolCompleted: tc, tail: rel });
      }
    }
  }
}

console.log('=== ORPHAN COUNT by id prefix (orphans / total-started) ===');
const rows = Object.keys(prefixTotal).map(k => ({ prefix:k, orphans: prefixCounts[k]||0, total: prefixTotal[k], pct: (((prefixCounts[k]||0)/prefixTotal[k])*100).toFixed(0)+'%' }))
  .sort((a,b)=> b.orphans - a.orphans);
console.table(rows);

console.log('\n=== ORPHAN sessions: closure reason distribution ===');
console.log(JSON.stringify(orphanSessionsWithClosure, null, 2));

console.log('\n=== ORPHAN <-> dispatching tool_call.completed correlation ===');
console.log(JSON.stringify({ orphanWithToolCompleted, orphanWithoutToolCompleted, orphanToolTruncated, orphanToolError }, null, 2));

console.log('\n=== SAMPLE ORPHAN TAILS ===');
console.log(JSON.stringify(sampleTails, null, 2));
