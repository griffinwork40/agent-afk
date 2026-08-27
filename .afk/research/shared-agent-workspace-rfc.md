# RFC: Shared Agent Workspace

*2026-08-18 — Draft*

## Problem

AFK's agents can exchange results through parent orchestration and compose DAG dependencies, but do not inhabit a persistent shared working state within a session. This causes:

1. **Repeated rediscovery** — Agent B re-reads files Agent A already analyzed
2. **Lossy knowledge transfer** — parent compresses Agent A's findings into a prompt for Agent B; nuance is lost
3. **Serial bottleneck** — the parent context window is the only channel between agents; parallel agents can't share mid-run
4. **No contradiction detection** — when Agent B discovers something that invalidates Agent A's finding, no mechanism surfaces the conflict

AFK has message passing (parent→child) and directed dataflow (compose DAG). It does not have environment-mediated cognition (shared mutable state agents read/write concurrently).

## Non-Goals (for v1)

- Replacing the witness trace or memory system
- Event sourcing, temporal forks, or deterministic replay
- Graph database, graph traversal, or causal path queries
- Agent identity, trust scores, or performance history
- Reactive behaviors (state changes waking agents)
- A2A, cross-system interop
- Any of the "six PhDs hiding in a trench coat"

## Proposal: Epistemic Workspace

A per-session typed scratchpad that any agent in the session can publish to and query from.

### Entry Types

```
Finding     — "I observed X in file Y"
Evidence    — "Lines 141-177 of src/auth.ts show Z"
Hypothesis  — "The race condition is caused by W"
Decision    — "We should use approach V because U"
Artifact    — "Wrote fix to src/auth.ts:150"
Status      — "Test suite passes / fails"
```

### Publish API (agent-facing)

```
workspace.publish({
  type: "finding",
  subject: "auth refresh",
  content: "refreshSession() has a race condition between token rotation and persistence",
  evidence: ["src/auth.ts:141-177"],
  confidence: 0.91,
  agent: "<auto-filled from session>"
})
```

### Query API (harness-facing)

When AFK forks an agent, it constructs a workspace context packet:

```
Relevant workspace state:
  #12 Finding (agent: researcher-A, confidence: 0.91)
      Auth refresh may race between rotation and persistence
      Evidence: src/auth.ts:141-177
  #18 Hypothesis (agent: researcher-B, confidence: 0.76)
      Database transaction ordering, not token rotation, is the root cause
  #22 Contradiction (agent: researcher-B → #12)
      Test pollution may explain the failure researcher-A attributed to a race condition
```

### The Hard Problem: Routing

The publish side is simple. The query side — deciding which workspace entries are "relevant" when constructing context for a new agent — is where the real work lives. This is causal context routing: not "find similar text" but "find entries structurally relevant to this agent's task."

**v1 approach:** Dumb but honest. Include all workspace entries for the current session (sessions rarely exceed 50 entries). Filter by `subject` keyword overlap with the agent's task prompt. Prefix with recency.

**Later:** Replace keyword overlap with provenance-aware retrieval — traverse `supports`, `contradicts`, `depends_on` edges to surface structurally relevant entries even when keywords don't match.

### Storage

SQLite. Same database pattern as the memory system. Per-session table, not shared across sessions (cross-session is what memory is for).

```sql
CREATE TABLE workspace_entries (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL,        -- finding | evidence | hypothesis | decision | artifact | status
  subject TEXT,
  content TEXT NOT NULL,
  evidence TEXT,             -- JSON array of file:line references
  confidence REAL DEFAULT 1.0,
  agent_id TEXT,
  relates_to TEXT,           -- JSON array of entry IDs this supports/contradicts/depends-on
  relation_type TEXT,        -- supports | contradicts | depends_on | caused | supersedes
  created_at TEXT NOT NULL,
  seq INTEGER NOT NULL       -- monotonic within session, for ordering
);
```

### Integration Points

