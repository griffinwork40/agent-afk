# Hook-Block Fidelity

**Benchmark ID:** hook-block-fidelity-v1
**Status:** Initial results published
**Date:** 2026-09-17
**Contract ref:** `docs/philosophy/afk-contract.md` -- "Silent hook failure (handler exceptions become HookBlockedError, fail-safe)" and "Every hook decision (event, decision kind, reason)"

---

## What is being tested

The AFK Contract makes two claims about the hook system:

1. **Fail-safe on error.** A hook handler that throws an arbitrary exception is
   wrapped in `HookBlockedError` -- the tool call is blocked, not silently
   passed. The system fails closed, never open.

2. **Trace fidelity.** Every block decision emits a `hook_decision` trace event
   with the correct `hookEvent`, `decision`, `reason`, and `blockedTool` fields.
   Blocks are never invisible.

These properties are load-bearing for unattended operation. If a policy hook
crashes and the tool call silently proceeds, the operator's safety boundary is
breached with no evidence. If a block is not traced, the operator cannot audit
what was denied.

---

## Test methodology

Each scenario spawns an isolated child process (`tsx`) that:

1. Constructs a `HookRegistryImpl` and a `NdjsonTraceWriter`
2. Registers one or more `PreToolUse` handlers with specific behaviors
3. Calls `dispatchPreToolUse()` (the same function the tool dispatcher uses)
4. Writes in-process verification data (error type, handler execution flags) to
   a JSON file
5. Seals the trace and exits

The parent reads both the trace file and the verification file to cross-check:
the trace proves what was **recorded**; the verification file proves what
**happened in-process**.

| Scenario | Handler behavior | Expected outcome |
|---|---|---|
| `explicit-block` | Returns `{ decision: 'block' }` | `HookBlockedError` thrown, chain short-circuited, `hook_decision` traced |
| `fail-safe` | Throws `new Error(...)` | Exception wrapped in `HookBlockedError`, cause preserved, `hook_decision` traced |
| `allow-path` | Returns `{ decision: 'approve' }` | Dispatch resolves, no block `hook_decision` in trace |
| `multi-handler` | H1 approves, H2 blocks, H3 exists | H1 fires, H2 blocks, H3 never fires, `hook_decision` traces the block |

---

## Success criteria

| Metric | Target | Notes |
|---|---|---|
| Block enforcement | 100% | `decision:'block'` must throw `HookBlockedError` |
| Fail-safe (throw -> block) | 100% | Any handler exception must become `HookBlockedError`, never pass-through |
| Chain short-circuit | 100% | Handlers after a block must never fire |
| Cause preservation | 100% | Original exception must be accessible via `err.cause` |
| Trace emission on block | 1 event per block | `hook_decision` with `decision:'block'` and correct `blockedTool` |
| Trace silence on allow | no block events | Allow decisions must not produce a `decision:'block'` trace record |

---

## How to run

```bash
pnpm test src/agent/hook-block-fidelity.bench.test.ts
```

The benchmark is deterministic (no network, no real AFK session). Each scenario
spawns an isolated child process. Total runtime is under 1 second.

---

## Results (2026-09-17)

Run environment: Node.js v24.11.0, macOS (darwin), tmpfs temp dir.

| Scenario | Block enforced | Chain short-circuit | Error type | Trace event | Verdict |
|---|---|---|---|---|---|
| explicit-block | yes | yes (h2 skipped) | HookBlockedError | hook_decision: block, bash | **PASS** |
| fail-safe | yes | N/A (single handler) | HookBlockedError (cause preserved) | hook_decision: block, edit_file | **PASS** |
| allow-path | N/A | N/A | no throw | no block event | **PASS** |
| multi-handler | yes | yes (h3 skipped) | HookBlockedError | hook_decision: block, write_file | **PASS** |

**ALL PASS. Both contract invariants hold across every scenario tested.**

### Interpretation

The `HookRegistryImpl.dispatch()` loop (`hook-registry.ts`) processes handlers
sequentially with a try/catch around each handler invocation. The catch path
(line 197) wraps non-timeout exceptions in `HookBlockedError` -- this is the
fail-safe: a buggy handler cannot silently pass.

After each handler returns, `isBlocking(decision)` checks both
`decision.continue === false` and `decision.decision === 'block'`. A blocking
decision immediately throws `HookBlockedError` and the loop exits -- no
subsequent handler fires. This is the chain short-circuit property.

The `dispatchPreToolUse` wrapper (`subagent-hooks.ts:199`) catches the
`HookBlockedError` and calls `emitHookDecisionFromOutcome` before re-throwing.
This ensures the trace event is written even though the dispatch throws.

The `multi-handler` scenario (D) is the strongest test: it proves that a
non-blocking handler executing before the blocker does not prevent the block,
and that handlers registered after the blocker are genuinely short-circuited
(handler3's side-effect flag stays false).

---

## Gaps and open questions

1. **PostToolUse block behavior not benchmarked.** PostToolUse blocks are
   swallowed by `dispatchPostToolUse` (the tool already ran). The benchmark
   covers only PreToolUse, where blocks have operational consequences.

2. **Handler timeout not benchmarked.** A handler exceeding `HOOK_HANDLER_TIMEOUT_MS`
   (30s) throws `HookHandlerTimeoutError`, which is re-thrown as-is (not wrapped
   in `HookBlockedError`). The timeout path is a different error class with
   different downstream semantics.

3. **Abort-during-dispatch not benchmarked.** The hook dispatch loop checks
   `assertNotAborted(signal)` between handlers. An abort signal arriving
   mid-dispatch should throw `AbortError` and prevent remaining handlers from
   running. This is tested in unit tests but not at the benchmark level.

---

## Related benchmarks

- [Trace Completeness Under kill -9](./trace-completeness.md) -- validates that
  trace events (including `hook_decision`) survive process kill.
- [Abort-Cascade Correctness](./abort-cascade.md) -- validates abort propagation,
  which interacts with hook dispatch via `assertNotAborted`.
- [Concurrent-Emitter Trace Integrity](./concurrent-emitter.md) -- validates that
  concurrent trace writes (from parallel sessions, each with hooks) do not
  interfere.
