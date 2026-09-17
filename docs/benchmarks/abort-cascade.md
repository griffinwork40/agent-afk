# Abort-Cascade Correctness

**Benchmark ID:** abort-cascade-v1
**Status:** Initial results published
**Date:** 2026-09-17
**Contract ref:** `docs/philosophy/afk-contract.md` -- "Ignoring an abort signal mid-dispatch is impossible by construction."

---

## What is being tested

The AFK Contract makes two hard claims about the `AbortGraph`:

1. **Parent abort cascades to ALL descendants.** Aborting a root node must
   synchronously abort every child, grandchild, and deeper descendant, threading
   the same reason through the entire tree.

2. **Child abort does NOT auto-abort the parent.** A child may fail independently;
   the parent receives a notification but its own controller stays live.

These properties are load-bearing for unattended operation. If a cascade fails to
reach a descendant, that subagent runs unsupervised after the operator cancelled.
If a child abort kills the parent, a single subagent failure takes down the entire
session.

The witness layer must faithfully record cascade topology: each root abort emits a
single `abort` trace event whose `cascadedTo[]` field lists every descendant the
BFS traversal reached, before any controller fires.

---

## Test methodology

Each scenario spawns an isolated child process (via `tsx`) that:

1. Constructs an `AbortGraph` with a `NdjsonTraceWriter`
2. Builds a specific tree topology (registers nodes, links parent-child edges)
3. Triggers an abort on a target node
4. Waits for the async trace write to flush
5. Writes a verification `tool_call` event recording each controller's signal state
6. Seals the trace and exits

The parent reads back the NDJSON trace file and verifies:
- The `abort` event's `cascadedTo[]` matches the expected descendant set
- Every descendant's `AbortController.signal.aborted` is `true`
- The abort reason is threaded to every level
- The parent is NOT aborted when only a child is aborted (Scenario D)

| Scenario | Topology | Abort target | Expected cascadedTo |
|---|---|---|---|
| `linear-chain` | root -> child -> grandchild | root | [child, grandchild] |
| `wide-fan-out` | root -> 5 children | root | [c0, c1, c2, c3, c4] |
| `deep-5-level` | root -> L1 -> L2 -> L3 -> L4 | root | [L1, L2, L3, L4] |
| `child-only` | root -> child | child | [] (no descendants) |
| `mixed-tree` | root -> 2 children -> 2 grandchildren each | root | [cA, cB, gA1, gA2, gB1, gB2] |

---

## Success criteria

| Metric | Target | Notes |
|---|---|---|
| Cascade completeness | 100% | Every descendant must appear in `cascadedTo[]` and have `signal.aborted === true` |
| Reason threading | 100% | Every descendant must receive the root's abort reason |
| Upward isolation | 0 leaks | Child abort must never set parent `signal.aborted` |
| Trace fidelity | 1 abort event per trigger | Exactly one `abort` trace record per `graph.abort()` call |
| Cascade notification suppression | 0 spurious | Cascaded children must NOT fire parent-notification listeners |

---

## How to run

```bash
pnpm test src/agent/abort-cascade.bench.test.ts
```

The benchmark is deterministic (no network, no real AFK session). Each scenario
spawns an isolated child process. Total runtime is approximately 2 seconds.

---

## Results (2026-09-17)

Run environment: Node.js v24.11.0, macOS (darwin), tmpfs temp dir.

| Scenario | Descendants | cascadedTo | All aborted | Reason threaded | Trace recorded | Verdict |
|---|---|---|---|---|---|---|
| linear-chain | 2 | 2 | yes | yes | yes | **PASS** |
| wide-fan-out | 5 | 5 | yes | yes | yes | **PASS** |
| deep-5-level-chain | 4 | 4 | yes | yes | yes | **PASS** |
| child-only (no upward cascade) | 0 | 0 | yes | yes | yes | **PASS** |
| mixed-tree (2x2) | 6 | 6 | yes | yes | yes | **PASS** |

**ALL PASS. Both contract invariants hold across every topology tested.**

### Interpretation

The `AbortGraph.abort()` method uses BFS to materialize the full descendant list
before firing any controller. This means the `cascadedTo[]` payload is fully known
and emitted to the trace before any abort listener runs. The separation eliminates
a race between cascading aborts and listener-driven disposal that could otherwise
shrink the observed cascade set.

The child-only scenario (D) is the strongest negative test: it proves the
directional invariant -- abort propagates strictly downward. The parent's controller
stays live, and the notification fires through the `onChildAborted` listener path
rather than the cascade path.

The `cascading` flag on each `GraphNode` is the mechanism that suppresses spurious
parent notifications during a cascade. When a child is aborted as part of a parent
cascade, `cascading = true` prevents the child's abort listener from notifying the
parent ("my child died") -- because the parent already knows (it initiated the
cascade). This is verified indirectly: if the suppression failed, the parent
listener would fire, and in a real session that would trigger incorrect
`subagent_lifecycle` events.

---

## Gaps and open questions

1. **Cross-process cascades not tested.** In production, parent and child sessions
   run in the same Node process but on different async stacks. This benchmark
   constructs the graph in a single synchronous scope. A future scenario should
   verify cascade timing when children are running concurrent async work.

2. **Dispose-during-cascade not benchmarked.** The unit test covers dispose
   semantics, but a process-level test verifying that a disposed node during an
   active cascade does not corrupt the BFS would strengthen coverage.

3. **Cascading flag visibility.** `isCascading()` is observational only. A future
   benchmark could verify that downstream `subagent_lifecycle` events correctly
   distinguish cascade-driven abort from self-initiated abort using this flag.

---

## Related benchmarks

- [Trace Completeness Under kill -9](./trace-completeness.md) -- validates event
  survival, which this benchmark depends on for reading back abort records.
- Crash-to-resume (planned) -- validates DAG checkpoint correctness.
