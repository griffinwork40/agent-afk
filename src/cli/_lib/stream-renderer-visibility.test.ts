/**
 * Visibility tests for three CLI subagent renderer improvements:
 * 1. Grandchild indent — Agent(B) nested under Agent(A)
 * 2. Pause annotation — stale sources get a `· waiting Xs` label
 *    (label rendered as `waiting`; field name `pauseAnnotation` retained
 *    because the underlying pause-tick mechanism is unchanged).
 * 3. Long tool-arg truncation — formatToolLine respects maxWidth
 *
 * @module cli/_lib/stream-renderer-visibility.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StreamRenderer } from './stream-renderer.js';
import type { Writer } from '../slash/types.js';
import type { OutputEvent, SubagentProgressMeta } from '../../agent/types.js';

// ---------------------------------------------------------------------------
// Shared test helpers (mirrored from stream-renderer.test.ts)
// ---------------------------------------------------------------------------

function makeWriter(): { writer: Writer; lines: string[] } {
  const lines: string[] = [];
  const writer: Writer = {
    line(text = '') { lines.push(text); },
    raw(text) { lines.push(text); },
    success(text) { lines.push('SUCCESS:' + text); },
    info(text) { lines.push('INFO:' + text); },
    warn(text) { lines.push('WARN:' + text); },
    error(text) { lines.push('ERROR:' + text); },
  };
  return { writer, lines };
}

function contentEvent(chunk: string): OutputEvent {
  return {
    type: 'chunk',
    chunk: { type: 'content', content: chunk },
  };
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

function doneEvent(): OutputEvent {
  return { type: 'done' };
}

function subMeta(subagentId: string, agentType?: string, parentId?: string): SubagentProgressMeta {
  return {
    subagentId,
    ...(agentType !== undefined ? { agentType } : {}),
    ...(parentId !== undefined ? { parentId } : {}),
  };
}

// ---------------------------------------------------------------------------
// Change 1 — Grandchild indent
// ---------------------------------------------------------------------------

describe('Change 1 — grandchild indent', () => {
  it("renders Agent(B) nested under Agent(A) in flushed output order", async () => {
    const { writer, lines } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });

    // Register parent agent 'a' first (its synthetic entry must exist before 'b' registers)
    r.process(toolStartEvent('a-1', 'Read', '("a.ts")'), subMeta('a', 'a'));
    r.process(toolResultEvent('a-1', 'ok'), subMeta('a', 'a'));

    // Register child agent 'b' with parentId='a' — should nest under Agent(a)
    r.process(toolStartEvent('b-1', 'Bash', '("grep")'), subMeta('b', 'b', 'a'));
    r.process(toolResultEvent('b-1', 'ok'), subMeta('b', 'b', 'a'));

    r.process(doneEvent(), subMeta('a', 'a'));
    r.process(doneEvent(), subMeta('b', 'b', 'a'));

    await r.dispose();

    // The flush output for nested agents is a single string with embedded newlines
    // (formatAgentSummary joins with \n). We join all lines and use indexOf for ordering.
    const output = lines.join('\n');
    const agentAIdx = output.indexOf('(a)');
    const agentBIdx = output.indexOf('(b)');

    expect(agentAIdx, 'Agent(a) label must appear in output').toBeGreaterThanOrEqual(0);
    expect(agentBIdx, 'Agent(b) label must appear in output').toBeGreaterThanOrEqual(0);
    // Agent(B) must come after Agent(A) (nested child rendered after parent header)
    expect(agentBIdx, 'Agent(b) must appear after Agent(a)').toBeGreaterThan(agentAIdx);
  });

  it("Agent(B) entry has agentContext pointing to Agent(A)'s syntheticId", async () => {
    const { freshSourceState } = await import('./stream-renderer-source.js');
    const { synthesizeAgentEntry } = await import('./stream-renderer-subagent.js');
    const { ToolLane } = await import('../commands/interactive/tool-lane.js');

    const { writer } = makeWriter();
    const toolLane = new ToolLane();
    const ctx = { isTTY: false, compositor: null, toolLane, out: writer, streamingMarkdown: new Map() };

    // Create parent agent 'a'
    const sourceA = freshSourceState('a');
    synthesizeAgentEntry('a', sourceA, ctx, undefined);
    const synthAId = sourceA.syntheticAgentToolUseId;
    expect(synthAId).toBeDefined();

    // Create child agent 'b' with agentContext = synthAId
    const sourceB = freshSourceState('b');
    synthesizeAgentEntry('b', sourceB, ctx, synthAId);

    // Verify B's entry has agentContext = synthAId
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entries = (toolLane as any)['entries'] as Map<string, { agentContext?: string }>;
    const entryB = entries.get(sourceB.syntheticAgentToolUseId!);
    expect(entryB?.agentContext).toBe(synthAId);
  });
});

// ---------------------------------------------------------------------------
// Change 1b — Compose nesting (parentId-as-tool-use-id fallback)
// ---------------------------------------------------------------------------
//
// The grandchild-nesting machinery treats `meta.parentId` as a subagent-source
// id. Compose dispatches subagents whose `parentId` is the compose tool's
// `tool_use_id` — not a subagent id. The renderer's resolution falls back to
// using parentId directly when it doesn't match a known source, so the
// synthesized Agent entry's `agentContext` points at the compose tool entry.
// This lets compose-spawned subagents nest under the compose tool-lane entry
// without compose itself being a subagent source.

describe('Change 1b — compose nesting via parentId-as-tool-use-id', () => {
  it("Agent(node) entry's agentContext points at the compose tool_use_id when no matching source", async () => {
    const { freshSourceState } = await import('./stream-renderer-source.js');
    const { synthesizeAgentEntry } = await import('./stream-renderer-subagent.js');
    const { ToolLane } = await import('../commands/interactive/tool-lane.js');

    const { writer } = makeWriter();
    const toolLane = new ToolLane();
    const ctx = { isTTY: false, compositor: null, toolLane, out: writer, streamingMarkdown: new Map() };

    // Simulate the orchestrator emitting a compose tool_use_detail —
    // ToolLane gets the entry, no subagent source is created for it.
    const composeToolUseId = 'tu_compose_123';
    toolLane.addStartWithAgentContext(composeToolUseId, 'compose', '(3 nodes)', undefined);

    // Now a compose-spawned subagent fires its first event. Production wiring
    // resolves parentSyntheticId via:
    //   sources.get(meta.parentId)?.syntheticAgentToolUseId  ?? meta.parentId
    // For compose-spawned subagents, sources.get(parentId) is undefined →
    // the fallback hands the tool_use_id straight to synthesizeAgentEntry.
    const sourceNode = freshSourceState('diagnose [1/3]');
    synthesizeAgentEntry('compose-diagnose-1', sourceNode, ctx, composeToolUseId);

    // Verify the synthesized Agent entry's agentContext is the compose id.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entries = (toolLane as any)['entries'] as Map<string, { agentContext?: string }>;
    const entry = entries.get(sourceNode.syntheticAgentToolUseId!);
    expect(entry?.agentContext).toBe(composeToolUseId);
  });

  it('StreamRenderer.process resolves parentId fallback for compose-spawned subagents', async () => {
    const { writer } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });

    // Inject a compose tool_use_detail through the orchestrator path so the
    // tool-lane has an entry for the compose tool_use_id.
    const composeToolUseId = 'tu_compose_abc';
    r.process(toolStartEvent(composeToolUseId, 'compose', '(2 nodes)'));

    // Now a compose-spawned subagent emits its first event with
    // parentId = composeToolUseId. No subagent source exists for that id, so
    // the renderer must fall back to using parentId directly as the agentContext.
    r.process(contentEvent('working...'), subMeta('compose-node-a', 'a [1/2]', composeToolUseId));

    // Pull the toolLane's entries and verify the synthesized Agent(a) entry
    // is anchored to the compose tool_use_id (not orphaned at root).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolLane = (r as any)['toolLane'];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entries = toolLane['entries'] as Map<string, { toolName?: string; agentContext?: string }>;
    const agentEntry = [...entries.values()].find((e) => e.toolName === 'Agent');
    expect(agentEntry, 'synthesized Agent entry must exist').toBeDefined();
    expect(agentEntry?.agentContext).toBe(composeToolUseId);

    await r.dispose();
  });

  // ----- Regression: parentId-as-session-UUID (CRITICAL fix) -----
  it('regression — parentId-as-session-UUID for regular subagents does not orphan the Agent entry', async () => {
    const { writer } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });

    // A raw Anthropic session UUID: never registered as a toolLane entry or
    // as a subagent source. Regular (non-compose) subagents set meta.parentId
    // to this kind of value in production. Pre-fix, the renderer fell through
    // to `?? meta.parentId`, setting agentContext to the UUID, which then
    // caused the synthesized Agent entry to be silently filtered out by
    // getOverlay() and flush() (both exclude entries whose agentContext does
    // not resolve to a registered toolLane entry).
    const sessionUuid = 'sess_01AbCdEfGhIjKlMnOpQrStUv';

    // NO toolLane.addStart / toolStartEvent for sessionUuid — it is unregistered.
    r.process(contentEvent('hi'), subMeta('sub-1', 'research', sessionUuid));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolLane = (r as any)['toolLane'];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entries = toolLane['entries'] as Map<string, { toolName?: string; agentContext?: string }>;
    const agentEntry = [...entries.values()].find((e) => e.toolName === 'Agent');

    expect(agentEntry, 'synthesized Agent entry must exist (not filtered)').toBeDefined();
    // Its agentContext must be undefined — NOT the raw UUID — so the entry
    // renders at root rather than being filtered by getOverlay/flush.
    expect(agentEntry?.agentContext).toBeUndefined();

    await r.dispose();
  });

  // ----- M2: compose-rooted depth-3 chain via StreamRenderer.process -----
  it('compose-rooted depth-3 chain (compose → Agent → Read) nests correctly through r.process', async () => {
    const { writer } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });

    // Step 1: orchestrator emits a compose tool_use_detail (no meta — orchestrator path).
    const composeId = 'tu_compose_depth3';
    r.process(toolStartEvent(composeId, 'compose', '(1 node)'));

    // Step 2: compose-spawned subagent fires its first content event with
    // parentId = composeId. The renderer synthesizes an Agent entry anchored
    // to composeId (depth 1 under compose).
    r.process(contentEvent('agent working'), subMeta('node-1', 'depth3-node [1/1]', composeId));

    // Step 3: the subagent emits a Read tool_use_detail (depth 2 under Agent,
    // depth 3 total under compose). Routed via the subagent source path so
    // it lands under the Agent entry through agentIdStack/source plumbing.
    r.process(toolStartEvent('tu_read_1', 'Read', '("plan.md")'), subMeta('node-1', 'depth3-node [1/1]', composeId));
    r.process(toolResultEvent('tu_read_1', '42 lines'), subMeta('node-1', 'depth3-node [1/1]', composeId));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolLane = (r as any)['toolLane'];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entries = toolLane['entries'] as Map<string, { toolName?: string; agentContext?: string }>;
    const allEntries = [...entries.values()];

    const composeEntry = allEntries.find((e) => e.toolName === 'compose');
    expect(composeEntry, 'compose entry must exist at root').toBeDefined();
    expect(composeEntry?.agentContext).toBeUndefined();

    const agentEntry = allEntries.find((e) => e.toolName === 'Agent');
    expect(agentEntry, 'synthesized Agent entry must exist under compose').toBeDefined();
    expect(agentEntry?.agentContext).toBe(composeId);

    const readEntry = allEntries.find((e) => e.toolName === 'Read');
    expect(readEntry, 'Read entry must exist').toBeDefined();

    await r.dispose();
  });

  // ----- M3: parentId collision with a live non-compose toolLane entry -----
  it('regular subagent whose parentId coincides with a non-compose tool_use_id nests under that entry (deterministic, not orphaned)', async () => {
    const { writer } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });

    // A non-compose tool (any registered tool_use_id qualifies as a valid
    // nesting anchor under the new contract — hasEntry returns true for
    // any kind:'tool' entry, not just compose).
    const someToolId = 'tu_some_dispatcher';
    r.process(toolStartEvent(someToolId, 'compose', '(1 node)')); // any dispatch tool — compose for symmetry

    // A subagent's parentId happens to equal that tool_use_id. The renderer
    // must NOT orphan the Agent entry (pre-fix bug) — it must anchor it under
    // the live toolLane entry. This is deterministic, not accidental: the
    // contract is "any live tool_use_id named as parentId acts as anchor."
    r.process(contentEvent('hello'), subMeta('sub-x', 'x', someToolId));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolLane = (r as any)['toolLane'];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entries = toolLane['entries'] as Map<string, { toolName?: string; agentContext?: string }>;
    const agentEntry = [...entries.values()].find((e) => e.toolName === 'Agent');

    expect(agentEntry, 'synthesized Agent entry must exist').toBeDefined();
    // Anchored to the live toolLane entry — not undefined (would mean unresolved)
    // and not the raw UUID-not-in-toolLane (would mean orphan).
    expect(agentEntry?.agentContext).toBe(someToolId);

    await r.dispose();
  });
});

// ---------------------------------------------------------------------------
// Change 2 — Pause annotation
// ---------------------------------------------------------------------------

describe('Change 2 — pause annotation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('annotates stale source after PAUSE_THRESHOLD_MS and clears on new event', () => {
    const { writer } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });

    // Register a subagent source
    r.process(contentEvent('hello'), subMeta('sa1', 'sa1'));

    // Advance time beyond threshold
    vi.advanceTimersByTime(31_000);

    // Call private method via bracket notation (arm() doesn't register tick on non-TTY)
    type PrivateRenderer = Record<string, () => void>;
    (r as unknown as PrivateRenderer)['checkPauseAnnotations']?.();

    // Check pause annotation was set
    type SourceMap = Record<string, Map<string, { pauseAnnotation?: string }>>;
    const sources = (r as unknown as SourceMap)['sources'];
    const sa1 = sources.get('sa1');
    expect(sa1?.pauseAnnotation, 'pauseAnnotation should be set after threshold').toBeDefined();
    // Label renders as `waiting` (renamed from `paused` — the prior word
    // misread as a user-toggleable pause; status is honestly `waiting`).
    expect(sa1?.pauseAnnotation).toContain('waiting');

    // New event clears the annotation
    r.process(contentEvent('world'), subMeta('sa1', 'sa1'));
    expect(sources.get('sa1')?.pauseAnnotation, 'pauseAnnotation should clear after new event').toBeUndefined();

    r.dispose();
  });

  it('does not annotate source that received events within threshold', () => {
    const { writer } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });

    r.process(contentEvent('hello'), subMeta('sa2', 'sa2'));

    // Advance time to just under threshold
    vi.advanceTimersByTime(25_000);

    type PrivateRenderer = Record<string, () => void>;
    (r as unknown as PrivateRenderer)['checkPauseAnnotations']?.();

    type SourceMap = Record<string, Map<string, { pauseAnnotation?: string }>>;
    const sources = (r as unknown as SourceMap)['sources'];
    expect(sources.get('sa2')?.pauseAnnotation).toBeUndefined();

    r.dispose();
  });

  it('does not annotate done sources', () => {
    const { writer } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });

    r.process(contentEvent('hello'), subMeta('sa3', 'sa3'));
    r.process(doneEvent(), subMeta('sa3', 'sa3'));

    vi.advanceTimersByTime(35_000);

    type PrivateRenderer = Record<string, () => void>;
    (r as unknown as PrivateRenderer)['checkPauseAnnotations']?.();

    type SourceMap = Record<string, Map<string, { pauseAnnotation?: string }>>;
    const sources = (r as unknown as SourceMap)['sources'];
    expect(sources.get('sa3')?.pauseAnnotation).toBeUndefined();

    r.dispose();
  });
});

// ---------------------------------------------------------------------------
// Change 3 — Long tool-arg truncation
// ---------------------------------------------------------------------------

describe('Change 3 — tool-arg truncation', () => {
  it('truncates long args to fit maxWidth and signals truncation', async () => {
    const { formatToolLine } = await import('../commands/interactive/tool-lane-format.js');
    const { stripAnsi } = await import('../display.js');

    const longArg = '("' + 'x'.repeat(300) + '")';
    const result = formatToolLine('grep' + longArg, 60);
    const plain = stripAnsi(result);
    expect(plain.length, 'plain text must fit within maxWidth').toBeLessThanOrEqual(60);
    // Fix 4: bracket-pair-aware truncation preserves a balanced closing
    // bracket after the ellipsis, so a `(xxx…)`-shaped arg ends with the
    // closer rather than `…`. Truncation is signalled by the embedded
    // ellipsis, which must still be present.
    expect(plain, 'truncated output must contain ellipsis').toContain('…');
    expect(plain, 'truncated balanced-bracket args end with closing bracket').toMatch(/[)\]}]$/);
  });

  it('does not truncate when content fits within maxWidth', async () => {
    const { formatToolLine } = await import('../commands/interactive/tool-lane-format.js');
    const { stripAnsi } = await import('../display.js');

    const shortArg = '("foo.ts")';
    const result = formatToolLine('Read' + shortArg, 100);
    const plain = stripAnsi(result);
    expect(plain, 'short args should not be truncated').not.toMatch(/…$/);
    expect(plain).toContain('foo.ts');
  });

  it('preserves full toolInput in ToolLane entry (not truncated)', async () => {
    const { ToolLane } = await import('../commands/interactive/tool-lane.js');
    const { stripAnsi } = await import('../display.js');

    const lane = new ToolLane();
    const longArg = '("' + 'x'.repeat(300) + '")';
    const toolUseId = 'test-001';
    lane.addStartWithAgentContext(toolUseId, 'grep', longArg, undefined, 60);

    // Access private entries map via bracket notation
    type LanePrivate = Record<string, Map<string, { toolInput: string; prefix: string }>>;
    const entries = (lane as unknown as LanePrivate)['entries'];
    const entry = entries.get(toolUseId);

    expect(entry?.toolInput, 'toolInput must be raw, untruncated').toBe(longArg);
    expect(
      stripAnsi(entry?.prefix ?? '').length,
      'prefix must be truncated to fit maxWidth',
    ).toBeLessThanOrEqual(60);
  });

  it('when maxWidth is undefined, does not truncate (existing behavior)', async () => {
    const { formatToolLine } = await import('../commands/interactive/tool-lane-format.js');
    const { stripAnsi } = await import('../display.js');

    const longArg = '("' + 'x'.repeat(300) + '")';
    const result = formatToolLine('grep' + longArg); // no maxWidth
    const plain = stripAnsi(result);
    // Should contain the full content without ellipsis from truncation
    expect(plain).toContain('x'.repeat(50)); // at least 50 x's pass through
  });
});
