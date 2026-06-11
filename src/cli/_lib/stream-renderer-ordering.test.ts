/**
 * stream-renderer-ordering.test.ts — Phase 1 failing tests for rendering bugs #1–#3
 *
 * Three tests, each expected to FAIL on current code for the BUG REASON.
 * They will turn green in checkpoints 2a (Bug #1), 2d (Bug #2), and 2e (Bug #3).
 *
 * Bug numbering matches the spec:
 *   #1 – skill block ordering: void finalizeOrchestrator async race
 *   #2 – orphaned agent label: agentType omitted at SubagentExecutor dispatch callsite
 *   #3 – stuck paused state: checkPauseAnnotations runs forever — no bounded exit
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Writer } from '../slash/types.js';
import type {
  OutputEvent,
  SubagentProgressMeta,
} from '../../agent/types.js';
import type { ResponseMetadata } from '../../agent/types/message-types.js';

// ─── shared helpers ──────────────────────────────────────────────────────────

function makeWriter(): { writer: Writer; lines: string[] } {
  const lines: string[] = [];
  const writer: Writer = {
    line(text = '') { lines.push(text); },
    raw(text)       { lines.push(text); },
    success(text)   { lines.push('SUCCESS:' + text); },
    info(text)      { lines.push('INFO:' + text); },
    warn(text)      { lines.push('WARN:' + text); },
    error(text)     { lines.push('ERROR:' + text); },
  };
  return { writer, lines };
}

function contentEvent(chunk: string): OutputEvent {
  return { type: 'chunk', chunk: { type: 'content', content: chunk } };
}

function toolStartEvent(id: string, name: string, input: string): OutputEvent {
  return {
    type: 'chunk',
    chunk: { type: 'tool_use_detail', toolUseId: id, toolName: name, toolInput: input },
  };
}

function toolResultEvent(id: string, content: string): OutputEvent {
  return {
    type: 'chunk',
    chunk: { type: 'tool_result', toolUseId: id, content, isError: false },
  };
}

function doneEvent(metadata?: ResponseMetadata): OutputEvent {
  return metadata !== undefined ? { type: 'done', metadata } : { type: 'done' };
}

function meta(subagentId: string, agentType?: string): SubagentProgressMeta {
  return agentType !== undefined ? { subagentId, agentType } : { subagentId };
}

// ─── Bug #1 — skill block ordering: void finalizeOrchestrator async race ─────
//
// Root cause: stream-renderer-orchestrator.ts:172 fires `void finalizeOrchestrator()`
// (fire-and-forget). The function contains `await streamingMarkdown.flush()`, which
// yields the event loop. Any synchronous work that happens while finalizeOrchestrator
// is yielded (e.g., another subagent's done-event flush) races with the markdown flush.
//
// Observable symptom: main-session content that arrived BEFORE a skill tool dispatch
// ends up in scrollback AFTER the skill block, because:
//   (a) content is buffered in the markdown renderer (not flushed to scrollback at
//       tool_use_detail time — commitPending() moves content to "committed-in-overlay"
//       state, but does NOT call compositor.commitAbove)
//   (b) flushToolLaneToScrollback (subagent done, synchronous) commits the skill block
//       to scrollback
//   (c) finalizeOrchestrator's await flush() runs async/void after the event loop
//       yields, committing the content AFTER the skill block — wrong order
//
// Test design:
//   - Uses vi.useFakeTimers() to isolate the event loop and prevent any real
//     setInterval/setTimeout from interfering with commit ordering
//   - Uses a fake markdown renderer with a deferred flush Promise to give us precise
//     control over when the async markdown flush lands in scrollback. This reproduces
//     the `void finalizeOrchestrator` race: synchronous tool-lane flush happens before
//     the deferred markdown flush resolves
//   - Uses a real TerminalCompositor stub that records commitAbove call order
//   - Asserts: skill block lines appear BEFORE post-skill content lines in commitAbove
//     call order — the ordering invariant that the race currently violates
//
// WHY THIS TEST MUST FAIL ON CURRENT CODE:
//   Step-by-step on current code:
//     1. process(contentEvent) → markdown.push('pre-skill content')
//        commitAboveCalls = []
//     2. process(toolStartEvent) → markdown.commitPending() [NO commitAbove call]
//        toolLane gets skill entry
//     3. process(subagent done) → flushToolLaneToScrollback runs synchronously
//        commitAboveCalls = ['', '<skill block line>', '']  (leading/trailing blank from afterContent)
//     4. process(orchestrator done) → void finalizeOrchestrator starts
//        finalizeOrchestrator awaits markdown.flush()
//        → flush() is deferred → control returns to test
//     5. We resolve flushResolve() → flush() calls commitAbove('[md:pre-skill content]')
//        commitAboveCalls = ['', '<skill block line>', '', '[md:pre-skill content]']
//
//   Result: mdIdx > skillIdx — WRONG ORDER. Test assertion (mdIdx < skillIdx) FAILS.
//
//   After fix (CommitCoordinator serializes writes):
//     CommitCoordinator.flushAll() drains before-content batches first, then content,
//     so pre-skill content arrives in scrollback BEFORE the skill block.

describe('Bug #1 — void finalizeOrchestrator race: skill block ordering', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('skill block must appear AFTER pre-skill content in scrollback (drives real StreamRenderer.process() subagent-done path)', async () => {
    // H1 (shadow-verified): the prior version of this test manually called
    // coordinator.schedule(...) at step 3, bypassing the production subagent-
    // done handler in stream-renderer.ts. That made the test green on both
    // pre-fix code (synchronous flushToolLaneToScrollback) and post-fix code,
    // because the race the fix addresses was never triggered.
    //
    // This rewrite drives a real subagent-done event through r.process(),
    // which hits the production branch at stream-renderer.ts:304-329:
    //
    //   if (event.type === 'done' && this.isTTY) {
    //     ...
    //     this.coordinator.schedule({ anchor: `after-subagent:${sourceId}`, ... });
    //   }
    //
    // To exercise this branch in a vitest environment (where process.stdout.isTTY
    // is normally undefined), we force `this.isTTY = true` and inject a recording
    // compositor + a deferred-flush markdown renderer via private-field access.
    // This is the same private-access pattern already used elsewhere in this file
    // (see the Bug #3 tests that bracket-access `r.sources`).
    //
    // Pre-fix failure mode this test must catch: if the subagent-done branch
    // called flushToolLaneToScrollback(orchestratorCtx) synchronously instead of
    // coordinator.schedule(...), the skill block would land in commitAboveCalls
    // at step 3 (BEFORE the deferred markdown flush resolves), inverting the
    // assertion order.

    vi.useFakeTimers();

    const { StreamRenderer } = await import('./stream-renderer.js');

    const commitAboveCalls: string[] = [];
    // Recording compositor stub — captures all commitAbove() invocations in
    // call order. Provides only the methods the renderer actually uses.
    const recordingCompositor = {
      setOverlay: (_text: string) => {},
      commitAbove: (text: string) => { commitAboveCalls.push(text); },
      setSpinner: (_config: { enabled: boolean; rotateVerbEveryMs?: number }) => {},
      arm: async () => {},
      disarm: () => {},
      getBuffer: () => ({ text: '', queued: false }),
      isArmed: () => true,
    };

    // Deferred markdown renderer — simulates StreamingMarkdownRenderer where
    // flush() is async and we control exactly when it resolves. This is what
    // creates the race window: between the synchronous subagent-done event
    // and the async markdown drain.
    let flushResolve!: () => void;
    const flushPromise = new Promise<void>((r) => { flushResolve = r; });
    let pendingBuffer = '';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakeMarkdownRenderer: any = {
      // Mirror the real StreamingMarkdownRenderer.commitPending semantics:
      // it synchronously flushes the entire pending buffer to scrollback via
      // compositor.commitAbove (markdown-stream.ts:191 — commitBlock writes
      // the buffer including partial blocks). The post-fix subagent-done
      // handler relies on this synchronous flush to land prose BEFORE the
      // subagent block in scrollback order.
      commitPending: () => {
        if (pendingBuffer.trim()) {
          recordingCompositor.commitAbove('[md:' + pendingBuffer.trim() + ']');
          pendingBuffer = '';
        }
      },
      push: (text: string) => { pendingBuffer += text; },
      flush: async () => {
        await flushPromise;
        if (pendingBuffer.trim()) {
          recordingCompositor.commitAbove('[md:' + pendingBuffer.trim() + ']');
          pendingBuffer = '';
        }
      },
      dispose: () => {},
      // hasEmitted returns true here because prose has already started flowing
      // (pre-skill narration was pushed). Retained for tests that still gate
      // on this; the post-fix renderer no longer reads it on the done path.
      hasEmitted: () => true,
    };

    const { writer } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });

    // Force TTY mode and inject the fakes. forceNonTty:true above prevents
    // arm() from constructing a real TerminalCompositor; we replace the null
    // compositor with our recording stub here.
    type PrivateRenderer = {
      isTTY: boolean;
      compositor: typeof recordingCompositor;
      streamingMarkdownRef: { current: typeof fakeMarkdownRenderer };
    };
    const privateR = r as unknown as PrivateRenderer;
    privateR.isTTY = true;
    privateR.compositor = recordingCompositor;
    privateR.streamingMarkdownRef.current = fakeMarkdownRenderer;

    // ── Step 1: orchestrator emits pre-skill content via r.process(). ─────────
    // No meta → routed to handleOrchestratorEvent → markdown.push().
    // commitAboveCalls = [] after this step (markdown content is buffered).
    r.process(contentEvent('pre-skill narration text'));

    // ── Step 2: orchestrator dispatches a skill subagent (tool_use_detail). ──
    // Routed to handleOrchestratorEvent → commitPending() (no commitAbove) +
    // adds entry to toolLane.
    r.process(toolStartEvent('skill-tu-1', 'Agent', '(review)'));

    // ── Step 3: subagent activity arrives WITH meta(sourceId). Routed via the
    //    NON-orchestrator branch — handleSubagentEvent path. We send a
    //    tool_use_detail (so the subagent source registers and toolLane has
    //    pending entries) followed by a done event with the same meta.
    r.process(
      toolStartEvent('skill-inner-t1', 'Read', '("file.ts")'),
      meta('skill-tu-1', 'review'),
    );
    r.process(
      toolResultEvent('skill-inner-t1', 'inner tool done'),
      meta('skill-tu-1', 'review'),
    );

    // The CRITICAL step: subagent done event. This hits the production
    // branch at stream-renderer.ts — `if (event.type === 'done' && this.isTTY)`.
    //
    // Post-fix behavior (chronological interleave): the handler calls
    //   streamingMarkdown.commitPending() — flushes pending prose synchronously
    //   coordinator.drainSubagent(sourceId) — commits the subagent block
    // So at this point commitAboveCalls already contains pre-skill prose
    // followed by the subagent block, in event-timeline order.
    r.process(doneEvent(), meta('skill-tu-1', 'review'));

    // ── Step 4: orchestrator done — schedules tool-lane drain via coordinator.
    r.process(doneEvent());

    // ── Step 5: dispose() drains anything still pending. flushAll suspends at
    //    `await streamingMarkdownFlush()` which is blocked on flushPromise.
    const disposePromise = r.dispose();

    // Drain microtasks; flushAll is still suspended at markdown await.
    await Promise.resolve();
    await Promise.resolve();

    // ── Step 6: resolve the deferred flush. ──────────────────────────────────
    flushResolve();
    await disposePromise;

    // ── Assertions ────────────────────────────────────────────────────────────
    const preSkillIdx = commitAboveCalls.findIndex((c) => c.includes('pre-skill narration'));
    // Search for the subagent's inner tool result — this is the content that
    // must appear AFTER pre-skill prose (because it happened AFTER in the
    // event timeline). The orchestrator's root Agent(review) dispatch entry
    // correctly appears in before-content since it was dispatched before the
    // content in event order.
    const subagentResultIdx = commitAboveCalls.findIndex((c) => c.includes('Read'));

    expect(preSkillIdx, 'pre-skill content must appear in scrollback').toBeGreaterThanOrEqual(0);
    expect(subagentResultIdx, 'subagent result must appear in scrollback').toBeGreaterThanOrEqual(0);

    // Bug #1 fix invariant (preserved under chronological-interleave fix):
    // prose that arrived BEFORE the subagent done-event must land BEFORE the
    // subagent block in scrollback. The mechanism changed (commitPending now
    // flushes synchronously on done, instead of deferring to flushAll), but
    // the user-visible ordering invariant is identical.
    expect(preSkillIdx).toBeLessThan(subagentResultIdx);
  });
});

// ─── Eager drain — subagent done commits immediately when no markdown ────────
//
// Companion to Bug #1: when no orchestrator markdown is pending (the skill-
// handler case), the subagent done-event should commit to scrollback immediately
// via drainSubagent() rather than deferring to dispose(). This is the fix for
// the "entries pile up at the bottom" visual bug.

describe('Eager drain — subagent done commits immediately when no markdown', () => {
  it('subagent result lands in scrollback on done-event (not deferred to dispose)', async () => {
    const { StreamRenderer } = await import('./stream-renderer.js');

    const commitAboveCalls: string[] = [];
    const recordingCompositor = {
      setOverlay: (_text: string) => {},
      commitAbove: (text: string) => { commitAboveCalls.push(text); },
      setSpinner: (_config: { enabled: boolean; rotateVerbEveryMs?: number }) => {},
      arm: async () => {},
      disarm: () => {},
      getBuffer: () => ({ text: '', queued: false }),
      isArmed: () => true,
    };

    const { writer } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });

    type PrivateRenderer = {
      isTTY: boolean;
      compositor: typeof recordingCompositor;
      streamingMarkdownRef: { current: null };
    };
    const privateR = r as unknown as PrivateRenderer;
    privateR.isTTY = true;
    privateR.compositor = recordingCompositor;
    // No markdown renderer — simulates the skill-handler case where the
    // orchestrator has not emitted content between sub-agent phases.
    privateR.streamingMarkdownRef.current = null;

    // Subagent registers with a tool call
    r.process(
      toolStartEvent('inner-t1', 'Read', '("file.ts")'),
      meta('sa-1', 'mint-research'),
    );
    r.process(
      toolResultEvent('inner-t1', 'file contents'),
      meta('sa-1', 'mint-research'),
    );

    // Subagent done — should commit immediately via drainSubagent
    r.process(doneEvent(), meta('sa-1', 'mint-research'));

    // Entries should already be in scrollback (not deferred to dispose)
    expect(
      commitAboveCalls.length,
      'subagent result must be committed eagerly on done-event when no markdown',
    ).toBeGreaterThan(0);

    const joined = commitAboveCalls.join('\n');
    expect(joined).toContain('mint-research');

    await r.dispose();
  });
});

// ─── Chronological subagent done-block placement ─────────────────────────────
//
// Specification (post chronological-interleave fix): the subagent done-event
// path always commits the done-block eagerly so Agent(...) entries land in
// scrollback at the event-timeline position where the subagent finished,
// not at the end of the turn.
//
// Bug #1 ordering invariant (prose-before-subagent-block) is preserved
// because the handler synchronously calls
// streamingMarkdownRef.current.commitPending() before drainSubagent().
// commitPending writes any pending buffer to scrollback via compositor.commitAbove,
// so prose generated before the done-event lands above the Agent(...) block.
//
//   (A) No renderer / pre-prose: nothing to flush — Agent block commits immediately.
//   (B) Post-prose: commitPending() flushes pending prose first, then the
//       Agent block commits — both lands in scrollback at the done-event
//       timeline position, in the correct relative order.

describe('Chronological subagent done-block placement', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('Case A — pre-prose: done-block committed eagerly when renderer exists but hasEmitted()===false', async () => {
    vi.useFakeTimers();

    const { StreamRenderer } = await import('./stream-renderer.js');

    const commitAboveCalls: string[] = [];
    const recordingCompositor = {
      setOverlay: (_text: string) => {},
      commitAbove: (text: string) => { commitAboveCalls.push(text); },
      setSpinner: (_config: { enabled: boolean; rotateVerbEveryMs?: number }) => {},
      arm: async () => {},
      disarm: () => {},
      getBuffer: () => ({ text: '', queued: false }),
      isArmed: () => true,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakeMarkdownRenderer: any = {
      commitPending: () => {},
      push: () => {},
      flush: async () => {},
      dispose: () => {},
      // Key: hasEmitted()===false simulates a renderer that was created but
      // has not yet received any content — the pre-prose window.
      hasEmitted: () => false,
    };

    const { writer } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });

    type PrivateRenderer = {
      isTTY: boolean;
      compositor: typeof recordingCompositor;
      streamingMarkdownRef: { current: typeof fakeMarkdownRenderer };
    };
    const privateR = r as unknown as PrivateRenderer;
    privateR.isTTY = true;
    privateR.compositor = recordingCompositor;
    privateR.streamingMarkdownRef.current = fakeMarkdownRenderer;

    // Subagent registers and completes
    r.process(
      toolStartEvent('inner-t1', 'Read', '("file.ts")'),
      meta('sa-pre', 'pre-prose-agent'),
    );
    r.process(
      toolResultEvent('inner-t1', 'file contents'),
      meta('sa-pre', 'pre-prose-agent'),
    );

    // Done-event: renderer exists but hasEmitted()===false → eager path
    r.process(doneEvent(), meta('sa-pre', 'pre-prose-agent'));

    // Eager path: done-block must already be in scrollback synchronously
    expect(
      commitAboveCalls.length,
      'done-block must be committed eagerly (pre-prose window) when hasEmitted()===false',
    ).toBeGreaterThan(0);

    await r.dispose();
  });

  it('Case B — post-prose: pending prose flushes then done-block commits at done-event (chronological interleave)', async () => {
    vi.useFakeTimers();

    const { StreamRenderer } = await import('./stream-renderer.js');

    const commitAboveCalls: string[] = [];
    const recordingCompositor = {
      setOverlay: (_text: string) => {},
      commitAbove: (text: string) => { commitAboveCalls.push(text); },
      setSpinner: (_config: { enabled: boolean; rotateVerbEveryMs?: number }) => {},
      arm: async () => {},
      disarm: () => {},
      getBuffer: () => ({ text: '', queued: false }),
      isArmed: () => true,
    };

    // Fake renderer that mirrors the real markdown-stream contract:
    // commitPending() synchronously writes any pending buffer to scrollback
    // via compositor.commitAbove (real impl: markdown-stream.ts:191).
    let pendingBuffer = '';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakeMarkdownRenderer: any = {
      commitPending: () => {
        if (pendingBuffer.trim()) {
          recordingCompositor.commitAbove('[md:' + pendingBuffer.trim() + ']');
          pendingBuffer = '';
        }
      },
      push: (text: string) => { pendingBuffer += text; },
      flush: async () => {
        if (pendingBuffer.trim()) {
          recordingCompositor.commitAbove('[md:' + pendingBuffer.trim() + ']');
          pendingBuffer = '';
        }
      },
      dispose: () => {},
      hasEmitted: () => true,
    };

    const { writer } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });

    type PrivateRenderer = {
      isTTY: boolean;
      compositor: typeof recordingCompositor;
      streamingMarkdownRef: { current: typeof fakeMarkdownRenderer };
    };
    const privateR = r as unknown as PrivateRenderer;
    privateR.isTTY = true;
    privateR.compositor = recordingCompositor;
    privateR.streamingMarkdownRef.current = fakeMarkdownRenderer;

    // Simulate prose-then-subagent timeline: push some markdown, then run a
    // subagent to completion. The done-event must flush the prose AND commit
    // the Agent block in scrollback, in that order, at the done-event point.
    privateR.streamingMarkdownRef.current.push('orchestrator prose A');

    r.process(
      toolStartEvent('inner-t2', 'Read', '("file.ts")'),
      meta('sa-post', 'post-prose-agent'),
    );
    r.process(
      toolResultEvent('inner-t2', 'file contents'),
      meta('sa-post', 'post-prose-agent'),
    );

    r.process(doneEvent(), meta('sa-post', 'post-prose-agent'));

    // Chronological-interleave invariant: by the time the subagent has fired
    // its done event, both prose-A and the Agent block are in scrollback,
    // with prose-A appearing first.
    const proseIdx = commitAboveCalls.findIndex((c) => c.includes('orchestrator prose A'));
    const agentIdx = commitAboveCalls.findIndex((c) => c.includes('post-prose-agent'));

    expect(proseIdx, 'orchestrator prose must be flushed eagerly on subagent-done').toBeGreaterThanOrEqual(0);
    expect(agentIdx, 'Agent block must be committed eagerly on subagent-done').toBeGreaterThanOrEqual(0);
    expect(proseIdx).toBeLessThan(agentIdx);

    await r.dispose();
  });

  // ── Multi-subagent end-to-end interleave ──────────────────────────────────
  //
  // The user-facing regression this fix addresses: two subagents finish in
  // sequence while orchestrator prose is also flowing. Without the fix, both
  // Agent(...) blocks pile up at the bottom of the turn (below all prose),
  // even though the events arrived interleaved. With the fix, each Agent
  // block lands at the event-timeline position where its done-event fired.
  it('multi-subagent: each Agent block lands at the event-timeline position of its done-event', async () => {
    vi.useFakeTimers();

    const { StreamRenderer } = await import('./stream-renderer.js');

    const commitAboveCalls: string[] = [];
    const recordingCompositor = {
      setOverlay: (_text: string) => {},
      commitAbove: (text: string) => { commitAboveCalls.push(text); },
      setSpinner: (_config: { enabled: boolean; rotateVerbEveryMs?: number }) => {},
      arm: async () => {},
      disarm: () => {},
      getBuffer: () => ({ text: '', queued: false }),
      isArmed: () => true,
    };

    let pendingBuffer = '';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakeMarkdownRenderer: any = {
      commitPending: () => {
        if (pendingBuffer.trim()) {
          recordingCompositor.commitAbove('[md:' + pendingBuffer.trim() + ']');
          pendingBuffer = '';
        }
      },
      push: (text: string) => { pendingBuffer += text; },
      flush: async () => {
        if (pendingBuffer.trim()) {
          recordingCompositor.commitAbove('[md:' + pendingBuffer.trim() + ']');
          pendingBuffer = '';
        }
      },
      dispose: () => {},
      hasEmitted: () => pendingBuffer.length > 0,
    };

    const { writer } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });

    type PrivateRenderer = {
      isTTY: boolean;
      compositor: typeof recordingCompositor;
      streamingMarkdownRef: { current: typeof fakeMarkdownRenderer };
    };
    const privateR = r as unknown as PrivateRenderer;
    privateR.isTTY = true;
    privateR.compositor = recordingCompositor;
    privateR.streamingMarkdownRef.current = fakeMarkdownRenderer;

    // Event timeline:
    //   prose-A → subagent-X done → prose-B → subagent-Y done → prose-C → orch done
    //
    // Expected scrollback order:
    //   prose-A, Agent(agent-X), prose-B, Agent(agent-Y), prose-C
    privateR.streamingMarkdownRef.current.push('prose-A');

    r.process(toolStartEvent('x-t1', 'Read', '("a.ts")'), meta('sa-x', 'agent-X'));
    r.process(toolResultEvent('x-t1', 'a-result'), meta('sa-x', 'agent-X'));
    r.process(doneEvent(), meta('sa-x', 'agent-X'));

    privateR.streamingMarkdownRef.current.push('prose-B');

    r.process(toolStartEvent('y-t1', 'Read', '("b.ts")'), meta('sa-y', 'agent-Y'));
    r.process(toolResultEvent('y-t1', 'b-result'), meta('sa-y', 'agent-Y'));
    r.process(doneEvent(), meta('sa-y', 'agent-Y'));

    privateR.streamingMarkdownRef.current.push('prose-C');

    r.process(doneEvent());
    await r.dispose();

    const idxProseA = commitAboveCalls.findIndex((c) => c.includes('prose-A'));
    const idxAgentX = commitAboveCalls.findIndex((c) => c.includes('agent-X'));
    const idxProseB = commitAboveCalls.findIndex((c) => c.includes('prose-B'));
    const idxAgentY = commitAboveCalls.findIndex((c) => c.includes('agent-Y'));
    const idxProseC = commitAboveCalls.findIndex((c) => c.includes('prose-C'));

    // All five must appear in scrollback.
    expect(idxProseA, 'prose-A in scrollback').toBeGreaterThanOrEqual(0);
    expect(idxAgentX, 'agent-X in scrollback').toBeGreaterThanOrEqual(0);
    expect(idxProseB, 'prose-B in scrollback').toBeGreaterThanOrEqual(0);
    expect(idxAgentY, 'agent-Y in scrollback').toBeGreaterThanOrEqual(0);
    expect(idxProseC, 'prose-C in scrollback').toBeGreaterThanOrEqual(0);

    // Chronological interleave: each event lands at its event-timeline position.
    expect(idxProseA).toBeLessThan(idxAgentX);
    expect(idxAgentX).toBeLessThan(idxProseB);
    expect(idxProseB).toBeLessThan(idxAgentY);
    expect(idxAgentY).toBeLessThan(idxProseC);
  });
});

// ─── Eager ancestor-header emission ─────────────────────────────────────────
//
// Bug fixed: "subagent rendered outside parent" — a /diagnose run dispatches
// two parallel subagents under a `skill` parent. Each subagent fires its
// done-event while the skill parent is still in-flight. Without eager-header
// emission, the skill frame header was only committed at dispose-time flush()
// — after both subagent blocks had been committed to scrollback. The header
// then appeared BELOW its children in append-only scrollback, visually
// detaching the skill frame from the agents it nominally contained.
//
// Fix: flushSource walks the ancestor chain and emits headers for any ancestor
// whose header has not yet been committed (entry.headerEmitted !== true).
// Those headers are prepended to the returned lines array, so the compositor
// commits them to scrollback BEFORE the child block.
//
// This test verifies the fix end-to-end through the StreamRenderer TTY path
// by injecting a recording compositor and asserting that the skill header
// appears in scrollback BEFORE the first subagent block.
describe('Eager ancestor-header emission — skill frame header precedes subagent blocks', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('skill header lands in scrollback BEFORE the first subagent done-block when both are inside a skill parent', async () => {
    vi.useFakeTimers();

    const { StreamRenderer } = await import('./stream-renderer.js');

    const commitAboveCalls: string[] = [];
    const recordingCompositor = {
      setOverlay: (_text: string) => {},
      commitAbove: (text: string) => { commitAboveCalls.push(text); },
      setSpinner: (_config: { enabled: boolean; rotateVerbEveryMs?: number }) => {},
      arm: async () => {},
      disarm: () => {},
      getBuffer: () => ({ text: '', queued: false }),
      isArmed: () => true,
    };

    const { writer } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });

    type PrivateRenderer = {
      isTTY: boolean;
      compositor: typeof recordingCompositor;
      streamingMarkdownRef: { current: null };
    };
    const privateR = r as unknown as PrivateRenderer;
    privateR.isTTY = true;
    privateR.compositor = recordingCompositor;
    privateR.streamingMarkdownRef.current = null;

    // Orchestrator dispatches a skill tool call (the parent frame).
    // The skill tool_use_detail goes to the orchestrator path.
    r.process(toolStartEvent('skill-tu-1', 'skill', '(diagnose)'));

    // Subagent-A registers under the skill tool call (compose-spawned path:
    // meta.parentId === 'skill-tu-1' which is a live ToolLane entry).
    r.process(
      toolStartEvent('sa-a-t1', 'Read', '("file-a.ts")'),
      { subagentId: 'sa-a', agentType: 'critic-pragmatist', parentId: 'skill-tu-1' },
    );
    r.process(
      toolResultEvent('sa-a-t1', 'file-a contents'),
      { subagentId: 'sa-a', agentType: 'critic-pragmatist', parentId: 'skill-tu-1' },
    );

    // Subagent-A done — triggers eager ancestor header emission.
    // The skill header (for 'skill-tu-1') must land in scrollback BEFORE
    // the subagent-A block.
    r.process(doneEvent(), { subagentId: 'sa-a', agentType: 'critic-pragmatist', parentId: 'skill-tu-1' });

    // Assert: skill header is already in scrollback after the first subagent done.
    const skillIdx = commitAboveCalls.findIndex((c) => c.includes('skill') || c.includes('diagnose'));
    const agentAIdx = commitAboveCalls.findIndex((c) => c.includes('critic-pragmatist') || c.includes('file-a'));

    expect(skillIdx, 'skill header must be committed to scrollback').toBeGreaterThanOrEqual(0);
    expect(agentAIdx, 'agent-A block must be committed to scrollback').toBeGreaterThanOrEqual(0);

    // The fix: skill header appears BEFORE subagent-A block in scrollback.
    // Pre-fix failure mode: skill header was only emitted at dispose-time
    // flush() — AFTER both subagent blocks — landing below its children.
    expect(skillIdx, 'skill header must precede subagent-A block').toBeLessThan(agentAIdx);

    await r.dispose();
  });

  it('skill header emitted only once even when two subagents complete under the same skill parent', async () => {
    vi.useFakeTimers();

    const { StreamRenderer } = await import('./stream-renderer.js');

    const commitAboveCalls: string[] = [];
    const recordingCompositor = {
      setOverlay: (_text: string) => {},
      commitAbove: (text: string) => { commitAboveCalls.push(text); },
      setSpinner: (_config: { enabled: boolean; rotateVerbEveryMs?: number }) => {},
      arm: async () => {},
      disarm: () => {},
      getBuffer: () => ({ text: '', queued: false }),
      isArmed: () => true,
    };

    const { writer } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });

    type PrivateRenderer = {
      isTTY: boolean;
      compositor: typeof recordingCompositor;
      streamingMarkdownRef: { current: null };
    };
    const privateR = r as unknown as PrivateRenderer;
    privateR.isTTY = true;
    privateR.compositor = recordingCompositor;
    privateR.streamingMarkdownRef.current = null;

    // Orchestrator dispatches a skill tool call.
    r.process(toolStartEvent('skill-tu-2', 'skill', '(diagnose)'));

    // Subagent-A under the skill.
    r.process(toolStartEvent('sa-a2-t1', 'Read', '("file-a.ts")'),
      { subagentId: 'sa-a2', agentType: 'critic-pragmatist', parentId: 'skill-tu-2' });
    r.process(toolResultEvent('sa-a2-t1', 'result-a'),
      { subagentId: 'sa-a2', agentType: 'critic-pragmatist', parentId: 'skill-tu-2' });
    // First subagent done → eagerly emits skill header.
    r.process(doneEvent(),
      { subagentId: 'sa-a2', agentType: 'critic-pragmatist', parentId: 'skill-tu-2' });

    // Subagent-B under the same skill.
    r.process(toolStartEvent('sa-b2-t1', 'Read', '("file-b.ts")'),
      { subagentId: 'sa-b2', agentType: 'critic-paranoid', parentId: 'skill-tu-2' });
    r.process(toolResultEvent('sa-b2-t1', 'result-b'),
      { subagentId: 'sa-b2', agentType: 'critic-paranoid', parentId: 'skill-tu-2' });
    // Second subagent done → skill header already emitted, must NOT re-emit.
    r.process(doneEvent(),
      { subagentId: 'sa-b2', agentType: 'critic-paranoid', parentId: 'skill-tu-2' });

    r.process(doneEvent());
    await r.dispose();

    // Count how many times a skill/diagnose line appears in scrollback.
    const skillOccurrences = commitAboveCalls.filter(
      (c) => c.includes('skill') || c.includes('diagnose')
    );
    // The skill header must appear EXACTLY ONCE — the first eager emit.
    // Pre-fix: it would appear at dispose-time only (once, but after both
    // subagent blocks). Post-fix without idempotency guard: it would appear
    // twice (once per subagent done).
    expect(
      skillOccurrences.length,
      `skill header must appear exactly once in scrollback; got: ${JSON.stringify(skillOccurrences)}`,
    ).toBe(1);

    // Both subagent blocks must be in scrollback AFTER the skill header.
    const skillIdx = commitAboveCalls.findIndex((c) => c.includes('skill') || c.includes('diagnose'));
    const agentAIdx = commitAboveCalls.findIndex((c) => c.includes('critic-pragmatist'));
    const agentBIdx = commitAboveCalls.findIndex((c) => c.includes('critic-paranoid'));

    expect(agentAIdx, 'agent-A in scrollback').toBeGreaterThanOrEqual(0);
    expect(agentBIdx, 'agent-B in scrollback').toBeGreaterThanOrEqual(0);
    expect(skillIdx).toBeLessThan(agentAIdx);
    expect(skillIdx).toBeLessThan(agentBIdx);
  });
});

// ─── Bug #2 — orphaned agent label ──────────────────────────────────────────
//
// Root cause: SubagentExecutor (src/agent/tools/subagent-executor.ts:269-274) calls
// `forkSubagent({ ..., idPrefix: parsed.id_prefix })` without passing `agentType`.
// When `forkSubagent` creates the subagent handle, meta.agentType is undefined because
// nothing at the dispatch callsite sets it.
//
// In the renderer (stream-renderer.ts:227), `freshSourceState(meta?.agentType)` receives
// `undefined`. In `synthesizeAgentEntry` (stream-renderer-subagent.ts:131):
//   `label = source.agentType ?? sourceId`
// So the label falls back to sourceId, which is generated from `idPrefix`. For a raw
// `agent` tool call with default id_prefix, the sourceId would be like 'agent-tool-TIMESTAMP-N',
// producing the label `Agent(agent-tool-TIMESTAMP-N)`.
//
// Test design:
//   - Simulates SubagentExecutor's current behavior: no agentType in meta, but a meaningful
//     prompt is available (which the FIX will use to derive the label)
//   - Uses sourceId = 'agent-tool' to exactly match the default id_prefix fallback
//   - Asserts: rendered output does NOT contain `Agent(agent-tool)` as the label
//
// WHY THIS TEST MUST FAIL ON CURRENT CODE:
//   synthesizeAgentEntry at stream-renderer-subagent.ts:131:
//     label = source.agentType ?? sourceId = undefined ?? 'agent-tool' = 'agent-tool'
//   toolLane.addStartWithAgentContext(syntheticId, 'Agent', '(agent-tool)', agentContext)
//   The rendered output DOES contain 'Agent(agent-tool)' — raw id_prefix leaks as label.
//
//   After fix (checkpoint 2d, SubagentExecutor passes agentType derived from prompt):
//     source.agentType = 'Analyze the codebase and find all …' (first 40 chars)
//     label = 'Analyze the codebase and find all …' (not 'agent-tool')
//     The output does NOT contain 'Agent(agent-tool)'.

describe('Bug #2 — orphaned agent label: raw agent dispatch without agentType', () => {
  it('Agent entry label must NOT be the raw id_prefix "agent-tool" fallback', async () => {
    const { synthesizeAgentEntry } = await import('./stream-renderer-subagent.js');
    const { freshSourceState } = await import('./stream-renderer-source.js');
    const { ToolLane } = await import('../commands/interactive/tool-lane.js');

    const { writer, lines } = makeWriter();
    const toolLane = new ToolLane();
    const ctx = {
      isTTY: false,
      compositor: null,
      toolLane,
      out: writer,
      streamingMarkdown: new Map(),
    };

    // Simulate what SubagentExecutor currently produces:
    //   sourceId is derived from idPrefix (default 'agent-tool')
    //   agentType is undefined — SubagentExecutor doesn't pass agentType to forkSubagent
    const sourceId = 'agent-tool'; // the raw id_prefix default
    const source = freshSourceState(undefined); // agentType intentionally absent — the bug

    synthesizeAgentEntry(sourceId, source, ctx);

    // Attach a result so the entry appears in flush output
    toolLane.addResult(
      source.syntheticAgentToolUseId!,
      { type: 'tool_result', toolUseId: 'synthetic', content: 'done', isError: false },
    );
    const flushLines = toolLane.flush();
    lines.push(...flushLines);

    const output = lines.join('\n');

    // FAILING on current code:
    //   label = source.agentType ?? sourceId = undefined ?? 'agent-tool' = 'agent-tool'
    //   output DOES contain 'Agent(agent-tool)' — assertion fails.
    //
    // After fix (checkpoint 2d):
    //   SubagentExecutor sets agentType from parsed.id_prefix (if non-default) or
    //   from the first 40 chars of the prompt. The raw 'agent-tool' id_prefix is
    //   never used as a user-visible label.
    expect(output).not.toContain('Agent(agent-tool)');
    // Positive (M5): without a meaningful agentType, the fixed fallback in
    // synthesizeAgentEntry is 'agent'. Without this assertion, a regression
    // producing 'Agent()' or 'Agent(undefined)' would also satisfy the
    // negative check above.
    expect(output).toContain('Agent(agent)');
  });

  it('StreamRenderer end-to-end: raw agent subagent without agentType renders with non-generic label', async () => {
    // End-to-end test through the full StreamRenderer non-TTY path.
    // Drives the renderer with meta that has no agentType (current SubagentExecutor behavior).
    const { StreamRenderer } = await import('./stream-renderer.js');

    const { writer, lines } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });

    // meta('agent-tool') has no agentType field — matches what SubagentExecutor produces
    // when the tool input has default id_prefix and no agentType override
    r.process(toolStartEvent('t1', 'Read', '("codebase.ts")'), meta('agent-tool'));
    r.process(toolResultEvent('t1', 'analysis complete'), meta('agent-tool'));
    r.process(doneEvent(), meta('agent-tool'));

    await r.dispose();
    const output = lines.join('\n');

    // FAILING on current code:
    //   sourceId = 'agent-tool', agentType = undefined
    //   label = 'agent-tool' → rendered as 'Agent(agent-tool)'
    //   output DOES contain 'Agent(agent-tool)' — assertion fails.
    //
    // After fix (checkpoint 2d), SubagentExecutor passes agentType derived from the prompt.
    // The label will be something like the first 40 chars of the agent prompt.
    expect(output).not.toContain('Agent(agent-tool)');
    // Positive (M5): the meta() in this test has no agentType field, so
    // synthesizeAgentEntry hits the 'agent' fallback. Assert it actually
    // renders something inside the parens, not Agent() or Agent(undefined).
    expect(output).toContain('Agent(agent)');
  });
});

// ─── Bug #2 dispatch-site invariant: agentType MUST propagate from ───────────
// SubagentExecutor → forkSubagent → handle meta → StreamRenderer label
//
// GAP CLOSED: The existing Bug #2 tests above assert that:
//   (a) the renderer never shows 'Agent(agent-tool)' (negative)
//   (b) the renderer shows 'Agent(agent)' when agentType is absent (fallback)
//
// Neither test exercises the dispatch site in subagent-executor.ts. Both pass
// even if the `agentType:` forwarding line at subagent-executor.ts:~293 is
// removed — the renderer would silently fall back to 'Agent(agent)' and the
// assertions would still be satisfied.
//
// THIS TEST closes that hole. It drives SubagentExecutor end-to-end with a
// non-default id_prefix ('researcher-lens-A'), intercepts the forkSubagent
// call to capture whatever agentType SubagentExecutor derived, fires events
// through a StreamRenderer using that exact agentType in the meta, and
// asserts the label 'Agent(researcher-lens-A)' appears in the rendered output.
//
// REGRESSION TRACE: if the agentType forwarding line is removed —
//   subagent-executor.ts: forkSubagent({ ..., /* agentType: ... removed */ })
// then the intercepted agentType would be undefined, the meta fired through
// the StreamRenderer would omit agentType, freshSourceState would receive
// undefined, source.agentType would be undefined, synthesizeAgentEntry would
// fall back to 'agent', and the output would contain 'Agent(agent)' — NOT
// 'Agent(researcher-lens-A)'. The assertion on line ~503 would FAIL.
describe('Bug #2 dispatch-site invariant: agentType propagates from SubagentExecutor to renderer', () => {
  it('Agent(researcher-lens-A) appears when SubagentExecutor dispatches with id_prefix researcher-lens-A', async () => {
    const { SubagentExecutor } = await import('../../agent/tools/subagent-executor.js');
    const { StreamRenderer } = await import('./stream-renderer.js');

    const { writer, lines } = makeWriter();
    const renderer = new StreamRenderer({ out: writer, forceNonTty: true });

    // Intercept forkSubagent: capture agentType as SubagentExecutor computed it,
    // then fire a minimal event stream through the renderer using that agentType
    // in the SubagentProgressMeta — exactly what SubagentHandleImpl.streamToFinalMessage
    // does at subagent/handle.ts:205-208. This is the only part of the propagation
    // chain not already exercised by the H3 tests in subagent-executor.test.ts.
    let capturedAgentType: string | undefined = undefined;
    const handleId = 'dispatch-site-test-handle';

    const mockManager = {
      forkSubagent: vi.fn().mockImplementation(
        (opts: { agentType?: string; idPrefix?: string }) => {
          // Capture whatever agentType SubagentExecutor forwarded to forkSubagent.
          // If the forwarding line is removed, this will be undefined.
          capturedAgentType = opts.agentType;

          // Fire a tool event + done event through the renderer using the
          // captured agentType, mirroring what SubagentHandleImpl fires via
          // its progressSink in streamToFinalMessage (handle.ts:203-213).
          const subagentMeta: SubagentProgressMeta = {
            subagentId: handleId,
            ...(capturedAgentType !== undefined && { agentType: capturedAgentType }),
          };
          renderer.process(toolStartEvent('disp-t1', 'Read', '("x.ts")'), subagentMeta);
          renderer.process(doneEvent(), subagentMeta);

          return Promise.resolve({
            id: handleId,
            status: 'succeeded',
            runToResult: vi.fn().mockResolvedValue({
              id: handleId,
              status: 'succeeded',
              message: { role: 'assistant', content: 'done', timestamp: new Date() },
            }),
            cancel: vi.fn().mockResolvedValue(undefined),
            teardown: vi.fn().mockResolvedValue(undefined),
          });
        },
      ),
    };

    const mockParentSession = {
      sessionId: 'dispatch-site-parent',
      getInputStreamRef: vi.fn(),
      abortSignal: new AbortController().signal,
    };

    const executor = new SubagentExecutor({
      subagentManager: mockManager as any,
      parentSession: mockParentSession as any,
      defaultConfig: { apiKey: 'test-key', systemPrompt: 'test' },
      depth: 0,
    });

    // Dispatch with a non-default id_prefix so SubagentExecutor's leg (a)
    // (subagent-executor.ts:~291) forwards it verbatim as agentType.
    // Using a distinctive value 'researcher-lens-A' that can only appear in
    // the output if the forwarding line is present — no fallback path
    // produces this string.
    await executor.execute({
      id: 'call-001',
      name: 'agent',
      input: { prompt: 'analyse the repository', id_prefix: 'researcher-lens-A' },
      signal: new AbortController().signal,
    });

    await renderer.dispose();
    const output = lines.join('\n');

    // Primary assertion: the dispatch-site invariant.
    // FAILS if agentType forwarding is removed from subagent-executor.ts.
    expect(output).toContain('Agent(researcher-lens-A)');

    // Belt-and-suspenders: confirm the executor actually forwarded the right
    // value to forkSubagent (complements the H3 tests in subagent-executor.test.ts
    // without duplicating them — here it is a pre-condition, not the focus).
    expect(capturedAgentType).toBe('researcher-lens-A');
  });
});

