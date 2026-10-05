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

  it.each([
    ['read_file', 'Reading'],
    ['edit_file', 'Writing'],
    ['write_file', 'Writing'],
    ['bash', 'Running'],
    ['agent', 'Delegating'],
    ['skill', 'Running skill'],
    ['compose', 'Coordinating'],
    ['mcp__server__do_thing', 'Calling plugin'],
    ['wait_for', 'Waiting'],
    ['test_run', 'Testing'],
    ['send_telegram', 'Notifying'],
    ['image_generate', 'Generating'],
    ['image_edit', 'Generating'],
    ['ask_question', 'Asking'],
    ['grep', 'Searching'],
    ['glob', 'Searching'],
    ['memory_search', 'Recalling'],
    ['memory_update', 'Remembering'],
    ['patch_apply', 'Patching'],
    ['config_set', 'Configuring'],
    ['cancel_background_job', 'Cancelling'],
    ['list_schedules', 'Reading'],
    ['get_schedule_history', 'Reading'],
    ['cancel_schedule', 'Cancelling'],
  ])('describes %s as %s without a trailing ellipsis', (name, expected) => {
    expect(verbForToolName(name)).toBe(expected);
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

describe('InFlightToolTracker.currentVerb', () => {
  it('returns undefined while idle', () => {
    expect(new InFlightToolTracker().currentVerb()).toBeUndefined();
  });

  it('returns the verb for a single in-flight tool', () => {
    const t = new InFlightToolTracker();
    t.start('t1', 'bash');
    expect(t.currentVerb()).toBe('Running');
  });

  it('returns undefined once the only tool finishes', () => {
    const t = new InFlightToolTracker();
    t.start('t1', 'bash');
    t.finish('t1');
    expect(t.currentVerb()).toBeUndefined();
  });

  it('unanimous verb — all tools share the same verb', () => {
    // `grep` and `glob` both resolve to "Searching"
    const t = new InFlightToolTracker();
    t.start('t1', 'grep');
    t.start('t2', 'glob');
    expect(t.currentVerb()).toBe('Searching');
  });

  it('unanimous verb — all tools share the same verb (different overrides with matching text)', () => {
    // `read_file` and `list_schedules` both resolve to "Reading"
    const t = new InFlightToolTracker();
    t.start('t1', 'read_file');
    t.start('t2', 'list_schedules');
    expect(t.currentVerb()).toBe('Reading');
  });

  it('unanimous category but different verbs — shows category verb', () => {
    // `bash` → "Running", `test_run` → "Testing", but both are in "shell" category
    const t = new InFlightToolTracker();
    t.start('t1', 'bash');
    t.start('t2', 'test_run');
    expect(t.currentVerb()).toBe('Running');
  });

  it('mixed categories — shows "Working" instead of privileging the last-started tool', () => {
    // `agent` (subagent category) + `wait_for` (planning/other) — the bug case
    const t = new InFlightToolTracker();
    t.start('t1', 'agent');
    t.start('t2', 'wait_for');
    // Before the fix this returned 'wait_for' (last-started), giving "Waiting…"
    expect(t.currentVerb()).toBe('Working');
  });

  it('mixed categories with many tools — still shows "Working"', () => {
    const t = new InFlightToolTracker();
    t.start('t1', 'agent');    // subagent
    t.start('t2', 'read_file'); // read
    t.start('t3', 'bash');     // shell
    expect(t.currentVerb()).toBe('Working');
  });

  it('stays stable as siblings finish in a mixed-category wave', () => {
    // While any tool remains, the verb must never blank.
    const t = new InFlightToolTracker();
    t.start('t1', 'agent');
    t.start('t2', 'wait_for');
    expect(t.currentVerb()).toBe('Working');
    t.finish('t2');
    // Now only `agent` remains — back to the specific verb.
    expect(t.currentVerb()).toBe('Delegating');
    t.finish('t1');
    expect(t.currentVerb()).toBeUndefined();
  });

  it('reset() clears the verb', () => {
    const t = new InFlightToolTracker();
    t.start('t1', 'bash');
    t.reset();
    expect(t.currentVerb()).toBeUndefined();
  });

  it('never returns a trailing ellipsis', () => {
    const t = new InFlightToolTracker();
    for (const tool of ['bash', 'agent', 'read_file', 'wait_for', 'some_unknown_tool']) {
      t.reset();
      t.start('t1', tool);
      const verb = t.currentVerb();
      if (verb !== undefined) {
        expect(verb).not.toMatch(/…$/);
      }
    }
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

  it('pushes the resolved verb (not the raw tool name) on a tool start', () => {
    // The sink receives a pre-resolved verb so the compositor can use it
    // directly without a second verbForToolName lookup.
    const t = new InFlightToolTracker();
    const sink = sinkSpy();
    const handled = noteToolEvent(
      { type: 'chunk', chunk: { type: 'tool_use_detail', toolUseId: 'a', toolName: 'bash' } },
      t, sink,
    );
    expect(handled).toBe(true);
    expect(sink.seen).toEqual(['Running']);
  });

  it('pushes "Working" when a mixed-category wave is in flight', () => {
    // The canonical bug case: agent + wait_for should say "Working", not "Waiting".
    const t = new InFlightToolTracker();
    const sink = sinkSpy();
    noteToolEvent({ type: 'chunk', chunk: { type: 'tool_use_detail', toolUseId: 'a', toolName: 'agent' } }, t, sink);
    noteToolEvent({ type: 'chunk', chunk: { type: 'tool_use_detail', toolUseId: 'b', toolName: 'wait_for' } }, t, sink);
    // First event: only `agent` in flight → "Delegating"
    // Second event: `agent` + `wait_for` → mixed categories → "Working"
    expect(sink.seen).toEqual(['Delegating', 'Working']);
  });

  it('pushes undefined once the last tool completes', () => {
    const t = new InFlightToolTracker();
    const sink = sinkSpy();
    noteToolEvent({ type: 'chunk', chunk: { type: 'tool_use_detail', toolUseId: 'a', toolName: 'bash' } }, t, sink);
    noteToolEvent({ type: 'chunk', chunk: { type: 'tool_result', toolUseId: 'a' } }, t, sink);
    expect(sink.seen).toEqual(['Running', undefined]);
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
