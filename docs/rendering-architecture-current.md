# Rendering Architecture — Current State

> Phase 0 reconnaissance. All claims verified from source with file:line citations.

---

## 1. Tool-Lane Entry Lifecycle

Full trace from first event to scrollback commit for a **subagent** source:

1. **Subagent first event** → `StreamRenderer.process()` (stream-renderer.ts:219) creates a fresh `SourceState` via `freshSourceState(meta?.agentType)` (stream-renderer-source.ts:42).
2. `synthesizeAgentEntry(sourceId, source, ctx, parentSyntheticId)` called (stream-renderer.ts:266; stream-renderer-subagent.ts:123). Calls `toolLane.addStartWithAgentContext(syntheticId, 'Agent', '(${label})', agentContext)` (stream-renderer-subagent.ts:132). Entry is inserted into `entries` Map and `order` array (tool-lane.ts:86-88). `source.syntheticAgentToolUseId` = `'__synth_agent_${sourceId}'` (stream-renderer-subagent.ts:138).
3. **Subsequent `tool_use_detail` chunk** → `handleSubagentEvent` (stream-renderer-subagent.ts:161). `source.currentTextEntryId = undefined`. Calls `toolLane.addStartWithAgentContext(chunk.toolUseId, chunk.toolName, chunk.toolInput, parentId)` (stream-renderer-subagent.ts:168-174). `source.stats.toolUses += 1` (stream-renderer-subagent.ts:175). Overlay updated via `compositor.setOverlay(toolLane.getOverlay())` (stream-renderer-subagent.ts:177).
4. **`tool_result` chunk** → `toolLane.addResult(chunk.toolUseId, chunk)` (stream-renderer-subagent.ts:182). Sets `entry.result` on the matching `ToolEntry` (tool-lane.ts:117). Overlay refreshed (stream-renderer-subagent.ts:184).
5. **`done` event** → `source.done = true` (stream-renderer-subagent.ts:224). `finalizeSubagent()` called (stream-renderer-subagent.ts:226). `formatDoneSummary(source)` builds summary string. `toolLane.setAgentResultSummary(parentId, summary)` (stream-renderer-subagent.ts:293). `toolLane.addResult(parentId, syntheticResult(summary, false))` (stream-renderer-subagent.ts:294-297). Overlay updated (stream-renderer-subagent.ts:298-300).
6. **`done` event (back in process())** → `flushToolLaneToScrollback(orchestratorCtx)` called (stream-renderer.ts:285) **only when `isTTY`**. This calls `toolLane.flush()` (stream-renderer-orchestrator.ts:285).
7. **`flush()`** (tool-lane.ts:209) builds `childMap`, identifies root entries (no `agentContext`), iterates: Agent/nesting-tool entries with children → calls `formatAgentSummary(entry, children, childMap)` (tool-lane-render.ts:295); leaf entries → grouped into `renderGroupedRootTools`. Returns string lines. **Clears `entries`, `order`, `agentIdStack`** (tool-lane.ts:249-251).
8. **`commitAbove(line)`** (terminal-compositor.ts:235): clears the log-update region, writes the line + `\n` to stdout, repaints the fresh frame (compositor.ts:254-261).

For the **orchestrator** (`__main__`) source, the tool lifecycle differs: `addStartWithAgentContext` is called on `tool_use_detail` (stream-renderer-orchestrator.ts:94-99) with `agentContext = undefined`; `flushToolLaneToScrollback` fires on **every `content` chunk** when `streamingMarkdown.current` is non-null (stream-renderer-orchestrator.ts:142, option `afterContent: true`). Additionally, `finalizeOrchestrator` calls `flushToolLaneToScrollback(ctx, {afterContent: true})` on `done` (stream-renderer-orchestrator.ts:234).

---

## 2. `ToolLane.flush()` Invocation Table

| Site | File:Line | Trigger Condition | State Observed | State Mutated |
|------|-----------|-------------------|----------------|---------------|
| `flushToolLaneToScrollback` | stream-renderer-orchestrator.ts:285 | Called from (a) each `content` chunk when `streamingMarkdown.current` != null, (b) `finalizeOrchestrator` on `done`, (c) `emitPanel` | `hasPending()` | entries, order, agentIdStack cleared |
| `StreamRenderer.dispose()` | stream-renderer.ts:320 | `dispose()` called in finally; `hasPending()` true | all pending entries | entries, order, agentIdStack cleared |
| subagent `done` (TTY path) | stream-renderer.ts:285 | subagent's `done` event, isTTY=true | all pending entries at that moment | entries, order, agentIdStack cleared |

