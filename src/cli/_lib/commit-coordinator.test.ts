/**
 * commit-coordinator.test.ts — Unit tests for CommitCoordinator
 *
 * Tests verify:
 *   - schedule() is synchronous (no await needed, no I/O side-effects)
 *   - Drain order: before-content → streamingMarkdown.flush → after-subagent → after-content
 *   - Idempotent flushAll (second call is a no-op)
 *   - Multiple batches at the same anchor drain in schedule order
 *   - after-subagent batches drain in registration order (multiple ids)
 *   - Empty queue flushAll is a no-op
 */

import { describe, it, expect, vi } from 'vitest';
import { CommitCoordinator } from './commit-coordinator.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeLog(): { log: string[]; commit: (label: string) => () => void } {
  const log: string[] = [];
  const commit = (label: string) => () => { log.push(label); };
  return { log, commit };
}

async function makeMarkdownFlush(log: string[], label: string): Promise<() => Promise<void>> {
  return async () => {
    log.push(label);
  };
}

// ─── schedule() is synchronous ───────────────────────────────────────────────

describe('CommitCoordinator — schedule() is synchronous', () => {
  it('schedule() returns void synchronously — no awaiting needed', () => {
    const coordinator = new CommitCoordinator();
    const { commit } = makeLog();

    // schedule() must be synchronous: calling it does not produce a Promise,
    // does not call commitAbove, and does not perform any I/O.
    const result = coordinator.schedule({
      anchor: 'before-content',
      commits: [commit('x')],
    });

    // Returns void (not a Promise)
    expect(result).toBeUndefined();
  });

  it('schedule() does NOT call commit closures immediately', () => {
    const coordinator = new CommitCoordinator();
    const { log, commit } = makeLog();

    coordinator.schedule({ anchor: 'before-content', commits: [commit('a')] });
    coordinator.schedule({ anchor: 'after-content', commits: [commit('b')] });
    coordinator.schedule({ anchor: 'after-subagent:id1', commits: [commit('c')] });

    // No closures should have fired yet — schedule() is purely queue mutation.
    expect(log).toHaveLength(0);
  });
});

// ─── drain order ─────────────────────────────────────────────────────────────

describe('CommitCoordinator — drain order', () => {
  it('drains: before-content → markdown flush → after-subagent → after-content', async () => {
    const coordinator = new CommitCoordinator();
    const log: string[] = [];

    coordinator.schedule({ anchor: 'after-content', commits: [() => log.push('after-content')] });
    coordinator.schedule({ anchor: 'after-subagent:s1', commits: [() => log.push('after-subagent:s1')] });
    coordinator.schedule({ anchor: 'before-content', commits: [() => log.push('before-content')] });

    const markdownFlush = async () => { log.push('markdown-flush'); };

    await coordinator.flushAll(markdownFlush);

    // External constraint (Bug #1 ordering invariant):
    // before-content → markdown-flush → after-subagent → after-content
    expect(log).toEqual([
      'before-content',
      'markdown-flush',
      'after-subagent:s1',
      'after-content',
    ]);
  });

  it('runs markdown flush AFTER before-content commits and BEFORE after-subagent commits', async () => {
    const coordinator = new CommitCoordinator();
    const log: string[] = [];

    coordinator.schedule({ anchor: 'after-subagent:s1', commits: [() => log.push('subagent')] });
    coordinator.schedule({ anchor: 'before-content', commits: [() => log.push('before')] });

    await coordinator.flushAll(async () => { log.push('md-flush'); });

    expect(log.indexOf('before')).toBeLessThan(log.indexOf('md-flush'));
    expect(log.indexOf('md-flush')).toBeLessThan(log.indexOf('subagent'));
  });

  it('works with no markdown flush (undefined) — skips step 2', async () => {
    const coordinator = new CommitCoordinator();
    const log: string[] = [];

    coordinator.schedule({ anchor: 'before-content', commits: [() => log.push('before')] });
    coordinator.schedule({ anchor: 'after-content', commits: [() => log.push('after')] });

    // No markdown flush passed — should be a no-op for step 2
    await coordinator.flushAll(undefined);

    expect(log).toEqual(['before', 'after']);
  });
});

// ─── multiple batches at same anchor drain in schedule order ─────────────────

