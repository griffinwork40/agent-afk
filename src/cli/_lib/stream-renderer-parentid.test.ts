/**
 * Regression tests for the parentId_fallback_unresolved path in StreamRenderer.
 *
 * Edit A fix: the fallback debug log must NOT write to process.stdout (which
 * would corrupt the TerminalCompositor overlay). It is now gated behind
 * isDebugEnabled() and routed to process.stderr only.
 *
 * These tests assert:
 * 1. No stdout write occurs when a subagent event arrives with an unresolvable
 *    parentId (Path 3 — the parentId_fallback_unresolved branch).
 * 2. The renderer continues to process subsequent events normally after Path 3.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { StreamRenderer } from './stream-renderer.js';
import type { Writer } from '../slash/types.js';
import type { OutputEvent, SubagentProgressMeta } from '../../agent/types.js';

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

function doneEvent(): OutputEvent {
  return { type: 'done' };
}

function contentEvent(chunk: string): OutputEvent {
  return { type: 'chunk', chunk: { type: 'content', content: chunk } };
}

/**
 * Build a SubagentProgressMeta that will exercise Path 3 (parentId present but
 * unresolvable — not in sources map, not in toolLane).
 */
function metaWithUnresolvableParentId(subagentId: string): SubagentProgressMeta {
  return {
    subagentId,
    parentId: 'phantom-session-uuid-that-does-not-exist',
  };
}

describe('StreamRenderer — parentId_fallback_unresolved (Edit A regression)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    // Ensure AFK_DEBUG is not set between tests
    delete process.env['AFK_DEBUG'];
    delete process.env['DEBUG'];
  });

  it('does NOT write to process.stdout when a subagent event hits Path 3 (AFK_DEBUG unset)', async () => {
    const { writer } = makeWriter();
    const stdoutSpy = vi.spyOn(process.stdout, 'write');

    const r = new StreamRenderer({ out: writer, forceNonTty: true });

    // First event registers the source. Second event (with done) exercises
    // the synthesizeAgentEntry path. The parentId is unresolvable — no source
    // with that id exists — so Path 3 fires.
    const m = metaWithUnresolvableParentId('depth-1-source');
    r.process(contentEvent('hello from nested'), m);
    r.process(doneEvent(), m);
    await r.dispose();

    // Must not have written anything to stdout (would corrupt TerminalCompositor).
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('does NOT call console.debug when a subagent event hits Path 3', async () => {
    const { writer } = makeWriter();
    const debugSpy = vi.spyOn(console, 'debug');

    const r = new StreamRenderer({ out: writer, forceNonTty: true });

    const m = metaWithUnresolvableParentId('depth-1-source-b');
    r.process(contentEvent('nested content'), m);
    r.process(doneEvent(), m);
    await r.dispose();

    expect(debugSpy).not.toHaveBeenCalledWith(
      '[stream-renderer] parentId_fallback_unresolved',
      expect.anything(),
    );
  });

  it('writes to process.stderr (not stdout) when AFK_DEBUG=1 and Path 3 fires', async () => {
    process.env['AFK_DEBUG'] = '1';

    const { writer } = makeWriter();
    const stdoutSpy = vi.spyOn(process.stdout, 'write');
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const r = new StreamRenderer({ out: writer, forceNonTty: true });

    const m = metaWithUnresolvableParentId('depth-1-source-c');
    r.process(contentEvent('debug mode nested'), m);
    r.process(doneEvent(), m);
    await r.dispose();

    // stderr gets the debug message; stdout is untouched
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('parentId_fallback_unresolved'),
    );
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('renderer continues to process events normally after Path 3 fires', async () => {
    const { writer, lines } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });

    // Path 3 subagent event
    const m = metaWithUnresolvableParentId('depth-1-source-d');
    r.process(contentEvent('nested work'), m);
    r.process(doneEvent(), m);

    // Orchestrator events following the Path 3 source — must render normally
    r.process(contentEvent('orchestrator content\n\n'));
    r.process(doneEvent());
    await r.dispose();

    const output = lines.join('\n');
    expect(output).toContain('orchestrator content');
  });
});