// ─── Bug #3 — stuck paused state: checkPauseAnnotations runs forever ─────────
//
// Root cause: `checkPauseAnnotations()` (stream-renderer.ts:340-362) runs on a
// setInterval every 80ms. The only exit condition is `source.done || source.errored`
// — if a subagent never fires `done` (e.g. aborted without a terminal event, or a
// dropped done event in an error race), the interval runs indefinitely until dispose().
//
// The spec requires a bounded maximum of 2K = 750 ticks (at K=375):
//   K    ticks = 375 × 80ms = 30 s → STALLED annotation
//   2K   ticks = 750 × 80ms = 60 s → auto-settle with synthetic '[no-result — timed out]'
//
// This test:
//   1. Creates a SourceState for a subagent whose done event never fires
//   2. Uses vi.useFakeTimers() to advance simulated time past 2K × 80ms (60 seconds)
//   3. Calls checkPauseAnnotations() via the private-method bracket pattern
//      (same pattern as stream-renderer-visibility.test.ts:322-323) for 2K iterations
//   4. Asserts: the source.done is set to true OR the tool lane has a timed-out result
//
// WHY THIS TEST MUST FAIL ON CURRENT CODE:
//   checkPauseAnnotations at stream-renderer.ts:347-356:
//     - When elapsed > PAUSE_THRESHOLD_MS (30000ms), it sets `source.pauseAnnotation`
//       and calls `toolLane.addStartWithAgentContext(...)` to update the label.
//     - It NEVER sets `source.done = true`.
//     - After 2K iterations, the source is still not done.
//   The test asserts source.done === true after 2K ticks → FAILS on current code.
//
//   After fix (checkpoint 2e, checkStalledEntries replaces checkPauseAnnotations):
//     At stalledTicks === 2K: calls toolLane.addResult(syntheticAgentToolUseId,
//     syntheticResult('[no-result — timed out]', false)) and sets source.done = true.