describe('CommitCoordinator — multiple batches at same anchor', () => {
  it('before-content batches drain in schedule order', async () => {
    const coordinator = new CommitCoordinator();
    const log: string[] = [];

    coordinator.schedule({ anchor: 'before-content', commits: [() => log.push('bc-1')] });
    coordinator.schedule({ anchor: 'before-content', commits: [() => log.push('bc-2')] });
    coordinator.schedule({ anchor: 'before-content', commits: [() => log.push('bc-3')] });

    await coordinator.flushAll();

    expect(log).toEqual(['bc-1', 'bc-2', 'bc-3']);
  });

  it('after-content batches drain in schedule order', async () => {
    const coordinator = new CommitCoordinator();
    const log: string[] = [];

    coordinator.schedule({ anchor: 'after-content', commits: [() => log.push('ac-1')] });
    coordinator.schedule({ anchor: 'after-content', commits: [() => log.push('ac-2')] });

    await coordinator.flushAll();

    expect(log).toEqual(['ac-1', 'ac-2']);
  });

  it('multiple commits within a single batch drain in array order', async () => {
    const coordinator = new CommitCoordinator();
    const log: string[] = [];

    coordinator.schedule({
      anchor: 'before-content',
      commits: [
        () => log.push('commit-1'),
        () => log.push('commit-2'),
        () => log.push('commit-3'),
      ],
    });

    await coordinator.flushAll();

    expect(log).toEqual(['commit-1', 'commit-2', 'commit-3']);
  });
});

// ─── after-subagent batches drain in registration order ──────────────────────

describe('CommitCoordinator — after-subagent registration order', () => {
  it('after-subagent:* batches drain in registration (insertion) order across multiple ids', async () => {
    const coordinator = new CommitCoordinator();
    const log: string[] = [];

    // Register multiple distinct subagent ids
    coordinator.schedule({ anchor: 'after-subagent:s3', commits: [() => log.push('s3')] });
    coordinator.schedule({ anchor: 'after-subagent:s1', commits: [() => log.push('s1')] });
    coordinator.schedule({ anchor: 'after-subagent:s2', commits: [() => log.push('s2')] });

    await coordinator.flushAll();

    // Must drain in registration order: s3 first, then s1, then s2
    expect(log).toEqual(['s3', 's1', 's2']);
  });

  it('multiple batches for the same after-subagent id drain in schedule order', async () => {
    const coordinator = new CommitCoordinator();
    const log: string[] = [];

    coordinator.schedule({ anchor: 'after-subagent:s1', commits: [() => log.push('s1-a')] });
    coordinator.schedule({ anchor: 'after-subagent:s1', commits: [() => log.push('s1-b')] });

    await coordinator.flushAll();

    expect(log).toEqual(['s1-a', 's1-b']);
  });

  it('after-subagent drains AFTER markdown flush and BEFORE after-content', async () => {
    const coordinator = new CommitCoordinator();
    const log: string[] = [];

    coordinator.schedule({ anchor: 'after-subagent:s1', commits: [() => log.push('subagent')] });
    coordinator.schedule({ anchor: 'after-content', commits: [() => log.push('after-content')] });

    await coordinator.flushAll(async () => { log.push('md'); });

    expect(log).toEqual(['md', 'subagent', 'after-content']);
  });
});

// ─── idempotent flushAll ─────────────────────────────────────────────────────

describe('CommitCoordinator — idempotent flushAll', () => {
  it('calling flushAll twice only drains once — second call is a no-op', async () => {
    const coordinator = new CommitCoordinator();
    const log: string[] = [];

    coordinator.schedule({ anchor: 'before-content', commits: [() => log.push('bc')] });
    coordinator.schedule({ anchor: 'after-subagent:s1', commits: [() => log.push('sa')] });
    coordinator.schedule({ anchor: 'after-content', commits: [() => log.push('ac')] });

    await coordinator.flushAll(async () => { log.push('md'); });

    const afterFirst = [...log];

    // Second call — all queues are now empty, markdown flush also skipped
    await coordinator.flushAll(async () => { log.push('md-SECOND'); });

    // log should be unchanged after the second call
    // (markdown flush param is still called but since all batches are drained
    //  the second call is otherwise a no-op for commit closures)
    // The markdown flush IS called again (it's a parameter, not tracked) —
    // but no commit closures fire.
    const commitCallsAfterSecond = log.filter((l) => !l.startsWith('md'));
    const commitCallsAfterFirst = afterFirst.filter((l) => !l.startsWith('md'));
    expect(commitCallsAfterSecond).toEqual(commitCallsAfterFirst);
  });

  it('flushAll on empty coordinator is a no-op', async () => {
    const coordinator = new CommitCoordinator();
    const log: string[] = [];

    // No schedules — should complete without error
    await expect(coordinator.flushAll(async () => { log.push('md'); })).resolves.toBeUndefined();

    // Markdown flush may or may not be called — only commit closures are checked
    const commitCalls = log.filter((l) => !l.startsWith('md'));
    expect(commitCalls).toHaveLength(0);
  });
});

// ─── markdown flush error handling ───────────────────────────────────────────

