# Trace Completeness Under kill -9

**Benchmark ID:** trace-completeness-v1
**Status:** Initial results published
**Date:** 2026-09-17
**Contract ref:** `docs/philosophy/afk-contract.md` -- "Every tool call (name, input size, result size...)"

---

## What is being tested

The AFK Contract requires every tool call that began execution to have a trace record. The
`NdjsonTraceWriter` uses O_APPEND file semantics and a serialized write queue, and the writer's
comments explicitly state: *"SIGKILL is uncatchable and a trace killed that way stays genuinely
unsealed (nothing in-process can help)."*

This benchmark answers: **given that per-call flush is claimed, what fraction of tool-call
records survive kill -9 at various boundaries -- including when the kill races in-flight writes?**

`appendFile` puts data in the kernel page cache (no `fsync` per event). On process kill the
kernel flushes dirty pages, so completed writes survive. This benchmark validates that property,
not power-failure durability (which would require per-event `fsync`).

The terminal `session_sealed` record is specifically excluded from the completeness score -- the
contract distinguishes between *event records* (must survive) and *seal status* (best-effort
under SIGKILL). A sealed-clean trace is always better, but the core guarantee is event survival.

All event kinds use the same `appendLine` -> `fh.appendFile` code path in the writer
(`writer.ts`), so testing `tool_call` events is sufficient to prove the flush-survives-kill
property for all event kinds (hook_decision, subagent_lifecycle, budget, abort, closure, claim).

---

## Test methodology

A child Node.js process (`tsx`) is spawned with a `NdjsonTraceWriter` writing to a temp dir.
The child emits N `tool_call` events (alternating started/completed pairs), with configurable
delays to widen the kill window. The parent sends `SIGKILL` at four boundary positions:

| Scenario | Kill timing |
|---|---|
| `zero-events` | Before any write (baseline -- no file should exist) |
| `mid-sequence` | After 1 of 5 pairs, before remaining pairs |
| `batch-complete` | After all 5 pairs flushed, before seal |
| `mid-write` | After 3 pairs flushed + READY, kill races 10 more fire-and-forget pairs |

After the child exits, the parent reads the NDJSON file and counts valid, parseable `tool_call`
events. Completeness = records_found / records_expected x 100%.

---

## Success criteria

| Metric | Target | Notes |
|---|---|---|
| Events flushed before kill | 100% | O_APPEND: each `appendFile` is atomic |
| Sealed-clean rate | 0% under SIGKILL | Expected -- exit handler cannot run |
| Partial trace parseable | 100% | NDJSON: partial last line is truncated; preceding lines must parse |
| `session_sealed` on SIGKILL | none | Documented honest gap, not a regression |

---

## How to run

```bash
pnpm test src/agent/trace/trace-completeness.bench.test.ts
```

The benchmark is deterministic (no network, no real AFK session). Each scenario spawns
and kills an isolated child process. Total runtime is approximately 1-2 seconds.

---

## Results (2026-09-17)

Run environment: Node.js v24.11.0, macOS (darwin), tmpfs temp dir.

| Scenario | Expected (min) | Recovered | Completeness | session_sealed |
|---|---|---|---|---|
| zero-events (baseline) | 0 | 0 | N/A | none (no file created) |
| mid-sequence (1 pair before kill) | 2 | 2 | **100%** | none (SIGKILL) |
| batch-complete (5 pairs before kill) | 10 | 10 | **100%** | none (SIGKILL) |
| mid-write (3 pairs + 10 in-flight) | 6 | >= 6 | **100%+** | none (SIGKILL) |

**All pre-signal events recovered across all kill scenarios. Mid-write scenario confirms
completed writes survive even when kill races in-flight writes, with no NDJSON corruption.**

### Interpretation

`NdjsonTraceWriter.appendLine()` calls `fh.appendFile()` which puts each JSON line in the
kernel page cache (no `fsync`). On macOS/Linux, `O_APPEND` writes are atomic. The kernel
flushes dirty pages when a process is killed (even via SIGKILL), so events whose `appendFile`
completed before signal delivery survive.

The `mid-write` scenario is the strongest test: 10 additional pairs are fired without awaiting
after the READY signal. The kill races these in-flight writes. The test verifies that (a) all
pre-signal events survive, (b) partial post-signal writes don't corrupt the NDJSON, and (c) seq
monotonicity holds across whatever events landed.

The `session_sealed` record is absent in all SIGKILL scenarios -- this is the documented
behavior. A killed trace is in `sealed-crashed` state, which readers can distinguish from
`live` or `sealed-clean`. This is an honest acknowledged gap, not a regression.

---

## Gaps and open questions

1. **fsync not called on event writes.** `appendLine` uses `fh.appendFile()` (OS page cache).
   On a system crash (power loss, not process kill), unflushed pages could be lost. For kill -9,
   the kernel flushes on exit, so this is fine.

2. **Concurrent writers not tested.** This benchmark uses a single writer. A future scenario
   should verify ordering guarantees with multiple parallel emitters under SIGKILL.

3. **Compaction sidecar integrity.** Sidecar writes use `writeFile()` (not O_APPEND). A kill
   mid-sidecar-write could produce a partially written sidecar.

---

## Next benchmarks

- ~~Abort-cascade correctness~~ -- shipped: [abort-cascade.md](./abort-cascade.md)
- ~~Crash-to-resume~~ -- shipped: [crash-to-resume.md](./crash-to-resume.md)
- Concurrent-emitter trace integrity (10 parallel writers, SIGKILL mid-batch)