---

## 3. `compositor.commitAbove()` Invocation Table

| Site | File:Line | Trigger | State Observed |
|------|-----------|---------|----------------|
| `flushToolLaneToScrollback` (TTY path) | stream-renderer-orchestrator.ts:289 | flush lines after tool-lane flush | `lines[]` from flush() |
| `finalizeOrchestrator` — thinking summary | stream-renderer-orchestrator.ts:245 | `done` event, thinkingMode ≠ 'off' | `thinkingLane.collapse()` |
| `emitPanel` (orchestrator) | stream-renderer-orchestrator.ts:209 | `panel` event | rendered card lines |
| `emitSubagentPanel` | stream-renderer-subagent.ts:266 | subagent `panel` event | rendered card lines |
| `emitSubagentTextLines` | stream-renderer-subagent.ts:46 | subagent content lines (non-markdown renderer path) | formatted `│ ` lines |
| Skill badge emit | stream-renderer-orchestrator.ts:122 | first skill tag extracted from content | badge string |
| `StreamRenderer.dispose()` (TTY) | stream-renderer.ts:323 | dispose with pending tool entries | flush lines |
| `StreamingMarkdownRenderer.commitBlock()` | markdown-stream.ts:191 | block boundary detected in buffer | rendered markdown block |

---

## 4. `source.stats.toolUses` Writers

| Site | File:Line | Semantics |
|------|-----------|-----------|
| `handleOrchestratorEvent` on `tool_use_detail` | stream-renderer-orchestrator.ts:100 | **increment by 1** per event |
| `handleSubagentEvent` on `tool_use_detail` | stream-renderer-subagent.ts:175 | **increment by 1** per event |
| `handleSubagentEvent` on `progress` event | stream-renderer-subagent.ts:156 | **blind replace**: `source.stats.toolUses = event.progress.toolUses` — overwrites the increment-based counter with whatever the progress event reports |

**The conflict**: `progress` events arrive mid-run from `SubagentHandle.streamToFinalMessage` forwarding the SDK's progress events. If `event.progress.toolUses` counts *iterations* (multi-turn) rather than distinct tool invocations, it overwrites the per-`tool_use_detail` counter, producing the header vs. footer discrepancy (Bug #4).

---

## 5. `source.done` / `source.errored` Writers

| Flag | Site | File:Line | Path where it can fail to fire |
|------|------|-----------|-------------------------------|
| `source.done = true` | orchestrator `done` case | stream-renderer-orchestrator.ts:170 | Always fires if SDK emits `done` |
| `source.done = true` | subagent `done` case | stream-renderer-subagent.ts:224 | **Can fail**: if `flush()` has already cleared `entries` (concurrent flush from another `done`), the entry is gone from the lane but `source.done` still sets. The `pauseTickInterval` only stops when `source.done || source.errored` (stream-renderer.ts:345). If the source is evicted from `this.sources` — which never happens (Map is never cleared) — it would stick. The real risk: if the `done` event is never emitted (SDK error, abort race), `source.done` is never set, and `checkPauseAnnotations` ticks forever. |
| `source.errored = true` | orchestrator `error` case | stream-renderer-orchestrator.ts:165 | Always fires if SDK emits `error` |
| `source.errored = true` | subagent `error` case | stream-renderer-subagent.ts:213 | Same abort-race risk as `done` |

---

## 6. `streamingMarkdown.current` Lifetime

1. **Set**: `streamingMarkdown.current = new StreamingMarkdownRenderer(...)` (stream-renderer-orchestrator.ts:144) on the first `content` chunk for the orchestrator source, **after** `flushToolLaneToScrollback(ctx, {afterContent: !!ctx.streamingMarkdown.current})` is called (line 142). On the very first content chunk `streamingMarkdown.current` is `null`, so `afterContent = false`, meaning no leading blank line is emitted before the tool-lane flush.

2. **`afterContent` flag interaction**: `flushToolLaneToScrollback` is called at line 142 with `afterContent: !!ctx.streamingMarkdown.current`. When this is `true` (a second content block arrives after markdown is already live), `compositor.commitAbove('')` is emitted before and after the tool lines (stream-renderer-orchestrator.ts:288, 290). When `false` (first content), only the trailing blank is emitted.

