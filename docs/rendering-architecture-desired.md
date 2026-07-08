# Rendering Architecture — Desired State

> **SUPERSEDED (2026-07-02).** All five root-cause fixes this target model
> called for have landed (checkpoints 2a–2e; see `commit-coordinator.ts`,
> `stream-renderer-lifecycle.ts:169-207`, `stream-renderer-source.ts:37`,
> `tool-lane-render-grouping.ts:54-79`). Two items were deliberately built
> differently and are NOT gaps: the entry state machine exists as enforced
> field-mutation invariants rather than a formal enum type, and the property
> tests are bounded hand-rolled loops (n≤30), not fast-check generators. Do
> not implement against this doc. For the resize/reflow layer added 2026-07,
> see `docs/tui-resize-reflow.md`.

> Phase 0 target model. Addresses every "Required properties" bullet from the handoff brief.

---

## 1. Entry-Lifecycle State Machine

Each tool-lane entry owns an explicit state. No entry can skip a state; no consumer can drive a transition it doesn't own.

```
            addStart / addStartWithAgentContext
                         │
                         ▼
                     PENDING
              (buffered in overlay only)
                         │
              first meaningful child event
              OR result arrives immediately
                         │
                         ▼
                    IN_FLIGHT
              (overlay: spinning verb)
                         │
                    addResult()
                         │
                         ▼
                     SETTLED
           (overlay: result, waiting to commit)
                         │
              CommitCoordinator.schedule()
              ordering constraint satisfied
                         │
                         ▼
                    COMMITTED
              (in scrollback, removed from lane)
```

Special paths:
- **Synthetic Agent entries** transition PENDING → IN_FLIGHT on first child event; SETTLED when `finalizeSubagent` sets the result summary; COMMITTED when `CommitCoordinator` flushes the group.
- **Pause/stalled**: IN_FLIGHT entries that exceed `PAUSE_THRESHOLD_MS` without a child event transition to a `STALLED` sub-state after K = 375 ticks (375 × 80 ms = 30 s). After K more ticks (60 s total), the entry auto-settles with a `[no-result]` synthetic result and transitions to SETTLED → COMMITTED. This bounds the tick loop; `checkPauseAnnotations` becomes `checkStalledEntries` and the only exit is the auto-settle, not `source.done`.

**Ownership**: `ToolLane` owns the per-entry state machine. `CommitCoordinator` drives SETTLED → COMMITTED transitions. `StreamRenderer` drives IN_FLIGHT → SETTLED via `addResult`.

### Transition Table

| From | To | Guard | Actor |
|------|----|-------|-------|
| — | PENDING | none | `addStart` / `addStartWithAgentContext` |
| PENDING | IN_FLIGHT | first child event OR immediate result | `addResult` / first child `addStart` |
| IN_FLIGHT | SETTLED | `addResult` called | `StreamRenderer` handlers |
| IN_FLIGHT | STALLED | elapsed ≥ K × 80 ms without event | `checkStalledEntries` tick |
| STALLED | SETTLED | elapsed ≥ 2K × 80 ms (auto) | `checkStalledEntries` tick |
| SETTLED | COMMITTED | ordering constraint satisfied | `CommitCoordinator` |

---

## 2. Single Ordering Authority

**Location**: `src/cli/_lib/commit-coordinator.ts` (new file). Owned by `StreamRenderer`; one instance per turn.

**API**:
```typescript
interface CommitCoordinator {
  // Register a settled batch for deferred commit.
  // Returns a promise that resolves when the batch is committed to scrollback.
  schedule(batch: CommitBatch): void;
  // Force-flush all settled batches (called on dispose / finalizeOrchestrator).
  flushAll(): void;
}

interface CommitBatch {
  /** Ordering anchor: 'before-content' | 'after-content' | 'after-subagent:<id>' */
  anchor: CommitAnchor;
  lines: string[];
}
```

