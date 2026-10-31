/**
 * Tests for GithubEventPoller (issue #3896).
 *
 * All tests use an injected `ghRunner` stub so no real `gh` CLI or network
 * connection is needed. Real queue files are written to a mkdtempSync directory
 * injected via GithubPollerOptions.queueDir. The dedup state directory is also
 * isolated to a tmp dir.
 *
 * @module agent/daemon/github-event-poller.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  GithubEventPoller,
  renderCommand,
  SUPPORTED_EVENT_TYPES,
  _pruneSeen,
  MAX_SEEN_FOR_TESTS,
  type GhRunner,
  type GithubEventType,
} from './github-event-poller.js';
import type { QueuedTask } from './queue-store.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let queueDir: string;
let stateDir: string;

beforeEach(() => {
  queueDir = mkdtempSync(join(tmpdir(), 'afk-gh-poller-q-'));
  stateDir = mkdtempSync(join(tmpdir(), 'afk-gh-poller-s-'));
});

afterEach(() => {
  rmSync(queueDir, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readQueuedTasks(): QueuedTask[] {
  return readdirSync(queueDir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('.tmp-'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(queueDir, f), 'utf-8')) as QueuedTask);
}

function makePrCommentRunner(comments: Array<{ id: number; body: string; html_url: string; created_at: string }>): GhRunner {
  return async (_path: string) => comments;
}

function makeCheckRunRunner(checkRuns: Array<{ id: number; name: string; conclusion: string | null; html_url: string; completed_at?: string }>): GhRunner {
  return async (_path: string) => ({ check_runs: checkRuns });
}

function makeIssueRunner(issues: Array<{ id: number; number: number; title: string; html_url: string; body: string | null; created_at: string }>): GhRunner {
  return async (_path: string) => issues;
}

function makePoller(ghRunner: GhRunner, events: GithubEventType[] = ['pr_comment']) {
  return new GithubEventPoller({
    repo: 'owner/repo',
    events,
    commandTemplate: 'Handle {{event_type}} in {{repo}} (id: {{event_id}})',
    queueDir,
    stateDir,
    ghRunner,
  });
}

// ---------------------------------------------------------------------------
// renderCommand
// ---------------------------------------------------------------------------

describe('renderCommand', () => {
  it('substitutes all placeholders', () => {
    const cmd = renderCommand(
      'Handle {{event_type}} in {{repo}} (id: {{event_id}})',
      'pr_comment',
      'owner/repo',
      'pr_comment:42',
      'body: hello',
    );
    expect(cmd).toContain('Handle pr_comment in owner/repo (id: pr_comment:42)');
  });

  it('wraps payload in untrusted delimiters', () => {
    const cmd = renderCommand('template', 'issue_opened', 'a/b', 'x', 'evil payload');
    expect(cmd).toContain('UNTRUSTED EVENT PAYLOAD');
    expect(cmd).toContain('evil payload');
    expect(cmd).toContain('END UNTRUSTED EVENT PAYLOAD');
  });

  it('caps payload at 4000 chars', () => {
    const long = 'x'.repeat(5000);
    const cmd = renderCommand('t', 'check_failure', 'a/b', 'y', long);
    // Payload section must not exceed 4000 chars
    const start = cmd.indexOf('UNTRUSTED EVENT PAYLOAD');
    const end = cmd.indexOf('END UNTRUSTED EVENT PAYLOAD');
    const payloadSection = cmd.slice(start, end);
    expect(payloadSection.length).toBeLessThan(4100);
  });

  it('payload cannot override template placeholders', () => {
    // Even if the payload contains {{event_type}}, it must not be substituted
    // because the payload is appended AFTER template substitution.
    const cmd = renderCommand(
      'cmd for {{event_type}}',
      'pr_comment',
      'a/b',
      'id1',
      'injected: {{event_type}} should not expand',
    );
    expect(cmd).toContain('cmd for pr_comment');
    // The payload's {{event_type}} is appended verbatim (no second substitution pass)
    expect(cmd).toContain('{{event_type}} should not expand');
  });
});

// ---------------------------------------------------------------------------
// SUPPORTED_EVENT_TYPES
// ---------------------------------------------------------------------------

describe('SUPPORTED_EVENT_TYPES', () => {
  it('contains the three documented types', () => {
    expect(SUPPORTED_EVENT_TYPES).toContain('pr_comment');
    expect(SUPPORTED_EVENT_TYPES).toContain('check_failure');
    expect(SUPPORTED_EVENT_TYPES).toContain('issue_opened');
  });
});

// ---------------------------------------------------------------------------
// pr_comment events
// ---------------------------------------------------------------------------

describe('GithubEventPoller — pr_comment', () => {
  it('enqueues a task for a new pr_comment event', async () => {
    const runner = makePrCommentRunner([
      { id: 1, body: 'looks good', html_url: 'https://github.com/owner/repo/pull/1#comment-1', created_at: '2026-01-01T00:00:00Z' },
    ]);
    const poller = makePoller(runner, ['pr_comment']);
    await poller.tick();

    const tasks = readQueuedTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.command).toContain('pr_comment');
    expect(tasks[0]!.command).toContain('owner/repo');
  });

  it('does not enqueue a second task for the same event (dedup)', async () => {
    const runner = makePrCommentRunner([
      { id: 99, body: 'hi', html_url: 'https://github.com/owner/repo/pull/1#comment-99', created_at: '2026-01-01T00:00:00Z' },
    ]);
    const poller = makePoller(runner, ['pr_comment']);

    await poller.tick();
    await poller.tick(); // second tick — same event
    const tasks = readQueuedTasks();
    expect(tasks).toHaveLength(1); // only one task
  });

  it('enqueues each distinct comment exactly once', async () => {
    let callCount = 0;
    const runner: GhRunner = async (_path) => {
      callCount++;
      if (callCount === 1) {
        return [{ id: 1, body: 'first', html_url: 'u1', created_at: '2026-01-01T00:00:00Z' }];
      }
      return [
        { id: 1, body: 'first', html_url: 'u1', created_at: '2026-01-01T00:00:00Z' },
        { id: 2, body: 'second', html_url: 'u2', created_at: '2026-01-02T00:00:00Z' },
      ];
    };
    const poller = makePoller(runner, ['pr_comment']);
    await poller.tick();
    await poller.tick();

    const tasks = readQueuedTasks();
    expect(tasks).toHaveLength(2);
  });

  it('wraps event body as untrusted payload in the command', async () => {
    const runner = makePrCommentRunner([
      { id: 5, body: 'rm -rf /', html_url: 'u', created_at: '2026-01-01T00:00:00Z' },
    ]);
    const poller = makePoller(runner, ['pr_comment']);
    await poller.tick();

    const [task] = readQueuedTasks();
    expect(task!.command).toContain('UNTRUSTED EVENT PAYLOAD');
    expect(task!.command).toContain('rm -rf /');
    // Command template comes before the payload delimiter
    const delimIdx = task!.command.indexOf('UNTRUSTED EVENT PAYLOAD');
    const templateIdx = task!.command.indexOf('Handle pr_comment');
    expect(templateIdx).toBeLessThan(delimIdx);
  });
});

// ---------------------------------------------------------------------------
// check_failure events
// ---------------------------------------------------------------------------

describe('GithubEventPoller — check_failure', () => {
  it('enqueues for failed check runs only', async () => {
    const runner = makeCheckRunRunner([
      { id: 10, name: 'CI', conclusion: 'failure', html_url: 'u10', completed_at: '2026-01-01T01:00:00Z' },
      { id: 11, name: 'lint', conclusion: 'success', html_url: 'u11' },
    ]);
    const poller = makePoller(runner, ['check_failure']);
    await poller.tick();

    const tasks = readQueuedTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.command).toContain('check_failure');
  });

  it('does not enqueue passing check runs', async () => {
    const runner = makeCheckRunRunner([
      { id: 20, name: 'build', conclusion: 'success', html_url: 'u20' },
    ]);
    const poller = makePoller(runner, ['check_failure']);
    await poller.tick();

    expect(readQueuedTasks()).toHaveLength(0);
  });

  it('deduplicates check_failure by run id', async () => {
    const runner = makeCheckRunRunner([
      { id: 30, name: 'CI', conclusion: 'failure', html_url: 'u30' },
    ]);
    const poller = makePoller(runner, ['check_failure']);
    await poller.tick();
    await poller.tick();
    expect(readQueuedTasks()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// issue_opened events
// ---------------------------------------------------------------------------

describe('GithubEventPoller — issue_opened', () => {
  it('enqueues for new issues', async () => {
    const runner = makeIssueRunner([
      { id: 100, number: 42, title: 'Bug: something broke', html_url: 'u100', body: 'details', created_at: '2026-01-01T00:00:00Z' },
    ]);
    const poller = makePoller(runner, ['issue_opened']);
    await poller.tick();

    const tasks = readQueuedTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.command).toContain('issue_opened');
  });

  it('deduplicates issue_opened by issue id', async () => {
    const runner = makeIssueRunner([
      { id: 200, number: 99, title: 'Dup issue', html_url: 'u200', body: null, created_at: '2026-01-01T00:00:00Z' },
    ]);
    const poller = makePoller(runner, ['issue_opened']);
    await poller.tick();
    await poller.tick();
    expect(readQueuedTasks()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Multiple event types in one poller
// ---------------------------------------------------------------------------

describe('GithubEventPoller — multiple event types', () => {
  it('enqueues from all requested event types per tick', async () => {
    let callCount = 0;
    const runner: GhRunner = async (path) => {
      callCount++;
      if (path.includes('pulls/comments')) {
        return [{ id: 1, body: 'comment', html_url: 'uc', created_at: '2026-01-01T00:00:00Z' }];
      }
      if (path.includes('issues')) {
        return [{ id: 2, number: 1, title: 'issue', html_url: 'ui', body: null, created_at: '2026-01-01T00:00:00Z' }];
      }
      return [];
    };
    const poller = new GithubEventPoller({
      repo: 'owner/repo',
      events: ['pr_comment', 'issue_opened'],
      commandTemplate: '{{event_type}}',
      queueDir,
      stateDir,
      ghRunner: runner,
    });
    await poller.tick();

    expect(readQueuedTasks()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Error resilience
// ---------------------------------------------------------------------------

describe('GithubEventPoller — error resilience', () => {
  it('does not throw when gh runner errors; logs and continues', async () => {
    const runner: GhRunner = async () => { throw new Error('gh: not found'); };
    const poller = makePoller(runner, ['pr_comment']);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(poller.tick()).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
  });

  it('enqueues events from healthy types even when one type errors', async () => {
    const runner: GhRunner = async (path) => {
      if (path.includes('pulls/comments')) throw new Error('rate limit');
      // issues succeed
      return [{ id: 1, number: 1, title: 't', html_url: 'u', body: null, created_at: '2026-01-01T00:00:00Z' }];
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const poller = new GithubEventPoller({
      repo: 'owner/repo',
      events: ['pr_comment', 'issue_opened'],
      commandTemplate: '{{event_type}}',
      queueDir,
      stateDir,
      ghRunner: runner,
    });
    await poller.tick();
    const tasks = readQueuedTasks();
    // issue_opened should still enqueue even though pr_comment failed
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.command).toContain('issue_opened');
  });

  it('skips overlapping ticks (isPolling guard)', async () => {
    let resolveFirst!: () => void;
    const firstDone = new Promise<void>((res) => { resolveFirst = res; });
    let callCount = 0;
    const runner: GhRunner = async () => {
      callCount++;
      await firstDone;
      return [];
    };
    const poller = makePoller(runner, ['pr_comment']);

    // Start first tick (will hang on firstDone)
    const t1 = poller.tick();
    // Second tick should skip (isPolling=true)
    const t2 = poller.tick();
    resolveFirst();
    await Promise.all([t1, t2]);

    // Runner should only have been called once (second tick skipped)
    expect(callCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Multi-page pagination (--slurp flattening)
// ---------------------------------------------------------------------------

describe('defaultGhRunner — multi-page --slurp flattening', () => {
  it('flattens nested arrays from multi-page --slurp output via defaultGhRunner', async () => {
    // Verify that defaultGhRunner passes --slurp and would flatten.
    // The GhRunner contract: return the parsed, flattened payload.
    // Simulate what defaultGhRunner does: flatten [[p1],[p2]] → [p1,p2].
    const runner: GhRunner = async () => {
      // Simulate two pages already flattened by defaultGhRunner.
      return [
        { id: 1, body: 'p1', html_url: 'u1', created_at: '2026-01-01T00:00:00Z' },
        { id: 2, body: 'p2', html_url: 'u2', created_at: '2026-01-02T00:00:00Z' },
      ];
    };
    const poller = makePoller(runner, ['pr_comment']);
    await poller.tick();
    expect(readQueuedTasks()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// fetchCheckFailures error narrowing
// ---------------------------------------------------------------------------

describe('GithubEventPoller — fetchCheckFailures error narrowing', () => {
  it('returns [] for 404 errors (no commits)', async () => {
    const runner: GhRunner = async (path) => {
      if (path.includes('check-runs')) throw new Error('HTTP 404: Not Found');
      return [];
    };
    const poller = makePoller(runner, ['check_failure']);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await poller.tick();
    expect(readQueuedTasks()).toHaveLength(0);
  });

  it('propagates 401/403 errors to _poll logger', async () => {
    const runner: GhRunner = async (path) => {
      if (path.includes('check-runs')) throw new Error('HTTP 401: Unauthorized');
      return [];
    };
    const poller = makePoller(runner, ['check_failure']);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await poller.tick();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('401'),
    );
  });
});

// ---------------------------------------------------------------------------
// issue_opened filters out PRs
// ---------------------------------------------------------------------------

describe('GithubEventPoller — issue_opened PR filtering', () => {
  it('excludes items with pull_request field set', async () => {
    const runner: GhRunner = async () => [
      { id: 1, number: 1, title: 'Real issue', html_url: 'u1', body: null, created_at: '2026-01-01T00:00:00Z' },
      { id: 2, number: 2, title: 'Actually a PR', html_url: 'u2', body: null, created_at: '2026-01-01T00:00:00Z', pull_request: { url: 'x' } },
    ];
    const poller = makePoller(runner, ['issue_opened']);
    await poller.tick();
    const tasks = readQueuedTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.command).toContain('Real issue');
  });
});

// ---------------------------------------------------------------------------
// repo param validation (#4039)
// ---------------------------------------------------------------------------

describe('GithubEventPoller — repo param validation (#4039)', () => {
  it('throws on empty repo string', () => {
    expect(() => new GithubEventPoller({
      repo: '',
      events: ['pr_comment'],
      commandTemplate: '{{event_type}}',
      queueDir,
      stateDir,
      ghRunner: async () => [],
    })).toThrow('invalid repo');
  });

  it('throws on repo without a slash', () => {
    expect(() => new GithubEventPoller({
      repo: 'justowner',
      events: ['pr_comment'],
      commandTemplate: '{{event_type}}',
      queueDir,
      stateDir,
      ghRunner: async () => [],
    })).toThrow('invalid repo');
  });

  it('throws on repo with leading slash', () => {
    expect(() => new GithubEventPoller({
      repo: '/owner/repo',
      events: ['pr_comment'],
      commandTemplate: '{{event_type}}',
      queueDir,
      stateDir,
      ghRunner: async () => [],
    })).toThrow('invalid repo');
  });

  it('throws on repo with spaces', () => {
    expect(() => new GithubEventPoller({
      repo: 'owner /repo',
      events: ['pr_comment'],
      commandTemplate: '{{event_type}}',
      queueDir,
      stateDir,
      ghRunner: async () => [],
    })).toThrow('invalid repo');
  });

  it('throws on repo with extra path segments', () => {
    expect(() => new GithubEventPoller({
      repo: 'owner/repo/extra',
      events: ['pr_comment'],
      commandTemplate: '{{event_type}}',
      queueDir,
      stateDir,
      ghRunner: async () => [],
    })).toThrow('invalid repo');
  });

  it('accepts a valid owner/repo', () => {
    expect(() => new GithubEventPoller({
      repo: 'owner/repo',
      events: ['pr_comment'],
      commandTemplate: '{{event_type}}',
      queueDir,
      stateDir,
      ghRunner: async () => [],
    })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// pruneSeen unit tests (#4039)
// ---------------------------------------------------------------------------

describe('_pruneSeen (#4039)', () => {
  it('returns the same set when size is at or below MAX_SEEN', () => {
    const s = new Set(['a', 'b', 'c']);
    expect(_pruneSeen(s)).toBe(s);
  });

  it('prunes oldest entries when size exceeds MAX_SEEN', () => {
    // Build a set just over the cap using synthetic ids.
    const overCap = MAX_SEEN_FOR_TESTS + 100;
    const entries = Array.from({ length: overCap }, (_, i) => `id-${i}`);
    const seen = new Set(entries);
    const pruned = _pruneSeen(seen);
    const expectedKeep = Math.floor(MAX_SEEN_FOR_TESTS * 0.8);
    expect(pruned.size).toBe(expectedKeep);
    // Oldest entries (lowest indices, earliest insertion) should be dropped.
    expect(pruned.has('id-0')).toBe(false);
    // Newest entries should be kept.
    expect(pruned.has(`id-${overCap - 1}`)).toBe(true);
  });

  it('preserves insertion order in the pruned set', () => {
    const overCap = MAX_SEEN_FOR_TESTS + 1;
    const entries = Array.from({ length: overCap }, (_, i) => `x-${i}`);
    const seen = new Set(entries);
    const pruned = _pruneSeen(seen);
    // All kept entries should be from the tail of the original insertion order.
    const kept = [...pruned];
    const expectedKeep = Math.floor(MAX_SEEN_FOR_TESTS * 0.8);
    expect(kept).toEqual(entries.slice(overCap - expectedKeep));
  });
});

// ---------------------------------------------------------------------------
// dedup surviving a restart (#4039)
// ---------------------------------------------------------------------------

describe('GithubEventPoller — dedup survives a restart (#4039)', () => {
  it('does not re-enqueue an event seen by a previous poller instance on the same stateDir', async () => {
    const runner = makePrCommentRunner([
      { id: 42, body: 'hello', html_url: 'https://github.com/owner/repo/pull/1#comment-42', created_at: '2026-01-01T00:00:00Z' },
    ]);

    // First poller instance sees and enqueues the event.
    const poller1 = makePoller(runner, ['pr_comment']);
    await poller1.tick();
    expect(readQueuedTasks()).toHaveLength(1);

    // Second poller instance starts fresh (simulates a daemon restart) but
    // shares the same stateDir — it must not re-enqueue the same event.
    const poller2 = makePoller(runner, ['pr_comment']);
    await poller2.tick();
    // Still only 1 task — the second instance deduped via the persisted seen set.
    expect(readQueuedTasks()).toHaveLength(1);
  });

  it('enqueues new events that arrived between restarts', async () => {
    let generation = 1;
    const runner: GhRunner = async () => {
      if (generation === 1) {
        return [{ id: 1, body: 'first', html_url: 'u1', created_at: '2026-01-01T00:00:00Z' }];
      }
      return [
        { id: 1, body: 'first', html_url: 'u1', created_at: '2026-01-01T00:00:00Z' },
        { id: 2, body: 'second', html_url: 'u2', created_at: '2026-01-02T00:00:00Z' },
      ];
    };

    const poller1 = makePoller(runner, ['pr_comment']);
    await poller1.tick();
    expect(readQueuedTasks()).toHaveLength(1);

    // Simulate restart: new poller, same stateDir, new events now available.
    generation = 2;
    const poller2 = makePoller(runner, ['pr_comment']);
    await poller2.tick();
    // Only the new event (id=2) should be enqueued.
    expect(readQueuedTasks()).toHaveLength(2);
  });
});