3. **Cleared**: 
   - `finalizeOrchestrator` on `done`: `flush()` + `dispose()` + `current = null` (stream-renderer-orchestrator.ts:226-228).
   - `StreamRenderer.dispose()`: `flush()` + `dispose()` + `current = null` (stream-renderer.ts:301-307).
   - `commitPending()` (called on `tool_use_detail` or `tool_result`): does NOT clear `current`; only commits the buffer and clears the overlay (markdown-stream.ts:362-369).

4. **Ordering**: The flush happens **before** new content commits to `streamingMarkdown`. At line 142, the tool-lane is flushed to scrollback; at line 144, `streamingMarkdown.current` is created (or already exists); at line 148, `push(cleaned)` delivers the new content. This means tool entries preceding a content block should appear above the content in scrollback — yet Bug #1 shows the opposite. The likely cause: `finalizeOrchestrator`'s `flushToolLaneToScrollback(ctx, {afterContent: true})` at line 234 fires on the `done` event, which is `void`-ed (line 172: `void finalizeOrchestrator(...)`). The async markdown `flush()` at line 226 and the synchronous `flushToolLaneToScrollback` at line 234 are ordered correctly *within* `finalizeOrchestrator`, but they occur **after** any subagent `done` event's flush (line 285 in stream-renderer.ts). If the skill subagent's `done` fires concurrently and triggers its own flush first, the ordering is inverted.

---

## 7. agentType Propagation Paths

| Dispatch path | agentType set? | Where |
|---------------|----------------|-------|
| `compose` tool | ✅ | compose-executor.ts:231: `agentType: \`${n.id} [${i+1}/${totalNodes}]\`` |
| `skill` tool | ✅ (via idPrefix) | skill-executor.ts:303: `idPrefix: 'skill-${skillName}'`; `forkSubagent` uses `effectiveAgentType ?? options.idPrefix` (subagent.ts:258) |
| raw `agent` tool | ❌ **MISSING** | subagent-executor.ts:269-274: `forkSubagent` called with `idPrefix: parsed.id_prefix` but **no `agentType`**. Result: `effectiveAgentType` is `undefined`, falls back to `idPrefix` which defaults to `'agent-tool'` — a generic non-human label. The rendered label becomes `Agent(agent-tool)` or `Agent(subagent-tool-TIMESTAMP-N)`. |

The renderer reads `source.agentType ?? sourceId` (stream-renderer.ts:278, 348; stream-renderer-subagent.ts:131). For raw `agent` calls, `agentType` is propagated as `idPrefix` via `subagent.ts:258`, which is `'agent-tool'` unless the tool input supplies `id_prefix`. The label shown is `Agent(agent-tool)` — not an orphan `→ agent [subagent]`, but a mis-labeled entry. Bug #2's "orphaned `→ agent`" may refer to the tool-lane entry for the `agent` tool call itself (showing as `● agent(...)`) appearing without a nested `Agent(label)` entry, which happens when `parentId` resolution falls to Path 3 (unresolved) in stream-renderer.ts:258-264 and the synthesized entry renders at root as a top-level sibling rather than a nested child.

---

## 8. Pause-Annotation Tick Loop

- **Entry**: `setInterval(() => this.checkPauseAnnotations(), 80)` created in `arm()` (stream-renderer.ts:167). Runs every 80 ms while compositor is armed.
- **Per-tick logic** (stream-renderer.ts:340-362): For each source in `this.sources`, skip if `source.done || source.errored || !source.syntheticAgentToolUseId`. Compute `elapsed = now - source.lastEventAt`. If `elapsed > PAUSE_THRESHOLD_MS` (30 000 ms), format a new annotation string. If it differs from `source.pauseAnnotation`, update and call `addStartWithAgentContext` to mutate the existing entry's prefix in-place (tool-lane.ts:71-75).
- **Exit**: `clearInterval` in `dispose()` (stream-renderer.ts:329). Also, on any new event for the source, `source.lastEventAt = Date.now()` resets staleness and clears the annotation (stream-renderer.ts:275-282).
- **`source.done` drives loop exit**: If neither `done` nor `errored` ever fires for a source (e.g. aborted without a terminal event, or a subagent whose `done` gets dropped in an error path), `source.done` stays `false` indefinitely. The tick loop runs until `dispose()` is called — which only happens when the entire renderer is torn down. This is the mechanism for Bug #3.