| System | Integration |
|--------|-------------|
| **SubagentManager** | On fork: query workspace, inject relevant entries as preamble. On child completion: auto-publish child's final findings to workspace. |
| **Compose DAG** | Node outputs auto-published as workspace entries. Downstream nodes see upstream entries via workspace, not just via `inputs`. |
| **Witness Trace** | Workspace publishes emit a trace event (new kind: `workspace_publish`). Workspace is queryable independently of trace. |
| **Memory** | Workspace entries that survive a session can be promoted to cross-session memory facts on session end. |
| **Hooks** | Future: `PostWorkspacePublish` hook for contradiction detection. Not in v1. |

## Validation: The Experiment

Run the same multi-agent task under two conditions:

### Control: Current AFK
```
parent
├── researcher A
├── researcher B
├── implementer
└── verifier
```

### Treatment: Workspace AFK
Same agents, same models, same task. Each reads/writes a shared workspace.

### Measurements
| Metric | How to Measure |
|--------|----------------|
| Duplicate file reads | Count distinct file:line reads across agents vs. total reads (from trace `tool_call` events) |
| Repeated discoveries | Manual inspection: did Agent B discover something Agent A already found? |
| Contradictory findings | Manual: did agents produce conflicting conclusions without surfacing the conflict? |
| Parent context tokens | Token count of parent's conversation history (from trace `budget` events) |
| Total tokens | Sum across all agents |
| Total tool calls | Count from trace |
| Wall-clock time | Session duration |
| Task completion | Did the task succeed? Quality of result? |
| 429 rate | Count of rate-limit errors across agents |

### Success Criteria
Workspace AFK produces:
- Less rediscovery (fewer duplicate reads)
- Less parent-context load (fewer tokens in parent)
- Better cross-agent consistency (fewer undetected contradictions)
- Equal or better task completion

If it doesn't, kill it.

### Measurement Caveat
"Duplicate reads" and "repeated discoveries" aren't automatically measurable from traces today. The experiment needs either manual inspection or a trace analysis tool that detects semantic duplication across subagent tool calls. Designing a fair experiment takes real thought — don't underestimate this.

## Build Order

1. **Shared typed workspace** — Agents publish structured findings; other agents query. Boring SQLite. Don't replace memory or witness.
2. **Automatic context routing** — When AFK forks, construct a workspace packet instead of forcing the parent to summarize. This is the first real "wormhole."
3. **Provenance links** — `Finding 18 supports Decision 27`; `Observation 31 contradicts Finding 18`.
4. **Invalidation** — If Finding 18 dies, surface Decision 27 and downstream artifacts as potentially stale. This is where shared state produces behavior you couldn't get cheaply before.
5. **Reactivity** — Only then consider state changes waking agents.
6. **Everything else** — Temporal forks, agent identity, trust, A2A. Only if usage pulls AFK there.

Let usage pull AFK toward the cognitive-substrate architecture. Don't push.

## Relationship to Existing Systems

- **This is NOT a replacement for the witness trace.** The trace is forensic ("what happened"). The workspace is operational ("what do we currently believe").
- **This is NOT a replacement for cross-session memory.** Memory is long-term. The workspace is per-session working state. Entries can be promoted to memory at session end.
- **This IS a new primitive** alongside trace, memory, and compose — filling the gap where within-session shared state should be.

## Open Questions

1. **Workspace scope:** Per root-session? Per compose DAG? Per explicit workspace ID? (Per root-session is simplest.)
2. **Auto-publish:** Should child agent findings auto-publish on completion, or should agents explicitly publish? (Start explicit, add auto-publish later.)
3. **Context budget:** If the workspace has 200 entries, how much context budget does the packet consume? Is there a compression strategy? (Start with "include all, filter by subject keyword.")
4. **Contradiction detection:** Is it the workspace's job to detect contradictions, or the agents'? (v1: agents'. v2: workspace surfaces potential contradictions.)
5. **Workspace tool:** Should agents get a `workspace_publish` / `workspace_query` tool, or should this be harness-level (invisible to the model)? (Both have tradeoffs — explicit tools let agents be intentional; harness-level reduces tool-call overhead.)

---

*Evidence base: `epistemic-world-graph-research-brief.md`*
*Origin: ChatGPT conversation (2026-08-18) → AFK research wave → adversarial review → synthesis*
