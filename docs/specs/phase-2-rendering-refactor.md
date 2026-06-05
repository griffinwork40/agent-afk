# Spec — Phase 2: Rendering-Subsystem Refactor + Bug Fixes

**Branch**: `refactor/rendering-pipeline`  
**PR**: Single PR — refactor + all 5 bug fixes together  
**Spec status**: Awaiting approval before implementation begins  
**Authored against**: `docs/rendering-architecture-desired.md`, `docs/rendering-architecture-current.md`, `docs/rendering-bugs-handoff.md`  
**Amended**: 2025 session — `/devils-advocate` review

---

## Problem

The interactive TUI rendering pipeline (`stream-renderer*.ts`, `tool-lane*.ts`) has no explicit ordering authority governing when a tool-lane entry commits to scrollback. Ordering is emergent from call sequencing across four files, producing five confirmed user-visible bugs. Five prior investigations produced contradictory root-cause claims — the contradiction is itself evidence that the mental model is wrong, not the diagnosis logic.

---

## Goals

1. Introduce a single commit-ordering authority (`CommitCoordinator`) that serializes all scrollback writes with declared anchors. **`schedule()` is synchronous; `flushAll()` is async and called once at turn end.** This eliminates the fire-and-forget `void finalizeOrchestrator` race without propagating `async` through `StreamRenderer.process()` or `handleOrchestratorEvent`.
2. Unify the tool-use counter so the header and footer always agree.
3. Enforce the `agentType` invariant at every dispatch callsite so no entry renders with a generic label. Make `agentType` a required field on `ForkSubagentOptions` so future omissions are compile errors.
4. Bound the pause/stalled tick loop so it cannot run indefinitely.
5. Fix Bug #5 (Done-after-overflow connector) by making `assignConnectors` declarative and total.
6. Land all 5 bug fixes in one PR, each gated by a previously failing Phase 1 test.
7. Carry forward stash@{6} hygiene fixes in a 2f checkpoint (see § Stash decisions).
8. No regression to existing scrollback output — pinned by `toMatchSnapshot()` assertions on `tool-lane-render.ts` representative outputs PLUS retained existing string-content assertions.

---

## Non-Goals

(From desired-state doc + scope analysis + `/devils-advocate` review)

- **Explicit `EntryLifecycle` state machine** (`PENDING → IN_FLIGHT → SETTLED → COMMITTED`). The desired-state doc proposed it; the critique found that no current rendering path branches on those states and none of the 5 bugs are lifecycle-state bugs. The states would be purely documentary in this PR. **Deferred to Phase 3** when concurrent-entry rendering needs lifecycle-based branching.
- Multi-turn REPL history re-rendering.
- Telegram / daemon rendering paths (`out.line` non-TTY fallback).
- `ThinkingLane.collapse()` / `thinkingMode` semantics.
- `ProviderEvent` stream normalization.
- Compose/DAG executor logic beyond the `agentType` pass-through at the fork site.
- Performance optimizations; tick interval stays 80 ms.
- `stash@{11}`'s unrelated changes: `scripts/build-dist.mjs` postinstall copy, `doctor.ts` `checkNpmBinOnPath`, `login-command.ts` refactor, `cli/index.ts` changes. Only the `committing` boolean hunk from `terminal-compositor.ts` ships in this PR.

---

## Approach

Five sequential sub-checkpoints (2a–2e) plus one hygiene checkpoint (2f). Each is a commit; tests must be green before the next checkpoint starts. Phase 1 failing tests are written first (commit "test: Phase 1 failing tests for rendering bugs #1–#5") and remain failing until the checkpoint listed in the table below.

**Root-cause collapse (affirmed)**: the desired-state doc's hypothesis that 5 bugs → 3 root causes is correct per the current-state doc's analysis:

| Bug | Root Cause | Closed By |
|-----|-----------|-----------|
| #1 Skill block below prose | `void finalizeOrchestrator(...)` races markdown flush; ordering is call-order-emergent | **2a** |
| #3 Stuck paused state | `source.done` never fires on abort/error race; tick runs forever | **2e** |
| #2 Orphaned/mis-labeled agent entry | Raw `agent` dispatch omits `agentType` at `forkSubagent` callsite | **2d** |
| #4 Header/footer count disagree | `progress` event blind-replaces per-`tool_use_detail` counter | **2c** |
| #5 Done after overflow | `agentResultSummary` appended after `renderFlushChildren` returns; connector not recalculated | **2b** |