**How producers request commits**:
- **Main-session tools** (root tool entries): anchor = `'before-content'`. `CommitCoordinator` holds these until the next `before-content` anchor or `finalizeOrchestrator`, then emits them above the streaming markdown.
- **Subagent results**: anchor = `'after-subagent:<sourceId>'`. Emitted immediately when the subagent's `done` fires (no buffering needed — the subagent is complete).
- **Thinking summary, skill badge, panels**: anchor = `'after-content'`. Emitted after `streamingMarkdown.flush()` resolves.

**Bug #1 fix**: The async `void finalizeOrchestrator(...)` currently means the tool flush and the markdown flush race. Under the new model, `finalizeOrchestrator` is `await`-ed (or schedules through `CommitCoordinator` synchronously), and `CommitCoordinator.flushAll()` drains in anchor order: `before-content` batches → content → `after-content` batches. The skill block cannot land below the post-skill prose because the `before-content` batch is committed before `streamingMarkdown.flush()` is called.

---

## 3. Counter Unification

**Single canonical counter**: `source.stats.toolUses` counts only `tool_use_detail` events — one increment per event, both orchestrator and subagent paths.

**Progress event reconciliation**: `event.progress.toolUses` is a different quantity (SDK-reported usage, may count multi-turn iterations). It is stored as a **separate field** `source.stats.progressReportedToolUses` and never written to `toolUses`. The "footer" summary (`formatDoneSummary`) reads only `source.stats.toolUses`. The `agentResultSummary` rendered by `formatAgentSummary` (tool-lane-render.ts:311) reads `toolChildren.length`, which must equal `source.stats.toolUses` at commit time because the tool-lane entries are the ground truth.

**Invariant**: at the moment `formatAgentSummary` is called (SETTLED → COMMITTED), `entry.children.filter(c => c.kind === 'tool').length === source.stats.toolUses`. Enforced by the fact that every `tool_use_detail` event both increments the counter and creates an entry; the counter never resets mid-run.

---

## 4. Tree-Connector Contract

**Declarative rule** (single function, pure, property-tested):

```typescript
function assignConnectors(siblings: RenderableSibling[]): ConnectedSibling[] {
  // Rule: last visible child gets '└ ', all prior get '├ '.
  // Overflow ellipsis is a synthetic child that obeys the same rule.
  const withOverflow = addOverflowSynthetic(siblings); // no-op if ≤ MAX_VISIBLE_CHILDREN
  return withOverflow.map((item, i) => ({
    ...item,
    connector: i === withOverflow.length - 1 ? '└ ' : '├ ',
  }));
}
```

**Location**: `src/cli/commands/interactive/tool-lane-render.ts` (refactored into a standalone pure function). The `agentResultSummary` trailing line is added as a synthetic child **before** `assignConnectors` runs, so it always gets the correct `└` connector. This is the fix for Bug #5.

**Property test** (in `src/cli/commands/interactive/tool-lane.test.ts`):
- For any non-empty list of children, exactly one child has connector `└ ` and it is the last.
- For any list with overflow, the overflow line is the last child and has `└ `.
- No child after a `└ ` child exists (the invariant is total, not just for last).

---

## 5. agentType Propagation Invariant

**Invariant**: every subagent source that enters the renderer has `meta.agentType` set to a non-empty, human-readable string before the first event is processed.

**Enforcement by dispatch site**:

| Site | Current | Fix |
|------|---------|-----|
| `compose` tool | ✅ `agentType: \`${n.id} [k/N]\`` | No change |
| `skill` tool | ✅ via idPrefix fallback | No change |
| raw `agent` tool (`SubagentExecutor.execute`) | ❌ no `agentType` set | Add `agentType: parsed.id_prefix` (or the prompt's first 40 chars as a hint) to the `forkSubagent` call at subagent-executor.ts:269 |
| DAG nodes | ✅ `dag-subagent.ts:68` | No change |

**Renderer-side guard** (belt-and-suspenders): if `source.agentType` is undefined at `synthesizeAgentEntry` call time, use `idPrefix` — already present via `subagent.ts:258: effectiveAgentType ?? options.idPrefix`. The fix is at the call site so the label is meaningful, not generic.

---

## 6. Pause/Stalled Lifecycle

**Bounded tick count**: K = 375 ticks at 80 ms = 30 s until `STALLED`; 2K = 750 ticks = 60 s until auto-complete.

**Justification**: 30 s matches the existing `PAUSE_THRESHOLD_MS`. 60 s (2× threshold) is generous for legitimate long-running subagents. Auto-completing at 60 s with `[no-result — timed out]` is better than an infinite paused display. Any real done event before 60 s wins.

**Implementation**: `checkStalledEntries()` replaces `checkPauseAnnotations()`. Per source:
- Track `source.stalledTicks: number` (incremented each tick while elapsed > threshold).
- At `stalledTicks === K`: set `source.pauseAnnotation`, update label.
- At `stalledTicks === 2K`: call `toolLane.addResult(syntheticAgentToolUseId, syntheticResult('[no-result — timed out]', false))`, set `source.done = true`. This stops the tick (guard at line 345) and allows the entry to commit normally.

---

## What Stays the Same

- **Scrollback rendering API**: `commitAbove(line)` remains the write primitive. No change to `TerminalCompositor` or `log-update` ownership.
- **Non-TTY path**: `out.line(line)` fallback unchanged.
- **Subagent composing proxy** (`makeComposingProxy`): the `│ ` prefix and overlay layering stay; this is correct isolation.
- **`StreamingMarkdownRenderer`**: block-boundary detection, throttled repaint, and `commitPending()` semantics unchanged.
- **Snapshot-test pins**: `tool-lane-render.ts` outputs are snapshot-pinned before refactor (existing tests). Shape of rendered strings (`'  ✓ bash — 3 lines'`, `'  ├ read_file...'`) is backward-compatible.
- **`ToolLane.flush()` public API**: still returns `string[]`. Callers that call flush directly still work; `CommitCoordinator` wraps it, not replaces it.

---

## Root-Cause Map

Five bugs collapse to **three root causes** under the new model:

| Bug | Root Cause | New Property That Prevents It |
|-----|-----------|-------------------------------|
| #1 Skill block below prose | `finalizeOrchestrator` is `void`-ed; its async flush races with subagent `done` flush. Ordering is emergent. | **CommitCoordinator** with `before-content` anchor: tool batches are committed synchronously before `streamingMarkdown.flush()` is awaited. |
| #3 Stuck paused state | `source.done` never fires on abort/error races; tick loop runs indefinitely. | **Bounded stalled lifecycle**: tick loop auto-settles at 2K ticks regardless of `source.done`. |
| #2 Orphaned label | Raw `agent` dispatch omits `agentType`; renderer falls back to generic `idPrefix`. | **agentType invariant**: `SubagentExecutor` required to pass `agentType` to `forkSubagent`. |
| #4 Header/footer count disagree | `progress` events blind-replace the per-`tool_use_detail` counter. | **Counter unification**: `source.stats.toolUses` is increment-only; progress data is a separate field. |
| #5 Done after overflow | `agentResultSummary` added after `renderFlushChildren` returns; connector recalculation doesn't include it. | **Tree-connector contract**: result summary is a synthetic sibling passed to `assignConnectors` before rendering, not appended after. |

Root causes in 3 sentences: (1) Ordering bugs (#1, #3 partially) share the root that lifecycle transitions are implicit call-ordering, not a state machine — CommitCoordinator fixes this. (2) Counter bug (#4) is a dual-writer with incompatible semantics — unification fixes this. (3) Label and connector bugs (#2, #5) are call-site omissions — the invariant and declarative rule fix these.

---

## Non-Goals

- **Multi-turn REPL history rendering**: prior turns' scrollback is not re-rendered by this refactor.
- **Telegram / daemon rendering**: those paths use the non-TTY fallback (`out.line`); this refactor does not change their output.
- **Thinking-lane rendering**: `ThinkingLane.collapse()` and `thinkingMode` semantics are out of scope.
- **Provider event stream normalization**: `ProviderEvent` types and the stream-consumer are untouched.
- **Compose/DAG executor logic**: only the `agentType` pass-through at the fork site is touched; DAG execution is out of scope.
- **Performance**: no throughput optimizations. The tick interval stays 80 ms; the compositing proxy overhead is unchanged.