describe('Bug #3 — stuck paused state: checkPauseAnnotations must have bounded exit', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('source.done becomes true after 2K × 80ms ticks without a done event (bounded stalled lifecycle)', async () => {
    vi.useFakeTimers();

    const { ToolLane } = await import('../commands/interactive/tool-lane.js');
    const { StreamRenderer } = await import('./stream-renderer.js');

    const { writer } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });

    // Register the subagent by sending its first event (creates the source in r.sources
    // with syntheticAgentToolUseId set — that's the flag checkPauseAnnotations checks)
    const sourceId = 'stuck-subagent-001';
    r.process(toolStartEvent('sa-t1', 'Read', '("x.ts")'), meta(sourceId, 'researcher'));

    // Access private sources map via bracket notation — same pattern as
    // stream-renderer-visibility.test.ts:326-328
    type PrivateState = {
      sources: Map<string, { done: boolean; errored: boolean; syntheticAgentToolUseId?: string; lastEventAt: number; pauseAnnotation?: string; stalledTicks?: number; }>;
      toolLane: InstanceType<typeof ToolLane>;
    };
    const privateR = r as unknown as PrivateState;
    const source = privateR.sources.get(sourceId)!;

    // Verify the source was created with syntheticAgentToolUseId set
    // (without this, checkPauseAnnotations skips the source entirely)
    expect(source, 'source must be registered').toBeDefined();
    expect(source.syntheticAgentToolUseId, 'syntheticAgentToolUseId must be set').toBeDefined();
    expect(source.done).toBe(false);

    // Advance simulated time past 2K × 80ms = 60,000ms (K=375 per spec).
    // The `lastEventAt` was set to Date.now() at source creation time.
    // After advancing 61,000ms, elapsed = 61,000ms > 60,000ms = 2K × 80ms.
    const K = 375;
    vi.advanceTimersByTime(K * 2 * 80 + 1000); // advance past 60 seconds

    // Call checkPauseAnnotations for 2K+1 iterations via the private method.
    // The method is private in StreamRenderer but accessible via bracket notation —
    // same approach as stream-renderer-visibility.test.ts:322-323.
    type PrivateCheckMethod = { checkPauseAnnotations: () => void };
    const checkFn = (r as unknown as PrivateCheckMethod).checkPauseAnnotations?.bind(r);
    if (checkFn) {
      // Run 2K+1 ticks — the bounded exit should trigger at exactly 2K ticks
      for (let i = 0; i < K * 2 + 1; i++) {
        checkFn();
      }
    }

    // FAILING on current code (stream-renderer.ts:340-362):
    //   checkPauseAnnotations never sets source.done = true.
    //   It only mutates source.pauseAnnotation and calls addStartWithAgentContext.
    //   After 2K+1 calls, source.done is still false.
    //   Assertion below FAILS.
    //
    // After fix (checkpoint 2e, checkStalledEntries replaces checkPauseAnnotations):
    //   At stalledTicks === 2K: calls toolLane.addResult(syntheticAgentToolUseId,
    //   syntheticResult('[no-result — timed out]', false)) and sets source.done = true.
    //   The 2K+1th call sees source.done === true and skips.
    //   Assertion below PASSES.
    expect(source.done).toBe(true);

    r.dispose();
  });

  // H2: mid-lifecycle assertions — proves the cutoff fires at 2K and not at K,
  // and that the soft-warn annotation appears in the K..2K-1 window.
  it('soft-warn fires at K and hard-cutoff fires only at >= 2K, not at K (H2 regression)', async () => {
    vi.useFakeTimers();

    const { ToolLane } = await import('../commands/interactive/tool-lane.js');
    const { StreamRenderer } = await import('./stream-renderer.js');

    const { writer } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });

    const sourceId = 'stuck-subagent-002';
    r.process(toolStartEvent('sa-t2', 'Read', '("y.ts")'), meta(sourceId, 'analyst'));

    type PrivateState = {
      sources: Map<string, { done: boolean; errored: boolean; syntheticAgentToolUseId?: string; lastEventAt: number; pauseAnnotation?: string; stalledTicks: number; }>;
      toolLane: InstanceType<typeof ToolLane>;
    };
    const source = (r as unknown as PrivateState).sources.get(sourceId)!;

    // Advance past PAUSE_THRESHOLD_MS so every tick counts as stalled.
    const K = 375;
    vi.advanceTimersByTime(K * 2 * 80 + 1000);

    type PrivateCheckMethod = { checkPauseAnnotations: () => void };
    const checkFn = (r as unknown as PrivateCheckMethod).checkPauseAnnotations?.bind(r);
    if (!checkFn) throw new Error('checkPauseAnnotations not exposed on StreamRenderer');

    // ── Tick K: soft-warn label must be set, source NOT yet timed out ──
    // External constraint: K is the soft-warn threshold; cutoff is at 2K.
    for (let i = 0; i < K; i++) checkFn();
    expect(source.done, 'must NOT be done at K ticks (soft-warn phase)').toBe(false);
    expect(source.pauseAnnotation, 'soft-warn label must be a non-empty string at K').toEqual(
      expect.stringMatching(/.+/),
    );

    // ── Tick 2K-1: still in soft-warn window, NOT yet timed out ──
    for (let i = K; i < K * 2 - 1; i++) checkFn();
    expect(source.done, 'must NOT be done at 2K-1 ticks').toBe(false);

    // ── Tick 2K: hard-cutoff fires (>= comparison, not strict ===) ──
    checkFn();
    expect(source.done, 'must be done at exactly 2K ticks').toBe(true);

    // ── Post-cutoff: extra ticks must be inert (source.done short-circuits) ──
    const ticksBefore = source.stalledTicks;
    checkFn();
    expect(source.stalledTicks, 'counter must not increment after done').toBe(ticksBefore);

    r.dispose();
  });

  // M2 regression: heartbeat resets stalledTicks. Without the reset, K stalled
  // ticks → heartbeat → K more ticks would hit the 2K cutoff at 30s of new
  // stall instead of requiring 60s of continuous stall. The fix at
  // stream-renderer.ts adds `source.stalledTicks = 0` on heartbeat.
  it('stalledTicks resets to 0 when a heartbeat clears pauseAnnotation (M2 regression)', async () => {
    vi.useFakeTimers();

    const { ToolLane } = await import('../commands/interactive/tool-lane.js');
    const { StreamRenderer } = await import('./stream-renderer.js');

    const { writer } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });

    const sourceId = 'heartbeat-subagent';
    r.process(toolStartEvent('hb-t1', 'Read', '("z.ts")'), meta(sourceId, 'analyst'));

    type PrivateState = {
      sources: Map<string, { done: boolean; errored: boolean; syntheticAgentToolUseId?: string; lastEventAt: number; pauseAnnotation?: string; stalledTicks: number; }>;
      toolLane: InstanceType<typeof ToolLane>;
    };
    const source = (r as unknown as PrivateState).sources.get(sourceId)!;

    const K = 375;
    type PrivateCheckMethod = { checkPauseAnnotations: () => void };
    const checkFn = (r as unknown as PrivateCheckMethod).checkPauseAnnotations?.bind(r);
    if (!checkFn) throw new Error('checkPauseAnnotations not exposed');

    // Phase 1: stall for K ticks (past PAUSE_THRESHOLD_MS, so each tick increments).
    vi.advanceTimersByTime(K * 80 + 1000);
    for (let i = 0; i < K; i++) checkFn();
    expect(source.stalledTicks, 'counter incremented during stall').toBeGreaterThanOrEqual(K);
    expect(source.pauseAnnotation, 'soft-warn set after K ticks').toEqual(expect.stringMatching(/.+/));

    // Phase 2: heartbeat — drive a real subagent event. This must reset both
    // pauseAnnotation AND stalledTicks. Without the M2 fix, only the
    // annotation resets, leaving the counter at K.
    r.process(toolStartEvent('hb-t2', 'Read', '("zz.ts")'), meta(sourceId, 'analyst'));
    expect(source.pauseAnnotation, 'annotation cleared by heartbeat').toBeUndefined();
    expect(source.stalledTicks, 'counter MUST reset to 0 on heartbeat (M2)').toBe(0);

    // Phase 3: stall for K more ticks. With the reset, total counter is K, far
    // below 2K — source must NOT be done. Pre-fix behavior: counter accumulates
    // to 2K and triggers the cutoff here.
    vi.advanceTimersByTime(K * 80 + 1000);
    for (let i = 0; i < K; i++) checkFn();
    expect(source.done, 'must NOT be done — only K continuous ticks of new stall').toBe(false);

    r.dispose();
  });
});