Root causes in 3 sentences: (1) Ordering bugs #1 and #3 share the root that lifecycle transitions are implicit call order — CommitCoordinator + bounded stalled lifecycle fix this. (2) Counter bug #4 is a dual-writer with incompatible semantics — unification fixes this. (3) Label (#2) and connector (#5) bugs are call-site omissions — invariant and declarative rule fix these.

---

## Stash Decisions

### stash@{11} — `committing` boolean guard in `TerminalCompositor.repaint()`

**Decision: Hand-apply the `committing` hunk in checkpoint 2a. Do not cherry-pick the entire stash.**

The stash mixes unrelated changes (doctor, build-dist, login-command, cli/index). The only hunk relevant to this PR is in `src/cli/terminal-compositor.ts`:

```diff
+  private committing = false;
   ...
+  this.committing = true;
   this.logUpdate.clear();
   this.stdout.write(text + '\n');
+  this.committing = false;
   this.repaint();
   ...
-  if (!this.armed || !this.logUpdate) return;
+  if (!this.armed || !this.logUpdate || this.committing) return;
```

**Rationale**: This guard prevents `repaint()` from firing mid-`commitAbove`, closing the async race where a concurrent repaint tick could re-render the overlay on top of a scrollback write before `commitAbove` finishes. This directly hardens Bug #1's fix — `CommitCoordinator` eliminates the race at the orchestration level, and this guard eliminates it at the compositor level (defense-in-depth). Both are needed. The spec calls this out explicitly so the fix is not re-derived.

### stash@{6} — Hygiene fixes (spinner, SIGINT routing, markdown, logUpdate.done)

**Decision: Include as checkpoint 2f in this PR. Do not defer.**

Justification:
1. **SIGINT routing** (`commitAbove` instead of `console.log`) directly affects Bug #1's observable behavior: the interrupted state message can race the overlay repaint and be erased. Fixing it here prevents a confusing PR-review question ("why does the interrupt message still flicker?").
2. **`logUpdate.done()` in `disarm()`** is a cursor-visibility correctness fix with a test already written in the stash. Leaving a hidden cursor between turns would be immediately regressive on the PR demo run.
3. **Spinner enable/disable on event boundaries** and **markdown trailing-newline + wrap-before-indent order** are bounded, isolated changes with their own tests already in stash@{6}. Including them avoids a follow-up PR for bugs that will be noticed during the Phase 3 manual repro.
4. stash@{7} is a strict subset of stash@{6} — ignore.

2f is explicitly scoped as hygiene: it closes **no named bugs** and requires no architecture changes. It is the last checkpoint before Phase 3.

---

## Phase 1 Prerequisite — Failing Tests Commit

**Commit message**: `test: Phase 1 failing tests — rendering bugs #1–#5 (RED)`

Write all five tests before any source edits. Each test must fail with the current code.

| Bug | Test file | Test description |
|-----|-----------|-----------------|
| #1 | `src/cli/_lib/stream-renderer-ordering.test.ts` (new) | Drive `StreamRenderer` + `ToolLane` with sequence `[tool_use_detail, tool_result, content]` — assert tool-lane scrollback lines appear **above** content lines in `commitAbove` call order. **Must use `vi.useFakeTimers()` and real async dispatch** to actually reproduce the race; a fully-synchronous test will go green before the fix and provide false confidence (paranoid-critic call-out). |
| #2 | `src/cli/_lib/stream-renderer-ordering.test.ts` (new) | Dispatch a raw `agent` tool invocation via `SubagentExecutor` mock; assert overlay / committed output contains `Agent(<meaningful-label>)`, not `Agent(agent-tool)` |
| #3 | `src/cli/_lib/stream-renderer-ordering.test.ts` (new) | Simulate source with no `done` event; advance synthetic time past `2K × 80 ms`; assert entry transitions to settled with `[no-result]` marker, not paused indefinitely |
| #4 | expanded `src/cli/commands/interactive/tool-lane.test.ts` | Fire N `tool_use_detail` events then one `progress` event with `toolUses = N+10`; assert `source.stats.toolUses === N` (progress event did not overwrite) |
| #5 | expanded `src/cli/commands/interactive/tool-lane.test.ts` | Add `MAX_VISIBLE_CHILDREN + 1` entries + `agentResultSummary`; call `flush()`; assert overflow ellipsis line appears **before** result summary line AND result summary has `└` connector, not `├` |