describe('CommitCoordinator — markdown flush error handling', () => {
  it('continues draining after-subagent/after-content even if markdownFlush throws', async () => {
    const coordinator = new CommitCoordinator();
    const log: string[] = [];

    coordinator.schedule({ anchor: 'after-subagent:s1', commits: [() => log.push('s1')] });
    coordinator.schedule({ anchor: 'after-content', commits: [() => log.push('ac')] });

    const throwingFlush = async (): Promise<void> => {
      throw new Error('markdown flush failed');
    };

    // Should not throw — best-effort flush mirrors StreamRenderer.dispose() behavior
    await expect(coordinator.flushAll(throwingFlush)).resolves.toBeUndefined();

    // after-subagent and after-content must still drain
    expect(log).toContain('s1');
    expect(log).toContain('ac');
  });
});

// ─── drainSubagent (eager per-source drain) ─────────────────────────────────

describe('CommitCoordinator — drainSubagent', () => {
  it('drains only the targeted after-subagent batch, leaving others queued', async () => {
    const coordinator = new CommitCoordinator();
    const log: string[] = [];

    coordinator.schedule({ anchor: 'after-subagent:s1', commits: [() => log.push('s1')] });
    coordinator.schedule({ anchor: 'after-subagent:s2', commits: [() => log.push('s2')] });
    coordinator.schedule({ anchor: 'after-content', commits: [() => log.push('ac')] });

    coordinator.drainSubagent('s1');

    expect(log).toEqual(['s1']);

    // s2 and after-content still queued — drain via flushAll
    await coordinator.flushAll();
    expect(log).toEqual(['s1', 's2', 'ac']);
  });

  it('drains before-content batches first (ordering invariant step 1)', () => {
    const coordinator = new CommitCoordinator();
    const log: string[] = [];

    coordinator.schedule({ anchor: 'before-content', commits: [() => log.push('bc')] });
    coordinator.schedule({ anchor: 'after-subagent:s1', commits: [() => log.push('s1')] });

    coordinator.drainSubagent('s1');

    expect(log).toEqual(['bc', 's1']);
  });

  it('is idempotent — second call for same id is a no-op', () => {
    const coordinator = new CommitCoordinator();
    const log: string[] = [];

    coordinator.schedule({ anchor: 'after-subagent:s1', commits: [() => log.push('s1')] });

    coordinator.drainSubagent('s1');
    coordinator.drainSubagent('s1');

    expect(log).toEqual(['s1']);
  });

  it('no-op when id has no scheduled batches', () => {
    const coordinator = new CommitCoordinator();
    const log: string[] = [];

    coordinator.schedule({ anchor: 'after-subagent:s1', commits: [() => log.push('s1')] });

    // Drain a non-existent id — should not throw or drain s1
    coordinator.drainSubagent('nonexistent');

    expect(log).toEqual([]);
  });

  it('drained batch does not re-fire in subsequent flushAll', async () => {
    const coordinator = new CommitCoordinator();
    const log: string[] = [];

    coordinator.schedule({ anchor: 'after-subagent:s1', commits: [() => log.push('s1')] });

    coordinator.drainSubagent('s1');
    expect(log).toEqual(['s1']);

    // flushAll should not re-fire s1
    await coordinator.flushAll();
    expect(log).toEqual(['s1']);
  });
});

// ─── full end-to-end drain scenario (Bug #1 ordering) ────────────────────────

describe('CommitCoordinator — Bug #1 ordering scenario', () => {
  it('pre-skill markdown content appears BEFORE subagent result block', async () => {
    // Scenario mirrors the Bug #1 test in stream-renderer-ordering.test.ts:
    //   - Pre-skill content is in the markdown renderer (flushed async via step 2)
    //   - Subagent result block is scheduled as after-subagent (step 3)
    //   - Correct order: markdown content → subagent block
    const coordinator = new CommitCoordinator();
    const scrollback: string[] = [];

    // Subagent done path schedules the skill block as after-subagent
    coordinator.schedule({
      anchor: 'after-subagent:skill-sa-1',
      commits: [
        () => scrollback.push('[skill-block-line-1]'),
        () => scrollback.push('[skill-block-line-2]'),
      ],
    });

    // Markdown flush writes pre-skill content (async, step 2)
    const markdownFlush = async () => {
      scrollback.push('[md:pre-skill content]');
    };

    await coordinator.flushAll(markdownFlush);

    const mdIdx = scrollback.findIndex((l) => l.includes('pre-skill'));
    const skillIdx = scrollback.findIndex((l) => l.includes('skill-block'));

    // Bug #1 fix invariant: pre-skill content appears before skill block
    expect(mdIdx).toBeGreaterThanOrEqual(0);
    expect(skillIdx).toBeGreaterThanOrEqual(0);
    expect(mdIdx).toBeLessThan(skillIdx);
  });
});