// ─── Skill-nesting: Agent nests under skill spine ────────────────────────────
//
// End-to-end test for the fix described in the bug report:
//
//   BEFORE fix:
//     ◉ ◆ skill(review)        ← orphaned skill root
//     ● read_file              ← flat root (correct)
//     ◉ → Agent(review-w1)    ← SECOND root anchor (confusing)
//       ╰─ bash
//
//   AFTER fix (activeSkillName set):
//     ◉ ◆ skill(review)
//       ╰─ → Agent(review-w1)  ← nested under skill spine
//           ╰─ bash
//
// The test drives StreamRenderer in TTY-hooked mode (forceNonTty=true +
// injected compositor) and verifies:
//   1. The Agent entry is parented under the skill entry (agentContext set).
//   2. When the subagent completes, the skill header appears in scrollback
//      BEFORE the Agent done-block (eager ancestor-header emission).
//   3. A single ◉ root anchor in the final scrollback (collapsed tree).
// ─────────────────────────────────────────────────────────────────────────────

describe('Skill-nesting — Agent nests under skill spine when activeSkillName set', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('Agent entry receives agentContext = skill entry id when activeSkillName is set (d)', async () => {
    vi.useFakeTimers();

    const { StreamRenderer } = await import('./stream-renderer.js');

    const commitAboveCalls: string[] = [];
    const recordingCompositor = {
      setOverlay: (_text: string) => {},
      commitAbove: (text: string) => { commitAboveCalls.push(text); },
      setSpinner: (_config: { enabled: boolean; rotateVerbEveryMs?: number }) => {},
      arm: async () => {},
      disarm: () => {},
      getBuffer: () => ({ text: '', queued: false }),
      isArmed: () => true,
    };

    const { writer } = makeWriter();
    // Construct renderer with activeSkillName — simulates a slash-skill dispatch turn.
    const r = new StreamRenderer({ out: writer, forceNonTty: true, activeSkillName: 'review' });

    type PrivateRenderer = {
      isTTY: boolean;
      compositor: typeof recordingCompositor;
      streamingMarkdownRef: { current: null };
      toolLane: import('../commands/interactive/tool-lane.js').ToolLane;
    };
    const privateR = r as unknown as PrivateRenderer;
    privateR.isTTY = true;
    privateR.compositor = recordingCompositor;
    privateR.streamingMarkdownRef.current = null;

    // Step 1: model calls skill tool (registered by orchestrator event handler).
    r.process(toolStartEvent('skill-tu-e2e', 'skill', '(review)'));

    // Step 2: model dispatches agent subagent — should nest under skill.
    r.process(toolStartEvent('agent-tu-e2e', 'agent', '"review-w1"'));

    // Verify nesting at registration time (before subagent events arrive).
    type PrivateLane = { entries: Map<string, { agentContext?: string; toolName: string }> };
    const entries = (privateR.toolLane as unknown as PrivateLane).entries;
    const agentEntry = entries.get('agent-tu-e2e');
    expect(agentEntry, 'agent entry must be registered').toBeDefined();
    expect(agentEntry?.agentContext, 'agent must be nested under skill entry').toBe('skill-tu-e2e');

    // Step 3: subagent does some work and completes.
    r.process(
      toolStartEvent('bash-sa-1', 'Bash', '"ls"'),
      { subagentId: 'sa-review-w1', agentType: 'review-w1', parentId: 'agent-tu-e2e' },
    );
    r.process(
      toolResultEvent('bash-sa-1', 'file list'),
      { subagentId: 'sa-review-w1', agentType: 'review-w1', parentId: 'agent-tu-e2e' },
    );
    r.process(doneEvent(), { subagentId: 'sa-review-w1', agentType: 'review-w1', parentId: 'agent-tu-e2e' });

    // Step 4: skill header must appear in scrollback BEFORE the Agent done-block.
    // (Eager ancestor-header emission in flushSource.)
    const skillIdx = commitAboveCalls.findIndex(
      (c) => c.includes('skill') || c.includes('review'),
    );
    const agentIdx = commitAboveCalls.findIndex(
      (c) => c.includes('review-w1') || c.includes('Bash') || c.includes('bash'),
    );

    expect(skillIdx, 'skill header must be committed to scrollback').toBeGreaterThanOrEqual(0);
    expect(agentIdx, 'agent done-block must be committed to scrollback').toBeGreaterThanOrEqual(0);
    expect(
      skillIdx,
      'skill header must precede agent done-block in scrollback (single ◉ root)',
    ).toBeLessThan(agentIdx);

    r.process(doneEvent());
    await r.dispose();
  });
});