Additionally: add `toMatchSnapshot()` assertions for representative `tool-lane-render.ts` flush outputs (3–5 scenarios covering single tool, multi-tool, overflow, error, subagent). Snapshots captured against current code; they must continue to pass at the start of each checkpoint and at PR merge. Retain existing string-content assertions — snapshots complement, not replace, them.

---

## Sub-Checkpoint Breakdown

### 2a — CommitCoordinator + ordering fix + `committing` guard (Bug #1)

**Commit message**: `refactor(renderer): introduce CommitCoordinator; serialize scrollback writes; apply committing guard`

**What changes**:
- New file: `src/cli/_lib/commit-coordinator.ts`
  - `CommitCoordinator` class
  - **`schedule(batch: CommitBatch): void`** — **synchronous registration only.** Accepts a batch + anchor and stores it in an internal queue keyed by anchor. Does not call `commitAbove` or any other I/O.
  - **`flushAll(): Promise<void>`** — **async; called once at turn end** from the existing async owner. Drain order is fixed and explicit:
    1. Drain all `'before-content'` batches (synchronous `commitAbove` calls)
    2. `await streamingMarkdown.flush()`
    3. Drain all `` `after-subagent:${id}` `` batches in registration order
    4. Drain all `'after-content'` batches
  - Anchors: `'before-content'` | `'after-content'` | `` `after-subagent:${id}` ``
  - One instance per turn. **Lifetime: per-turn, no reset needed.** Confirmed: `StreamRenderer` is constructed fresh at `turn-handler.ts:76`, `builtin-skills.ts:36`, `init.ts:80` (3 sites, all per-invocation). Each new `StreamRenderer` instance owns its own fresh `CommitCoordinator`.
- `src/cli/_lib/stream-renderer-orchestrator.ts`
  - Line 172: `void finalizeOrchestrator(source, ctx)` — **the `void` stays.** `finalizeOrchestrator` no longer performs flush I/O directly. It calls `coordinator.schedule({ anchor: 'before-content', commits: [...] })` synchronously and returns. The actual flush happens at turn end via `coordinator.flushAll()`.
  - `flushToolLaneToScrollback` becomes a private helper that builds a `CommitBatch` (data) instead of calling `commitAbove` (I/O). The batch is handed to `CommitCoordinator.schedule()`.
  - Subagent `done` path: `coordinator.schedule({ anchor: `after-subagent:${sourceId}`, commits: [...] })` — drained at turn end in registration order.
  - `emitPanel`, skill badge: `coordinator.schedule({ anchor: 'after-content', commits: [...] })`.
