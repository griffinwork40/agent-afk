/**
 * Tests for work-derived spinner verbs.
 *
 * The point of this module is honesty: the verb slot previously rotated random
 * flavour words, implying state changes that never happened. Two properties
 * matter most here — an idle session must NOT claim an activity, and a parallel
 * wave must not blank the verb when one of many concurrent tools finishes.
 */

import { describe, it, expect } from 'vitest';
import { verbForToolName, InFlightToolTracker, noteToolEvent } from './work-derived-verb.js';

describe('verbForToolName', () => {
  it('returns undefined when no tool is in flight', () => {
    // Undefined routes the spinner back to its flavour pool — idle time has no
    // work to describe, and inventing one would be the original lie.
    expect(verbForToolName(undefined)).toBeUndefined();
    expect(verbForToolName('')).toBeUndefined();
    expect(verbForToolName('   ')).toBeUndefined();
  });

  it('describes read tools as Reading', () => {
    expect(verbForToolName('read_file')).toBe('Reading');
    expect(verbForToolName('grep')).toBe('Reading');
  });

  it('describes mutation tools as Editing', () => {
    expect(verbForToolName('edit_file')).toBe('Editing');
    expect(verbForToolName('write_file')).toBe('Editing');
  });

  it('describes shell tools as Running', () => {
    expect(verbForToolName('bash')).toBe('Running');
  });

  it('describes dispatch tools by their dispatch class', () => {
    expect(verbForToolName('agent')).toBe('Delegating');
    expect(verbForToolName('skill')).toBe('Orchestrating');
    expect(verbForToolName('compose')).toBe('Orchestrating');
  });

  it('describes MCP tools as Calling', () => {
    expect(verbForToolName('mcp__server__do_thing')).toBe('Calling');
  });

  it('falls back to a deliberately vague verb for uncategorized tools', () => {
    // `other` is the catch-all bucket, so any specific claim risks being wrong.
    expect(verbForToolName('some_unknown_future_tool')).toBe('Working');
  });

  it('always returns a capitalized present participle', () => {
    for (const name of ['read_file', 'bash', 'agent', 'web_scrape', 'unknown_x']) {
      const verb = verbForToolName(name)!;
      expect(verb).toMatch(/^[A-Z][a-z]+ing$/);
    }
  });
});

describe('InFlightToolTracker', () => {
  it('reports undefined while idle', () => {
    expect(new InFlightToolTracker().current()).toBeUndefined();
  });

  it('reports a started tool', () => {
    const t = new InFlightToolTracker();
    t.start('t1', 'bash');
    expect(t.current()).toBe('bash');
  });

  it('reports the most recently started tool', () => {
    const t = new InFlightToolTracker();
    t.start('t1', 'bash');
    t.start('t2', 'read_file');
    expect(t.current()).toBe('read_file');
  });

  it('goes idle once the only tool finishes', () => {
    const t = new InFlightToolTracker();
    t.start('t1', 'bash');
    t.finish('t1');
    expect(t.current()).toBeUndefined();
  });

  it('KEEPS a verb when one of several concurrent tools finishes', () => {
    // The parallel-wave invariant: a fan-out has many tools in flight, and one
    // completing must not blank the verb while siblings are still working.
    const t = new InFlightToolTracker();
    t.start('t1', 'bash');
    t.start('t2', 'read_file');
    t.start('t3', 'grep');
    t.finish('t3');
    expect(t.current()).toBe('read_file');
    t.finish('t2');
    expect(t.current()).toBe('bash');
    t.finish('t1');
    expect(t.current()).toBeUndefined();
  });

  it('ignores completion of an unknown id', () => {
    const t = new InFlightToolTracker();
    t.start('t1', 'bash');
    t.finish('nope');
    expect(t.current()).toBe('bash');
  });

  it('moves a repeated id to the front rather than keeping a stale position', () => {
    const t = new InFlightToolTracker();
    t.start('t1', 'bash');
    t.start('t2', 'read_file');
    t.start('t1', 'grep');
    expect(t.current()).toBe('grep');
  });

  it('reset() drops all tracking so no id can pin a stale verb', () => {
    const t = new InFlightToolTracker();
    t.start('t1', 'bash');
    t.reset();
    expect(t.current()).toBeUndefined();
  });
});

describe('noteToolEvent', () => {
  const sinkSpy = () => {
    const seen: Array<string | undefined> = [];
    return { seen, setActiveToolName: (n: string | undefined) => seen.push(n) };
  };

  it('ignores non-chunk events', () => {
    const t = new InFlightToolTracker();
    const sink = sinkSpy();
    expect(noteToolEvent({ type: 'progress' }, t, sink)).toBe(false);
    expect(sink.seen).toEqual([]);
  });

  it('ignores non-tool chunks such as content and thinking', () => {
    const t = new InFlightToolTracker();
    const sink = sinkSpy();
    expect(noteToolEvent({ type: 'chunk', chunk: { type: 'content' } }, t, sink)).toBe(false);
    expect(sink.seen).toEqual([]);
  });

  it('pushes the tool name on a tool start', () => {
    const t = new InFlightToolTracker();
    const sink = sinkSpy();
    const handled = noteToolEvent(
      { type: 'chunk', chunk: { type: 'tool_use_detail', toolUseId: 'a', toolName: 'bash' } },
      t, sink,
    );
    expect(handled).toBe(true);
    expect(sink.seen).toEqual(['bash']);
  });

  it('pushes undefined once the last tool completes', () => {
    const t = new InFlightToolTracker();
    const sink = sinkSpy();
    noteToolEvent({ type: 'chunk', chunk: { type: 'tool_use_detail', toolUseId: 'a', toolName: 'bash' } }, t, sink);
    noteToolEvent({ type: 'chunk', chunk: { type: 'tool_result', toolUseId: 'a' } }, t, sink);
    expect(sink.seen).toEqual(['bash', undefined]);
  });

  it('tolerates a sink that does not implement the setter', () => {
    // Partial compositor mocks are common in this repo; a cosmetic verb must
    // never throw inside the event path.
    const t = new InFlightToolTracker();
    expect(() =>
      noteToolEvent(
        { type: 'chunk', chunk: { type: 'tool_use_detail', toolUseId: 'a', toolName: 'bash' } },
        t, {},
      ),
    ).not.toThrow();
  });

  it('tolerates a null sink', () => {
    const t = new InFlightToolTracker();
    expect(() =>
      noteToolEvent(
        { type: 'chunk', chunk: { type: 'tool_use_detail', toolUseId: 'a', toolName: 'bash' } },
        t, null,
      ),
    ).not.toThrow();
    expect(t.current()).toBe('bash');
  });

  it('ignores a tool chunk with no toolUseId', () => {
    const t = new InFlightToolTracker();
    const sink = sinkSpy();
    expect(noteToolEvent({ type: 'chunk', chunk: { type: 'tool_use_detail', toolName: 'bash' } }, t, sink)).toBe(false);
    expect(sink.seen).toEqual([]);
  });
});
