# Crash-to-Resume DAG Checkpoint Correctness

**Benchmark ID:** crash-to-resume-v1
**Status:** Initial results published
**Date:** 2026-09-17
**Contract ref:** `src/agent/dag-checkpoint.ts` -- "On restart the executor loads the checkpoint, verifies the DAG hash, and skips already-completed nodes"

---

## What is being tested

The DAG executor (`src/agent/dag.ts`) checkpoints completed layers to disk after
each layer finishes. When a session crashes mid-DAG (process kill, OOM, timeout),
the checkpoint file survives. On restart with the same `dagId`, the executor loads
the checkpoint, verifies the structural hash, and resumes from the first incomplete
layer -- skipping nodes that already finished.

This is a core operational property for unattended work: a long DAG (research ->
implement -> verify) that crashes after the research phase must not re-run research
on resume. The operator pays wall-clock time and API cost once per node, not once
per attempt.

Four properties must hold:

1. **No re-run.** Completed nodes are skipped on resume.
2. **Output preservation.** Checkpointed outputs are deserialized and delivered as
   upstream inputs to downstream nodes.
3. **Stale rejection.** A structural change (different nodes or edges) produces a
   different hash, causing the checkpoint to be rejected and a clean re-run to start.
4. **Cleanup.** A fully successful run clears the checkpoint file.

---

## Test methodology

Each scenario uses `saveCheckpoint()` to write a checkpoint simulating a prior
crashed run, then calls `runDAG()` with the same `dagId` and a matching or
mismatching DAG structure. Tracking nodes use a shared `Map<string, number>`
counter to record invocation counts -- a node with count 0 was skipped (restored
from checkpoint), count 1 means it ran.

`AFK_STATE_DIR` is set to a per-test temp directory so checkpoint files do not
pollute real state. This mirrors the pattern used in the existing `dag-checkpoint.test.ts`
unit tests.

No child processes or kill signals are used. The checkpoint system is purely
file-driven -- `saveCheckpoint` writes a JSON file, `loadCheckpoint` reads it --
so in-process testing is faithful to the real crash-and-restart scenario.

| Scenario | Setup | Resume behavior |
|---|---|---|
| `no-rerun-on-resume` | Checkpoint: A completed. DAG: A -> B -> C. | A skipped, B+C run |
| `output-preservation` | Checkpoint: A produced `{value:42}`. DAG: A -> B. | B receives `{value:42}` as input |
| `stale-checkpoint-rejection` | Checkpoint for A->B. DAG changed to A->B->C. | Hash mismatch, all nodes re-run |
| `cleanup-on-success` | No prior checkpoint. DAG: A -> B. | Runs to completion, checkpoint file deleted |

---

## Success criteria

| Metric | Target | Notes |
|---|---|---|
| Completed-node skip | 100% | Checkpointed nodes must not execute on resume |
| Output deserialization | exact match | JSON round-trip must preserve object structure |
| Hash guard | reject on mismatch | Different structure = clean re-run, never partial resume |
| Post-success cleanup | file absent | No stale checkpoint leaks after full completion |

---

## How to run

```bash
pnpm test src/agent/dag-checkpoint.bench.test.ts
```

The benchmark is deterministic (no network, no spawned processes, no real AFK
session). Total runtime is under 1 second.

---

## Results (2026-09-17)

Run environment: Node.js v24.11.0, macOS (darwin), tmpfs temp dir.

| Scenario | Property | Node counts | Verdict |
|---|---|---|---|
| no-rerun-on-resume | skip completed nodes | A=0 B=1 C=1 | **PASS** |
| output-preservation | upstream inputs intact | B received `{value:42}` | **PASS** |
| stale-checkpoint-rejection | hash mismatch -> re-run | A=1 B=1 C=1 | **PASS** |
| cleanup-on-success | checkpoint cleared | file absent | **PASS** |

**ALL PASS. All four checkpoint properties hold.**

### Interpretation

The checkpoint system uses `computeDAGHash()` (SHA-256 of sorted node IDs + sorted
edge pairs) as a structural identity check. This means:

- **Adding or removing a node** invalidates the checkpoint (different hash).
- **Adding or removing an edge** invalidates the checkpoint.
- **Reordering nodes** does NOT invalidate (IDs are sorted before hashing).
- **Changing a node's `run` function** does NOT invalidate (closures are excluded
  from the hash by design -- the hash is structural, not behavioral).

Output serialization uses `serializeOutput()` which JSON-encodes non-string values
and truncates to 10 KB per node. The resumed run deserializes via `JSON.parse()`.
The benchmark verifies that a structured object (`{value: 42}`) survives this
round-trip intact.

The cleanup property prevents checkpoint leakage: on full success, `clearCheckpoint()`
deletes the file. Only partial runs (crash or abort before completion) leave a
checkpoint on disk.

---

## Gaps and open questions

1. **Large output truncation.** Node outputs exceeding 10 KB are truncated by
   `serializeOutput()`. A resumed node receiving truncated upstream input may
   behave differently than the original run. This is documented in the checkpoint
   module but not yet benchmarked.

2. **Failed-node restoration.** When `failFast: false`, failed nodes are restored
   from the checkpoint with their error messages. The unit tests cover this; a
   benchmark-level test would verify error-message fidelity across processes.

3. **Concurrent DAG restarts.** Two processes resuming the same `dagId`
   simultaneously could race on checkpoint reads/writes. The checkpoint uses
   atomic rename (`renameSync`) for writes but has no reader lock.

4. **Power-failure durability.** Like the trace writer, `saveCheckpoint` uses
   `writeFileSync` (kernel page cache) without `fsync`. A system crash (not
   process kill) could lose the latest checkpoint.

---

## Related benchmarks

- [Trace Completeness Under kill -9](./trace-completeness.md) -- validates that
  trace event writes survive process kill, the same filesystem property checkpoint
  files depend on.
- [Abort-Cascade Correctness](./abort-cascade.md) -- validates abort propagation,
  which is the mechanism that stops in-flight DAG nodes when `failFast` triggers.