- `src/cli/_lib/stream-renderer.ts`
  - `process()` and `handleOrchestratorEvent` **remain synchronous.** Their public signatures and all test call sites are unchanged.
  - The existing async owner at turn end (already present in `StreamRenderer`'s turn-cleanup path — verify exact location during implementation, grep for the existing async path that owns `streamingMarkdown.flush`) is the call site for `await coordinator.flushAll()`. Audit before commit: confirm there is exactly one async owner at turn end. If there is not, the audit is the implementation prerequisite — do not work around it by introducing fire-and-forget calls.
- `src/cli/terminal-compositor.ts`
  - Hand-apply `committing` boolean guard from stash@{11} (see § Stash decisions)
  - Existing `terminal-compositor.test.ts` for the guard (already written in stash@{11}'s diff) is extracted and committed here

**Bugs closed**: #1  
**Phase 1 tests that turn green**: Bug #1 ordering test  
**Backward-compat gate**: all snapshot tests still pass

**Pre-implementation audit (required, ~15 minutes, before writing any source edits in 2a)**:
1. Confirm `StreamRenderer`'s turn-end async owner. Grep `streamingMarkdown.flush` and trace its current await chain. If no single async owner exists, that is itself a refactor surface — surface to the user before proceeding rather than introduce a new fire-and-forget call.
2. Grep `handleOrchestratorEvent` callers (expected: `stream-renderer.ts` only). Confirm no external caller depends on its current signature.
3. Confirm the `void finalizeOrchestrator` at line 172 is the only fire-and-forget on the orchestrator's flush path.

---

### 2b — Tree-connector contract (declarative `assignConnectors`) — Bug #5

**Commit message**: `refactor(renderer): extract declarative assignConnectors; fix Bug #5 overflow connector`

**What changes**:
- `src/cli/commands/interactive/tool-lane-render.ts`
  - Extract `assignConnectors(siblings: RenderableSibling[]): ConnectedSibling[]` as a standalone pure function (desired-state doc §4)
  - Rule: last item gets `'└ '`, all prior get `'├ '`. Overflow ellipsis is a synthetic child that obeys the same rule — added to the list **before** `assignConnectors` runs, not after.
  - `agentResultSummary` is also added as a synthetic child **before** `assignConnectors` runs (not appended after `renderFlushChildren` returns as it is today at lines 343–345)
  - `renderFlushChildren` is refactored to call `assignConnectors` as its first step, then render each connected child
  - File remains in `tool-lane-render.ts` (not split — the handoff brief's "split by render context" goal for this checkpoint is interpreted as: make the connector logic a pure function that both overlay and flush paths share, not a file split that would risk regressions)
  - Add `addOverflowSynthetic` helper (no-op if `≤ MAX_VISIBLE_CHILDREN`)
- `src/cli/commands/interactive/tool-lane.test.ts`
  - Property tests for `assignConnectors` as specified in desired-state doc §4:
    - For any non-empty list: exactly one item has `'└ '` connector, it is last
    - For any list with overflow: overflow line is last, has `'└ '`
    - No item after a `'└ '` item exists

**Bugs closed**: #5  
**Phase 1 tests that turn green**: Bug #5 connector test  
**Backward-compat gate**: existing `tool-lane-render` snapshot tests still pass

---

### 2c — Counter unification (Bug #4)

**Commit message**: `refactor(renderer): unify tool-use counter; isolate progress-event field`

**What changes**:
- `src/cli/_lib/stream-renderer-subagent.ts`
  - Line 156: change `source.stats.toolUses = event.progress.toolUses` → `source.stats.progressReportedToolUses = event.progress.toolUses` (new field, separate from the increment-only counter)
  - `source.stats.toolUses` is now **increment-only**, written only by `tool_use_detail` handlers (lines 100, 175)
- `src/cli/_lib/stream-renderer-source.ts`
  - Add `progressReportedToolUses?: number` to `SourceStats` type
- `src/cli/commands/interactive/tool-lane-render.ts`
  - `formatDoneSummary` reads only `source.stats.toolUses` (already correct per current-state doc; verify and add assertion comment)
  - `formatAgentSummary` reads `toolChildren.length` (already correct; add assertion comment that invariant holds: `toolChildren.length === source.stats.toolUses` at commit time)
- `src/cli/commands/interactive/tool-lane.test.ts`
  - Bug #4 test now passes

**Semantic decision — progress events are advisory, not authoritative**:

The `event.progress.toolUses` field counts SDK-reported iterations, not distinct `tool_use_detail` events. These are different quantities that happen to share a name. The ground truth for "how many tools did this subagent use" is `source.stats.toolUses` (increment per `tool_use_detail`). Progress events are stored for potential future diagnostics but never overwrite the ground-truth counter.

**External readers audit (closed, no migration needed)**:

Grepped all readers of `stats.toolUses` across `src/`. Four readers, all safe:

| Site | Read context | Effect of 2c |
|------|--------------|--------------|
| `src/cli/background-status-bar.ts:151–152` | Reads `task.stats.toolUses` — **`BackgroundTask.stats`, not `SourceState.stats`** | **No effect.** Different tracking object on a parallel path (non-TTY background mode); fed by `event.progress.toolUses` via `createBackgroundSink`. The two stats objects are independent. |
| `src/cli/_lib/stream-renderer-source.ts:67–68` | Reads `source.stats.toolUses` for `formatDoneSummary` | Reads the authoritative increment-only counter — correct after 2c. |
| `src/cli/commands/interactive/repl-loop.ts:144` | Reads `task.stats.toolUses` — **`BackgroundTask.stats`**, same as background-status-bar | **No effect**, same rationale. |
| `src/cli/commands/interactive/background.ts:64` | **Assigns** `task.stats.toolUses` (not a display read) — sets it from `partial.toolUses` for `BackgroundTask` | **No effect.** `BackgroundTask.stats.toolUses` continues to be populated from `event.progress.toolUses` via the background sink. Independent path. |

**Correction (from `/devils-advocate` review)**: An earlier version of this spec claimed all 4 readers "just display the count." That is wrong for `background.ts:64` (which is an assignment), but the conclusion — that 2c is safe — holds, because `BackgroundTask.stats` is a separate object from `SourceState.stats` and the unification only touches the latter.

**Bugs closed**: #4  
**Phase 1 tests that turn green**: Bug #4 counter test

---

### 2d — `agentType` propagation invariant (Bug #2)

**Commit message**: `fix(agent): propagate agentType at raw agent dispatch site; make field required`

**What changes**:
- `src/agent/tools/subagent-executor.ts`
  - Line 269–274: add `agentType` to the `forkSubagent` call options:
    ```typescript
    agentType: parsed.id_prefix !== 'agent-tool'
      ? parsed.id_prefix
      : prompt.slice(0, 40).trim() || 'agent',
    ```
  - If the caller supplied a meaningful `id_prefix` (not the default `'agent-tool'`), use it. Otherwise use the first 40 chars of the prompt as a human-readable hint. This is the decision the desired-state doc §5 specifies ("or the prompt's first 40 chars as a hint").
- `src/agent/subagent.ts`
  - **`agentType` becomes required** on `ForkSubagentOptions` (not optional). Compile-time enforcement of the invariant. Migration cost: 3 callers — `compose-executor.ts:231` (already passes), `skill-executor.ts:303` (already passes via `idPrefix`), `dag-subagent.ts:68` (already passes). Only `subagent-executor.ts:269` was missing it; this checkpoint adds it.
- `src/cli/_lib/stream-renderer-subagent.ts`
  - Belt-and-suspenders renderer-side guard (already described in desired-state doc §5): if `source.agentType` is empty at `synthesizeAgentEntry` call time, fall back to `idPrefix`. Verify line 131–133 implements this correctly; add assertion comment.
- `src/cli/_lib/stream-renderer-ordering.test.ts`
  - Bug #2 label test now passes

**Module boundary**: The fix is at `subagent-executor.ts` (agent side), but the label rendering is in `stream-renderer-subagent.ts` (CLI side). The invariant is enforced at the fork site, which is the single choke point — all `agent` tool dispatches go through `SubagentExecutor.execute`. Making `agentType` required at the TypeScript boundary closes the future-omission failure mode statically.

**Bugs closed**: #2  
**Phase 1 tests that turn green**: Bug #2 label test

---

### 2e — Bounded pause/stalled lifecycle (Bug #3)

**Commit message**: `refactor(renderer): bounded stalled lifecycle; replace checkPauseAnnotations`

**What changes**:
- `src/cli/_lib/stream-renderer.ts`
  - Rename `checkPauseAnnotations()` → `checkStalledEntries()`
  - Per-source logic:
    - Add `source.stalledTicks: number` to `SourceState` (in `stream-renderer-source.ts`)
    - At each tick: if `source.done || source.errored`, skip. If `elapsed > PAUSE_THRESHOLD_MS`, increment `source.stalledTicks`.
    - At `source.stalledTicks === K` (375): set `source.pauseAnnotation` (existing behavior, label update).
    - At `source.stalledTicks === 2K` (750): call `toolLane.addResult(source.syntheticAgentToolUseId, syntheticResult('[no-result — timed out]', false))` + set `source.done = true`. This stops further ticks and allows the entry to commit normally through the `CommitCoordinator`.
  - Constants: `const K = 375;` (`K × 80 ms = 30 s` to first stalled label, `2K × 80 ms = 60 s` to auto-settle); document at definition site.
- `src/cli/_lib/stream-renderer-source.ts`
  - Add `stalledTicks: number` to `SourceState` (initialized to 0 in `freshSourceState`)
- `src/cli/_lib/stream-renderer-ordering.test.ts`
  - Bug #3 stalled-lifecycle test now passes

**K-value justification**: 60 s of stalled wall-clock is the user-perceived threshold where "the agent is working" tips into "the agent is wedged." Auto-settling with `[no-result]` is preferable to indefinite paused state because (a) it lets the user see what completed, (b) the entry commits and stops occupying overlay space, (c) the synthetic result is visually distinguishable from a real one. 30 s to first label gives users a soft warning before the hard cutoff.

**Bugs closed**: #3  
**Phase 1 tests that turn green**: Bug #3 stalled-lifecycle test  
**Note**: 2e depends on 2a (CommitCoordinator) being in place so the auto-settled entry can commit through the correct path. Do not reorder.

---

### 2f — Hygiene fixes from stash@{6}

**Commit message**: `fix(renderer): hygiene — spinner events, SIGINT routing, markdown wrap, logUpdate.done`

**What changes** (hand-apply from stash@{6}, one hunk at a time with test):

1. **Spinner enable/disable on event boundaries** (`stream-renderer-orchestrator.ts` ~lines 99–137):
   - `tool_use_detail` event → `ctx.compositor.setSpinner({ enabled: true, rotateVerbEveryMs: 3500 })` (user is waiting on tool execution)
   - `content` event → `ctx.compositor.setSpinner({ enabled: false })` (user is reading; spinner is misleading)
   - Tests: already written in stash@{6}'s diff — extract and include

2. **SIGINT routing through `commitAbove`** (`src/cli/commands/interactive.ts` ~line 128):
   - Route interrupt notice through `turnState.activeCompositor.commitAbove(msg)` when compositor is armed, falling back to `console.log`
   - Requires `TurnState.activeCompositor` field (set at arm, cleared at dispose) in `repl-loop.ts`

3. **Markdown trailing-newline strip + wrap-before-indent order** (`src/cli/markdown-stream.ts` ~lines 181–246):
   - `commitBlock`: strip trailing newlines before `commitAbove`; emit `trimmed + '\n'` explicitly
   - Overlay path: `wrapToWidth(pendingRender, contentWidth)` then `applyIndent(wrapped)` (not wrap-after-indent)

4. **`logUpdate.done()` in `compositor.disarm()`** (`src/cli/terminal-compositor.ts`):
   - Call `logUpdate.done()` in `disarm()` after `logUpdate.clear()` so cursor is restored between turns
   - Test: already written in stash@{6} — extract and include

**Bugs closed**: none (hygiene only)  
**Phase 1 tests affected**: none  
**Backward-compat gate**: `terminal-compositor.test.ts` and `stream-renderer.test.ts` still pass

---

## File Edit Map

| File | Action | Checkpoints |
|------|--------|-------------|
| `src/cli/_lib/commit-coordinator.ts` | **Create** | 2a |
| `src/cli/_lib/commit-coordinator.test.ts` | **Create** | 2a |
| `src/cli/_lib/stream-renderer-ordering.test.ts` | **Create** (failing) → green | Phase 1 → 2a, 2d, 2e |
| `src/cli/commands/interactive/tool-lane-render.ts` | Edit — `assignConnectors`, synthetic siblings | 2b |
| `src/cli/commands/interactive/tool-lane.test.ts` | Edit — add Bug #4 and #5 tests + `assignConnectors` property tests + snapshot scenarios | Phase 1, 2b, 2c |
| `src/cli/_lib/stream-renderer-orchestrator.ts` | Edit — schedule via CommitCoordinator (sync); spinner events | 2a, 2f |
| `src/cli/_lib/stream-renderer-subagent.ts` | Edit — counter unification; belt-and-suspenders agentType guard | 2c, 2d |
| `src/cli/_lib/stream-renderer.ts` | Edit — call `await coordinator.flushAll()` at turn-end async owner; checkStalledEntries | 2a, 2e |
| `src/cli/_lib/stream-renderer-source.ts` | Edit — add `progressReportedToolUses`, `stalledTicks` fields | 2c, 2e |
| `src/agent/tools/subagent-executor.ts` | Edit — add `agentType` to `forkSubagent` call | 2d |
| `src/agent/subagent.ts` | Edit — make `agentType` required on `ForkSubagentOptions` | 2d |
| `src/cli/terminal-compositor.ts` | Edit — `committing` guard; `logUpdate.done()` in disarm | 2a, 2f |
| `src/cli/terminal-compositor.test.ts` | Edit — add guard test; add `logUpdate.done` test | 2a, 2f |
| `src/cli/commands/interactive.ts` | Edit — SIGINT routing through `commitAbove` | 2f |
| `src/cli/commands/interactive/repl-loop.ts` | Edit — add `activeCompositor` to `TurnState` | 2f |
| `src/cli/markdown-stream.ts` | Edit — trailing newline strip; wrap-before-indent | 2f |

---

## Test Plan

### Pre-condition: Snapshot pins (before first source edit)

In the Phase 1 commit, add `toMatchSnapshot()` assertions on representative `tool-lane-render.ts` outputs (≥5 scenarios: single tool, multi-tool, overflow, error result, subagent with children). These pin the visual baseline. Run existing tests and confirm green.

```
pnpm test -- src/cli/commands/interactive/tool-lane.test.ts
pnpm test -- src/cli/commands/interactive/tool-lane-format.test.ts
```

### Phase 1: Write failing tests (RED commit)

All five Phase 1 tests + snapshot pins written in one commit. Run `pnpm test` — expected: 5 new tests fail, snapshots captured, all others pass.

### Per-checkpoint gate

After each checkpoint commit, run:

```bash
pnpm test
```

Expected: all tests that were green before remain green. Snapshots unchanged. The Phase 1 test corresponding to the checkpoint turns green. No other Phase 1 tests turn green prematurely.

### New test files

| File | Coverage |
|------|----------|
| `src/cli/_lib/commit-coordinator.test.ts` | Anchor ordering invariant (before-content → content → after-subagent → after-content); idempotent `schedule()`; `flushAll` is idempotent; sync `schedule()` does no I/O |
| `src/cli/_lib/stream-renderer-ordering.test.ts` | Bugs #1, #2, #3 ordering/label/stalled scenarios (Bug #1 test must use real async + `vi.useFakeTimers()` to actually reproduce the race) |
| Expanded `tool-lane.test.ts` | Bug #4 counter isolation; Bug #5 connector contract; `assignConnectors` property tests; new snapshot scenarios |
| `src/cli/terminal-compositor.test.ts` additions | `committing` guard; `logUpdate.done()` in disarm |

### Manual repro gate (hard constraint from handoff brief)

Before PR creation:

1. Run `afk` on a real `/review N` invocation (same invocation as the pre-refactor screenshot, if available; otherwise capture a fresh baseline at the Phase 1 commit before any source edits).
2. Capture scrollback screenshot (before = current branch at Phase 1 commit; after = post-2e commit).
3. Verify:
   - Skill block appears **above** post-skill prose (Bug #1)
   - Agent entries show meaningful labels (Bug #2)
   - No entry shows `paused Xm Ys` indefinitely (Bug #3)
   - Header tool count matches footer tool count (Bug #4)
   - `└ Done` appears after overflow ellipsis (Bug #5)
4. Include before/after screenshots in PR description.

---

## High-Risk Areas

### 1. `CommitCoordinator.flushAll()` async owner at turn end (2a)

The synchronous-`schedule()` design only works if there is exactly one async owner at turn end that calls `await coordinator.flushAll()`. If `flushAll()` is called from a fire-and-forget context, Bug #1 recurs through a new path. Mitigation: pre-2a audit (see § 2a Pre-implementation audit) confirms the existing async owner. If no clean owner exists, surface to the user — do not introduce a new `void` call.

### 2. `CommitCoordinator` flush ordering correctness (2a)

The drain sequence (1) `before-content`, (2) `await streamingMarkdown.flush()`, (3) `after-subagent:*` in registration order, (4) `after-content` is **the** ordering contract. Any reordering recreates Bug #1. Mitigation: `commit-coordinator.test.ts` asserts the sequence directly. Reviewer checklist for the PR includes "drain order matches spec."

### 3. Test design — async race reproducibility (Phase 1, Bug #1 test)

A fully-synchronous Bug #1 test will go green on current code by accident and provide false confidence. The test **must** use `vi.useFakeTimers()`, real microtask interleaving, or an event-loop tick boundary that reproduces the `void finalizeOrchestrator` race. The paranoid critic flagged this explicitly. Mitigation: code-review the Phase 1 commit before approving Phase 2 work — confirm the Bug #1 test fails on current code for the right reason (race not eliminated), not because of a synchronous-only assertion failure.

### 4. `agentType` propagation — making the field required (2d)

Making `ForkSubagentOptions.agentType` required at the TypeScript boundary is a 1-line type change. Migration cost confirmed minimal (3 callers, all already pass it). Risk: a forgotten dispatch path outside the grepped set. Mitigation: TypeScript will refuse to compile if any caller is missed.

---

## Open Questions — Closed

1. **`CommitCoordinator.schedule()` async vs sync** → **CLOSED.** Synchronous. Async deferred to `flushAll()` only, called once at turn end by the existing async owner. `process()` and `handleOrchestratorEvent` remain synchronous. Rationale: eliminates async propagation through 1,005-line `stream-renderer.test.ts` and 3 construction sites; eliminates the promise-drop risk in the event loop. (Resolved per `/devils-advocate` architect critique.)

2. **External readers of `source.stats.toolUses`** → **CLOSED.** Grepped — 4 readers, all safe. See 2c External readers audit table.

3. **`forkSubagent.agentType` required vs. optional** → **CLOSED.** Required. Migration cost minimal (3 callers, all already pass it). Type-system enforcement is the strongest invariant guard.

4. **`StreamRenderer` lifetime — singleton vs. per-turn** → **CLOSED.** Per-turn. 3 construction sites confirmed at `turn-handler.ts:76`, `builtin-skills.ts:36`, `init.ts:80`. `CommitCoordinator` instance lifetime aligns naturally; no reset needed.

5. **Snapshot test strategy** → **CLOSED.** `toMatchSnapshot()` for representative `tool-lane-render.ts` outputs, PLUS retained existing string-content assertions. Captured in the Phase 1 commit before any source edits.

---

## Commit Sequence Summary

```
[Phase 1] test: Phase 1 failing tests — rendering bugs #1–#5 + snapshot pins (RED)
[2a]      refactor(renderer): introduce CommitCoordinator; serialize scrollback writes; apply committing guard
[2b]      refactor(renderer): extract declarative assignConnectors; fix Bug #5 overflow connector
[2c]      refactor(renderer): unify tool-use counter; isolate progress-event field
[2d]      fix(agent): propagate agentType at raw agent dispatch site; make field required
[2e]      refactor(renderer): bounded stalled lifecycle; replace checkPauseAnnotations
[2f]      fix(renderer): hygiene — spinner events, SIGINT routing, markdown wrap, logUpdate.done
```

Each commit: `pnpm test` green before proceeding to next.

---

## Epistemic Confidence

**High confidence**:
- Root-cause collapse (5 bugs → 3 root causes): affirmed directly from `docs/rendering-architecture-current.md` with file:line citations.
- stash@{11} `committing` guard: hunk is directly visible in `git stash show -p stash@{11}`; purpose clear from the diff.
- Bug #5 fix (`assignConnectors`): current code at `tool-lane-render.ts:343–345` appends `agentResultSummary` after `renderFlushChildren` returns — directly observable. Fix is mechanical.
- Bug #2 fix: `subagent-executor.ts:269–274` is the only `forkSubagent` call without `agentType` — verified by grepping all callers.
- Bug #4 fix: `stream-renderer-subagent.ts:156` blind-replaces `source.stats.toolUses` — directly observable. External readers audited and safe.
- `StreamRenderer` per-turn lifetime: confirmed by greping 3 construction sites.
- `agentType` required-field migration cost: confirmed by greping all `forkSubagent` callers.

**Medium confidence**:
- `CommitCoordinator` turn-end async owner: the sync-schedule design assumes a single clean async owner exists at turn end. Pre-2a audit will confirm. If the audit surfaces a messier path, the design may need adjustment — but the worst case is "find or create the async owner," not "abandon the sync-schedule design."
- stash@{6} hygiene hunks: well-scoped individually. The markdown wrap-before-indent change is a correctness fix with a test, but edge cases (very wide content, multi-line markdown blocks) were not fully characterized.

**Coverage gaps**:
- `terminal-compositor.ts` location: `src/cli/terminal-compositor.ts` (not `_lib/`). Verified.
- Phase 3 manual repro baseline screenshot: must be taken at the Phase 1 commit (before any source edits) on a real `afk` run. No pre-refactor screenshot available in this session.

**Human judgment required (remaining)**:
- Whether the 40-char prompt-hint fallback for raw `agent` tools (2d) is the right UX or whether a different default label is preferred. Default proposed; flag for user review during 2d implementation.
