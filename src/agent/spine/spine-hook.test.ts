/**
 * Unit tests for spine-hook.ts — guard conditions and fast-exit paths.
 *
 * The hook is best-effort (wraps everything in try/catch), so these tests
 * verify the guard conditions that cause early return {} BEFORE any I/O
 * or LLM calls.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

// ── Mock the classifier so no real LLM calls happen ─────────────────────────

// MAX_DESCRIPTION_LEN is inlined here as the real production value (300).
// vi.mock factories are hoisted before module initialisation, so we cannot
// reference a module-level const from the factory. The inline literal must
// match spine-classifier.ts:MAX_DESCRIPTION_LEN — if that value changes,
// update this mock and the test body constant below.
vi.mock('./spine-classifier.js', () => ({
  classifyDiff: vi.fn().mockResolvedValue({ items: [], rawOutput: '', parsed: true }),
  MAX_DESCRIPTION_LEN: 300, // must equal spine-classifier.ts:MAX_DESCRIPTION_LEN
}));

// ── Mock Telegram push so no real network calls happen ───────────────────────

vi.mock('../../telegram/push.js', () => ({
  pushIfConfigured: vi.fn().mockResolvedValue(undefined),
}));

// ── Mock git so no real shell commands happen ─────────────────────────────────

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn().mockReturnValue(''),
  };
});

// ── Mock spine-store to avoid real file I/O ──────────────────────────────────

vi.mock('./spine-store.js', () => ({
  readSpine: vi.fn().mockReturnValue(null),
  writeSpine: vi.fn(),
  addEntry: vi.fn().mockReturnValue('INV-001'),
  findEntry: vi.fn().mockReturnValue(undefined),
  sectionForPrefix: vi.fn(),
  serializeSpine: vi.fn().mockReturnValue(''),
}));

// ── Mock node:fs to capture pending-log writes without touching real disk ─────
// The passthrough preserves real behaviour for tests that do not care about
// fs; the appendFileSync capture is used only in the pending-log describe block.

const _capturedAppendCalls: Array<{ path: string; data: string }> = [];

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    appendFileSync: vi.fn(
      (path: import('node:fs').PathOrFileDescriptor, data: string | Uint8Array): void => {
        _capturedAppendCalls.push({ path: String(path), data: String(data) });
      },
    ),
    mkdirSync: vi.fn(),
  };
});

// ── Import after mocks ────────────────────────────────────────────────────────

import { createSpineSessionEndHook } from './spine-hook.js';
import type { HookContext } from '../hooks.js';

// Mirror of the production constant — kept in sync manually so truncation
// tests exercise the actual production length, not a stale fixture value.
// If spine-classifier.ts:MAX_DESCRIPTION_LEN changes, update BOTH the mock
// factory above and this constant.
const MAX_DESCRIPTION_LEN = 300; // must equal spine-classifier.ts:MAX_DESCRIPTION_LEN

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Shared helper: set up execFileSync so both rev-parse and diff return useful values. */
async function setupDiffMock(diffContent = 'diff --git a/foo.ts b/foo.ts\n+const x = 1;') {
  const { execFileSync } = await import('node:child_process');
  vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
    const argsArr = args as string[];
    // Return .git suffix so resolveRepoRootSync (git-common-dir) → dirname → /fake/repo
    if (argsArr.includes('rev-parse')) return '/fake/repo/.git';
    if (argsArr.includes('diff')) return diffContent;
    return '';
  });
}

function makeSessionEndContext(
  overrides: Partial<{
    sessionId: string;
    parentSessionId: string;
  }> = {},
): HookContext {
  return {
    event: 'SessionEnd',
    sessionId: overrides.sessionId ?? 'test-session-id',
    ...(overrides.parentSessionId !== undefined
      ? { parentSessionId: overrides.parentSessionId }
      : {}),
  };
}

// ── Drift guard ───────────────────────────────────────────────────────────────
// Verify that the local MAX_DESCRIPTION_LEN constant (used in the mock factory
// above and in truncation tests below) matches the mocked export value.
// The vi.mock factory above must also set MAX_DESCRIPTION_LEN to the same
// value as spine-classifier.ts:MAX_DESCRIPTION_LEN — update all three sites
// together if the production value changes.
describe('MAX_DESCRIPTION_LEN drift guard', () => {
  it('local MAX_DESCRIPTION_LEN matches the mocked spine-classifier export', async () => {
    // Import the (mocked) module — the mock factory hard-codes the same
    // value as the production export. This test fails fast if either the
    // local const or the mock factory value is updated without the other.
    const mocked = await import('./spine-classifier.js');
    expect(MAX_DESCRIPTION_LEN).toBe(mocked.MAX_DESCRIPTION_LEN);
  });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('createSpineSessionEndHook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env['AFK_DISABLE_SPINE_UPDATE'];
  });

  it('returns {} for non-SessionEnd events', async () => {
    const hook = createSpineSessionEndHook();
    const result = await hook({ event: 'PreToolUse', toolName: 'bash', sessionId: 'x' });
    expect(result).toEqual({});
  });

  it('skips subagent sessions (parentSessionId present)', async () => {
    const hook = createSpineSessionEndHook();
    const { classifyDiff } = await import('./spine-classifier.js');

    const result = await hook(makeSessionEndContext({ parentSessionId: 'parent-123' }));
    expect(result).toEqual({});
    expect(classifyDiff).not.toHaveBeenCalled();
  });

  it('fast-exits when AFK_DISABLE_SPINE_UPDATE=1', async () => {
    process.env['AFK_DISABLE_SPINE_UPDATE'] = '1';
    const hook = createSpineSessionEndHook();
    const { classifyDiff } = await import('./spine-classifier.js');

    const result = await hook(makeSessionEndContext());
    expect(result).toEqual({});
    expect(classifyDiff).not.toHaveBeenCalled();

    delete process.env['AFK_DISABLE_SPINE_UPDATE'];
  });

  it('fast-exits when git diff is empty', async () => {
    const { execFileSync } = await import('node:child_process');
    vi.mocked(execFileSync).mockReturnValue('');

    const hook = createSpineSessionEndHook({ repoRoot: '/fake/repo' });
    const { classifyDiff } = await import('./spine-classifier.js');

    const result = await hook(makeSessionEndContext());
    expect(result).toEqual({});
    expect(classifyDiff).not.toHaveBeenCalled();
  });

  it('calls classifyDiff when diff is non-empty', async () => {
    const { execFileSync } = await import('node:child_process');
    vi.mocked(execFileSync).mockImplementation((cmd, args) => {
      const argsArr = args as string[];
      // Return .git suffix so resolveRepoRootSync (git-common-dir) → dirname → /fake/repo
      if (argsArr.includes('rev-parse')) return '/fake/repo/.git';
      if (argsArr.includes('diff')) return 'diff --git a/foo.ts b/foo.ts\n+const x = 1;';
      return '';
    });

    const { classifyDiff } = await import('./spine-classifier.js');
    vi.mocked(classifyDiff).mockResolvedValue({
      items: [],
      rawOutput: '[]',
      parsed: true,
    });

    const hook = createSpineSessionEndHook({ repoRoot: '/fake/repo' });
    const result = await hook(makeSessionEndContext());
    expect(result).toEqual({});
    expect(classifyDiff).toHaveBeenCalled();
  });

  it('never throws — swallows errors as best-effort', async () => {
    const { classifyDiff } = await import('./spine-classifier.js');
    vi.mocked(classifyDiff).mockRejectedValue(new Error('LLM failure'));

    const { execFileSync } = await import('node:child_process');
    vi.mocked(execFileSync).mockReturnValue('some diff content');

    const hook = createSpineSessionEndHook({ repoRoot: '/fake/repo' });
    // Should not throw
    const result = await hook(makeSessionEndContext());
    expect(result).toEqual({});
  });
});

// ── Label-handling branch tests ───────────────────────────────────────────────

describe('createSpineSessionEndHook — label branches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env['AFK_DISABLE_SPINE_UPDATE'];
    _capturedAppendCalls.length = 0;
  });

  it('new-addition: calls addEntry and writeSpine', async () => {
    await setupDiffMock();

    const { classifyDiff } = await import('./spine-classifier.js');
    vi.mocked(classifyDiff).mockResolvedValue({
      items: [
        {
          label: 'new-addition',
          prefix: 'INV',
          description: 'All env vars go through env.ts',
          rationale: 'Because security',
        },
      ],
      rawOutput: '[]',
      parsed: true,
    });

    const { addEntry, writeSpine, readSpine } = await import('./spine-store.js');
    vi.mocked(readSpine).mockReturnValue({
      sections: [
        { name: 'Invariants', prefix: 'INV', entries: [] },
        { name: 'Explicitly Rejected Patterns', prefix: 'REJ', entries: [] },
        { name: 'Taste Calls Made', prefix: 'TST', entries: [] },
      ],
      trailer: '',
    });

    const hook = createSpineSessionEndHook({ repoRoot: '/fake/repo' });
    await hook(makeSessionEndContext());

    expect(addEntry).toHaveBeenCalledWith(
      expect.any(Object),
      'INV',
      'test-session-id',
      'All env vars go through env.ts',
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    );
    expect(writeSpine).toHaveBeenCalled();
  });

  it('strengthens with valid existingId: mutates description and calls writeSpine', async () => {
    await setupDiffMock();

    const { classifyDiff } = await import('./spine-classifier.js');
    vi.mocked(classifyDiff).mockResolvedValue({
      items: [
        {
          label: 'strengthens',
          existingId: 'INV-001',
          existingDescription: 'All env vars go through env.ts',
          description: 'New code also routes through env.ts',
          rationale: 'See src/config/env.ts',
        },
      ],
      rawOutput: '[]',
      parsed: true,
    });

    const mockEntry = {
      id: 'INV-001',
      date: '2026-09-01',
      sessionId: 'old-session',
      description: 'All env vars go through env.ts',
    };

    const { findEntry, writeSpine, readSpine } = await import('./spine-store.js');
    vi.mocked(readSpine).mockReturnValue({
      sections: [
        { name: 'Invariants', prefix: 'INV', entries: [mockEntry] },
        { name: 'Explicitly Rejected Patterns', prefix: 'REJ', entries: [] },
        { name: 'Taste Calls Made', prefix: 'TST', entries: [] },
      ],
      trailer: '',
    });
    vi.mocked(findEntry).mockReturnValue(mockEntry);

    const hook = createSpineSessionEndHook({ repoRoot: '/fake/repo' });
    await hook(makeSessionEndContext());

    expect(findEntry).toHaveBeenCalledWith(expect.any(Object), 'INV-001');
    expect(mockEntry.description).toMatch(/reinforced/);
    expect(writeSpine).toHaveBeenCalled();
  });

  it('strengthens with invalid existingId: logs to pending (no writeSpine)', async () => {
    await setupDiffMock();

    const { classifyDiff } = await import('./spine-classifier.js');
    vi.mocked(classifyDiff).mockResolvedValue({
      items: [
        {
          label: 'strengthens',
          existingId: 'INV-999',
          existingDescription: 'Non-existent entry',
          description: 'Strengthens nothing',
          rationale: 'Hallucinated ID',
        },
      ],
      rawOutput: '[]',
      parsed: true,
    });

    const { findEntry, writeSpine, readSpine } = await import('./spine-store.js');
    vi.mocked(readSpine).mockReturnValue({
      sections: [
        { name: 'Invariants', prefix: 'INV', entries: [] },
        { name: 'Explicitly Rejected Patterns', prefix: 'REJ', entries: [] },
        { name: 'Taste Calls Made', prefix: 'TST', entries: [] },
      ],
      trailer: '',
    });
    vi.mocked(findEntry).mockReturnValue(undefined);

    const hook = createSpineSessionEndHook({ repoRoot: '/fake/repo' });
    await hook(makeSessionEndContext());

    // writeSpine must NOT be called — only pending log
    expect(writeSpine).not.toHaveBeenCalled();
  });

  it('weakens with valid existingId: mutates description and calls writeSpine', async () => {
    await setupDiffMock();

    const { classifyDiff } = await import('./spine-classifier.js');
    vi.mocked(classifyDiff).mockResolvedValue({
      items: [
        {
          label: 'weakens',
          existingId: 'INV-001',
          existingDescription: 'All env vars go through env.ts',
          description: 'One module bypasses env.ts for legacy reasons',
          rationale: 'See legacy-compat.ts',
        },
      ],
      rawOutput: '[]',
      parsed: true,
    });

    const mockEntry = {
      id: 'INV-001',
      date: '2026-09-01',
      sessionId: 'old-session',
      description: 'All env vars go through env.ts',
    };

    const { findEntry, writeSpine, readSpine } = await import('./spine-store.js');
    vi.mocked(readSpine).mockReturnValue({
      sections: [
        { name: 'Invariants', prefix: 'INV', entries: [mockEntry] },
        { name: 'Explicitly Rejected Patterns', prefix: 'REJ', entries: [] },
        { name: 'Taste Calls Made', prefix: 'TST', entries: [] },
      ],
      trailer: '',
    });
    vi.mocked(findEntry).mockReturnValue(mockEntry);

    const hook = createSpineSessionEndHook({ repoRoot: '/fake/repo' });
    await hook(makeSessionEndContext());

    expect(findEntry).toHaveBeenCalledWith(expect.any(Object), 'INV-001');
    expect(mockEntry.description).toMatch(/partially weakened/);
    expect(writeSpine).toHaveBeenCalled();
  });

  it('weakens with invalid existingId: logs to pending (no writeSpine)', async () => {
    await setupDiffMock();

    const { classifyDiff } = await import('./spine-classifier.js');
    vi.mocked(classifyDiff).mockResolvedValue({
      items: [
        {
          label: 'weakens',
          existingId: 'INV-999',
          existingDescription: 'Non-existent entry',
          description: 'Weakens nothing',
          rationale: 'Hallucinated ID',
        },
      ],
      rawOutput: '[]',
      parsed: true,
    });

    const { findEntry, writeSpine, readSpine } = await import('./spine-store.js');
    vi.mocked(readSpine).mockReturnValue({
      sections: [
        { name: 'Invariants', prefix: 'INV', entries: [] },
        { name: 'Explicitly Rejected Patterns', prefix: 'REJ', entries: [] },
        { name: 'Taste Calls Made', prefix: 'TST', entries: [] },
      ],
      trailer: '',
    });
    vi.mocked(findEntry).mockReturnValue(undefined);

    const hook = createSpineSessionEndHook({ repoRoot: '/fake/repo' });
    await hook(makeSessionEndContext());

    expect(writeSpine).not.toHaveBeenCalled();
  });

  it('contradicts: calls pushIfConfigured (mocked via best-effort)', async () => {
    await setupDiffMock();

    const { classifyDiff } = await import('./spine-classifier.js');
    vi.mocked(classifyDiff).mockResolvedValue({
      items: [
        {
          label: 'contradicts',
          existingId: 'INV-001',
          existingDescription: 'All env vars go through env.ts',
          description: 'This module directly reads process.env',
          rationale: 'See legacy.ts line 42',
        },
      ],
      rawOutput: '[]',
      parsed: true,
    });

    const { writeSpine, readSpine } = await import('./spine-store.js');
    vi.mocked(readSpine).mockReturnValue({
      sections: [
        { name: 'Invariants', prefix: 'INV', entries: [] },
        { name: 'Explicitly Rejected Patterns', prefix: 'REJ', entries: [] },
        { name: 'Taste Calls Made', prefix: 'TST', entries: [] },
      ],
      trailer: '',
    });

    const hook = createSpineSessionEndHook({ repoRoot: '/fake/repo' });
    const result = await hook(makeSessionEndContext());

    // contradicts does NOT write SPINE.md
    expect(writeSpine).not.toHaveBeenCalled();
    // hook still returns {} (best-effort — pushIfConfigured is called
    // but may fail silently in test environment)
    expect(result).toEqual({});
  });
});

// ── Idempotency guard regression tests ───────────────────────────────────────

describe('createSpineSessionEndHook — idempotency guard (strengthens)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env['AFK_DISABLE_SPINE_UPDATE'];
    _capturedAppendCalls.length = 0;
  });

  function makeStrengthensMock(existingDescription: string) {
    return {
      items: [
        {
          label: 'strengthens' as const,
          existingId: 'INV-001',
          existingDescription,
          description: 'Confirms the pattern',
          rationale: 'See src/foo.ts',
        },
      ],
      rawOutput: '[]',
      parsed: true,
    };
  }

  it('same-day idempotency: firing hook twice does not double-append', async () => {
    await setupDiffMock();

    const { classifyDiff } = await import('./spine-classifier.js');
    const today = new Date().toISOString().slice(0, 10);
    const baseDesc = 'All env vars go through env.ts';

    const mockEntry = {
      id: 'INV-001',
      date: '2026-09-01',
      sessionId: 'old-session',
      description: baseDesc,
    };

    const { findEntry, writeSpine, readSpine } = await import('./spine-store.js');
    vi.mocked(readSpine).mockReturnValue({
      sections: [
        { name: 'Invariants', prefix: 'INV', entries: [mockEntry] },
        { name: 'Explicitly Rejected Patterns', prefix: 'REJ', entries: [] },
        { name: 'Taste Calls Made', prefix: 'TST', entries: [] },
      ],
      trailer: '',
    });
    vi.mocked(findEntry).mockReturnValue(mockEntry);
    vi.mocked(classifyDiff).mockResolvedValue(makeStrengthensMock(baseDesc));

    const hook = createSpineSessionEndHook({ repoRoot: '/fake/repo' });

    // First fire
    await hook(makeSessionEndContext());
    const afterFirst = mockEntry.description;

    // Second fire — findEntry still returns the (now-mutated) mockEntry
    await hook(makeSessionEndContext());
    const afterSecond = mockEntry.description;

    // The description after the second fire must equal the description after the first fire
    expect(afterSecond).toBe(afterFirst);
    // And it must contain exactly one "reinforced" annotation
    const reinforcedMatches = afterSecond.match(/\(reinforced /g) ?? [];
    expect(reinforcedMatches).toHaveLength(1);
    expect(afterSecond).toContain(`(reinforced ${today})`);
    expect(writeSpine).toHaveBeenCalled();
  });

  it('date-rollover: replaces yesterday annotation with today annotation', async () => {
    await setupDiffMock();

    const { classifyDiff } = await import('./spine-classifier.js');
    const yesterday = '2026-09-14';
    const today = new Date().toISOString().slice(0, 10);
    const baseWithYesterday = `All env vars go through env.ts (reinforced ${yesterday})`;

    const mockEntry = {
      id: 'INV-001',
      date: '2026-09-01',
      sessionId: 'old-session',
      description: baseWithYesterday,
    };

    const { findEntry, writeSpine, readSpine } = await import('./spine-store.js');
    vi.mocked(readSpine).mockReturnValue({
      sections: [
        { name: 'Invariants', prefix: 'INV', entries: [mockEntry] },
        { name: 'Explicitly Rejected Patterns', prefix: 'REJ', entries: [] },
        { name: 'Taste Calls Made', prefix: 'TST', entries: [] },
      ],
      trailer: '',
    });
    vi.mocked(findEntry).mockReturnValue(mockEntry);
    vi.mocked(classifyDiff).mockResolvedValue(makeStrengthensMock(baseWithYesterday));

    const hook = createSpineSessionEndHook({ repoRoot: '/fake/repo' });
    await hook(makeSessionEndContext());

    // Must contain today's annotation, not yesterday's
    expect(mockEntry.description).toContain(`(reinforced ${today})`);
    expect(mockEntry.description).not.toContain(`(reinforced ${yesterday})`);
    // Exactly one annotation
    const matches = mockEntry.description.match(/\(reinforced /g) ?? [];
    expect(matches).toHaveLength(1);
    expect(writeSpine).toHaveBeenCalled();
  });

  it('truncation resilience: long base description still produces exactly one annotation ≤ MAX_DESCRIPTION_LEN chars', async () => {
    await setupDiffMock();

    const { classifyDiff } = await import('./spine-classifier.js');
    // Build a base that, after appending ` (reinforced 2026-09-14)` (25 chars),
    // exceeds MAX_DESCRIPTION_LEN by 2 — so the closing paren is cut off.
    const suffix = ` (reinforced 2026-09-14)`;
    const longBase = 'A'.repeat(MAX_DESCRIPTION_LEN - suffix.length + 2);
    const yesterday = '2026-09-14';
    // Simulate a previously-truncated description (missing closing paren)
    const truncatedDesc = (longBase + ` (reinforced ${yesterday}`).slice(0, MAX_DESCRIPTION_LEN);
    expect(truncatedDesc).toHaveLength(MAX_DESCRIPTION_LEN);
    expect(truncatedDesc.endsWith(')')).toBe(false); // confirm truncation scenario

    const mockEntry = {
      id: 'INV-001',
      date: '2026-09-01',
      sessionId: 'old-session',
      description: truncatedDesc,
    };

    const { findEntry, writeSpine, readSpine } = await import('./spine-store.js');
    vi.mocked(readSpine).mockReturnValue({
      sections: [
        { name: 'Invariants', prefix: 'INV', entries: [mockEntry] },
        { name: 'Explicitly Rejected Patterns', prefix: 'REJ', entries: [] },
        { name: 'Taste Calls Made', prefix: 'TST', entries: [] },
      ],
      trailer: '',
    });
    vi.mocked(findEntry).mockReturnValue(mockEntry);
    vi.mocked(classifyDiff).mockResolvedValue(makeStrengthensMock(truncatedDesc));

    const hook = createSpineSessionEndHook({ repoRoot: '/fake/repo' });
    await hook(makeSessionEndContext());

    // Result must be ≤ MAX_DESCRIPTION_LEN
    expect(mockEntry.description.length).toBeLessThanOrEqual(MAX_DESCRIPTION_LEN);
    // Must contain today's annotation (even if itself truncated)
    expect(mockEntry.description).toMatch(/\(reinforced /);
    // Must NOT still contain the old date
    expect(mockEntry.description).not.toContain(yesterday);
    expect(writeSpine).toHaveBeenCalled();
  });

  it('truncation resilience: strips "(reinf" fragment (word truncated mid-character)', async () => {
    // Observed real-world case from goblin-portal SPINE.md:
    // description ended exactly at "(reinf" — the annotation word was sliced mid-character.
    await setupDiffMock();

    const { classifyDiff } = await import('./spine-classifier.js');
    const today = new Date().toISOString().slice(0, 10);
    // Construct a description that ends with " (reinf" (word truncated before "orced")
    const base = 'Single `main` branch; check-*.sh scripts.';
    const fragmentDesc = base + ' (reinf';

    const mockEntry = {
      id: 'INV-005',
      date: '2026-09-01',
      sessionId: 'old-session',
      description: fragmentDesc,
    };

    const { findEntry, writeSpine, readSpine } = await import('./spine-store.js');
    vi.mocked(readSpine).mockReturnValue({
      sections: [
        { name: 'Invariants', prefix: 'INV', entries: [mockEntry] },
        { name: 'Explicitly Rejected Patterns', prefix: 'REJ', entries: [] },
        { name: 'Taste Calls Made', prefix: 'TST', entries: [] },
      ],
      trailer: '',
    });
    vi.mocked(findEntry).mockReturnValue(mockEntry);
    vi.mocked(classifyDiff).mockResolvedValue(makeStrengthensMock(fragmentDesc));

    const hook = createSpineSessionEndHook({ repoRoot: '/fake/repo' });
    await hook(makeSessionEndContext());

    // The "(reinf" fragment must be stripped, replaced with a fresh full annotation
    expect(mockEntry.description).not.toContain('(reinf (reinforced');
    expect(mockEntry.description).toContain(`(reinforced ${today})`);
    const matches = mockEntry.description.match(/\(reinforced /g) ?? [];
    expect(matches).toHaveLength(1);
    expect(writeSpine).toHaveBeenCalled();
  });

  it('truncation resilience: strips "(reinforced 2026-09-2" fragment (date truncated mid-digit)', async () => {
    // Date was truncated mid-digit, leaving e.g. "(reinforced 2026-09-2" at end of line.
    await setupDiffMock();

    const { classifyDiff } = await import('./spine-classifier.js');
    const today = new Date().toISOString().slice(0, 10);
    const base = 'All env vars go through env.ts';
    const fragmentDesc = base + ' (reinforced 2026-09-2'; // date cut after first day digit

    const mockEntry = {
      id: 'INV-001',
      date: '2026-09-01',
      sessionId: 'old-session',
      description: fragmentDesc,
    };

    const { findEntry, writeSpine, readSpine } = await import('./spine-store.js');
    vi.mocked(readSpine).mockReturnValue({
      sections: [
        { name: 'Invariants', prefix: 'INV', entries: [mockEntry] },
        { name: 'Explicitly Rejected Patterns', prefix: 'REJ', entries: [] },
        { name: 'Taste Calls Made', prefix: 'TST', entries: [] },
      ],
      trailer: '',
    });
    vi.mocked(findEntry).mockReturnValue(mockEntry);
    vi.mocked(classifyDiff).mockResolvedValue(makeStrengthensMock(fragmentDesc));

    const hook = createSpineSessionEndHook({ repoRoot: '/fake/repo' });
    await hook(makeSessionEndContext());

    // Fragment must be stripped, not stacked
    expect(mockEntry.description).not.toContain('(reinforced 2026-09-2 (reinforced');
    expect(mockEntry.description).toContain(`(reinforced ${today})`);
    const matches = mockEntry.description.match(/\(reinforced /g) ?? [];
    expect(matches).toHaveLength(1);
    expect(writeSpine).toHaveBeenCalled();
  });
});

describe('createSpineSessionEndHook — idempotency guard (weakens)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env['AFK_DISABLE_SPINE_UPDATE'];
    _capturedAppendCalls.length = 0;
  });

  function makeWeakensMock(existingDescription: string) {
    return {
      items: [
        {
          label: 'weakens' as const,
          existingId: 'INV-001',
          existingDescription,
          description: 'One module bypasses env.ts for legacy reasons',
          rationale: 'See legacy-compat.ts',
        },
      ],
      rawOutput: '[]',
      parsed: true,
    };
  }

  it('same-day idempotency: firing hook twice does not double-append', async () => {
    await setupDiffMock();

    const { classifyDiff } = await import('./spine-classifier.js');
    const today = new Date().toISOString().slice(0, 10);
    const baseDesc = 'All env vars go through env.ts';

    const mockEntry = {
      id: 'INV-001',
      date: '2026-09-01',
      sessionId: 'old-session',
      description: baseDesc,
    };

    const { findEntry, writeSpine, readSpine } = await import('./spine-store.js');
    vi.mocked(readSpine).mockReturnValue({
      sections: [
        { name: 'Invariants', prefix: 'INV', entries: [mockEntry] },
        { name: 'Explicitly Rejected Patterns', prefix: 'REJ', entries: [] },
        { name: 'Taste Calls Made', prefix: 'TST', entries: [] },
      ],
      trailer: '',
    });
    vi.mocked(findEntry).mockReturnValue(mockEntry);
    vi.mocked(classifyDiff).mockResolvedValue(makeWeakensMock(baseDesc));

    const hook = createSpineSessionEndHook({ repoRoot: '/fake/repo' });

    // First fire
    await hook(makeSessionEndContext());
    const afterFirst = mockEntry.description;

    // Second fire
    await hook(makeSessionEndContext());
    const afterSecond = mockEntry.description;

    expect(afterSecond).toBe(afterFirst);
    const weakenedMatches = afterSecond.match(/\(partially weakened /g) ?? [];
    expect(weakenedMatches).toHaveLength(1);
    expect(afterSecond).toContain(`(partially weakened ${today})`);
    expect(writeSpine).toHaveBeenCalled();
  });

  it('date-rollover: replaces yesterday annotation with today annotation', async () => {
    await setupDiffMock();

    const { classifyDiff } = await import('./spine-classifier.js');
    const yesterday = '2026-09-14';
    const today = new Date().toISOString().slice(0, 10);
    const baseWithYesterday = `All env vars go through env.ts (partially weakened ${yesterday})`;

    const mockEntry = {
      id: 'INV-001',
      date: '2026-09-01',
      sessionId: 'old-session',
      description: baseWithYesterday,
    };

    const { findEntry, writeSpine, readSpine } = await import('./spine-store.js');
    vi.mocked(readSpine).mockReturnValue({
      sections: [
        { name: 'Invariants', prefix: 'INV', entries: [mockEntry] },
        { name: 'Explicitly Rejected Patterns', prefix: 'REJ', entries: [] },
        { name: 'Taste Calls Made', prefix: 'TST', entries: [] },
      ],
      trailer: '',
    });
    vi.mocked(findEntry).mockReturnValue(mockEntry);
    vi.mocked(classifyDiff).mockResolvedValue(makeWeakensMock(baseWithYesterday));

    const hook = createSpineSessionEndHook({ repoRoot: '/fake/repo' });
    await hook(makeSessionEndContext());

    expect(mockEntry.description).toContain(`(partially weakened ${today})`);
    expect(mockEntry.description).not.toContain(`(partially weakened ${yesterday})`);
    const matches = mockEntry.description.match(/\(partially weakened /g) ?? [];
    expect(matches).toHaveLength(1);
    expect(writeSpine).toHaveBeenCalled();
  });

  it('truncation resilience: long base description still produces exactly one annotation ≤ MAX_DESCRIPTION_LEN chars', async () => {
    await setupDiffMock();

    const { classifyDiff } = await import('./spine-classifier.js');
    // Build a base that, after appending ` (partially weakened 2026-09-14)` (32 chars),
    // exceeds MAX_DESCRIPTION_LEN by 2 — so the closing paren is cut off.
    const suffix = ` (partially weakened 2026-09-14)`;
    const longBase = 'B'.repeat(MAX_DESCRIPTION_LEN - suffix.length + 2);
    const yesterday = '2026-09-14';
    const truncatedDesc = (longBase + ` (partially weakened ${yesterday}`).slice(0, MAX_DESCRIPTION_LEN);
    expect(truncatedDesc).toHaveLength(MAX_DESCRIPTION_LEN);
    expect(truncatedDesc.endsWith(')')).toBe(false); // confirm truncation

    const mockEntry = {
      id: 'INV-001',
      date: '2026-09-01',
      sessionId: 'old-session',
      description: truncatedDesc,
    };

    const { findEntry, writeSpine, readSpine } = await import('./spine-store.js');
    vi.mocked(readSpine).mockReturnValue({
      sections: [
        { name: 'Invariants', prefix: 'INV', entries: [mockEntry] },
        { name: 'Explicitly Rejected Patterns', prefix: 'REJ', entries: [] },
        { name: 'Taste Calls Made', prefix: 'TST', entries: [] },
      ],
      trailer: '',
    });
    vi.mocked(findEntry).mockReturnValue(mockEntry);
    vi.mocked(classifyDiff).mockResolvedValue(makeWeakensMock(truncatedDesc));

    const hook = createSpineSessionEndHook({ repoRoot: '/fake/repo' });
    await hook(makeSessionEndContext());

    expect(mockEntry.description.length).toBeLessThanOrEqual(MAX_DESCRIPTION_LEN);
    expect(mockEntry.description).toMatch(/\(partially weakened /);
    expect(mockEntry.description).not.toContain(yesterday);
    expect(writeSpine).toHaveBeenCalled();
  });

  it('truncation resilience: strips "(partially weakened 2026-09-2" fragment (date truncated mid-digit)', async () => {
    // Observed real-world case from goblin-portal SPINE.md:
    // "(partially weakened 2026-09-2" — date cut after first day digit.
    await setupDiffMock();

    const { classifyDiff } = await import('./spine-classifier.js');
    const today = new Date().toISOString().slice(0, 10);
    const base = 'Prefer native SwiftTerm; GPU renderer (Metal) is optional, not default.';
    const fragmentDesc = base + ' (partially weakened 2026-09-2';

    const mockEntry = {
      id: 'TST-001',
      date: '2026-09-01',
      sessionId: 'old-session',
      description: fragmentDesc,
    };

    const { findEntry, writeSpine, readSpine } = await import('./spine-store.js');
    vi.mocked(readSpine).mockReturnValue({
      sections: [
        { name: 'Invariants', prefix: 'INV', entries: [] },
        { name: 'Explicitly Rejected Patterns', prefix: 'REJ', entries: [] },
        { name: 'Taste Calls Made', prefix: 'TST', entries: [mockEntry] },
      ],
      trailer: '',
    });
    vi.mocked(findEntry).mockReturnValue(mockEntry);
    vi.mocked(classifyDiff).mockResolvedValue(makeWeakensMock(fragmentDesc));

    const hook = createSpineSessionEndHook({ repoRoot: '/fake/repo' });
    await hook(makeSessionEndContext());

    // Fragment must be stripped, not stacked
    expect(mockEntry.description).not.toContain('(partially weakened 2026-09-2 (partially weakened');
    expect(mockEntry.description).toContain(`(partially weakened ${today})`);
    const matches = mockEntry.description.match(/\(partially weakened /g) ?? [];
    expect(matches).toHaveLength(1);
    expect(writeSpine).toHaveBeenCalled();
  });

  it('truncation resilience: strips "(partial" fragment (word truncated mid-character)', async () => {
    // Annotation word truncated before "ly weakened" — only "(pa..." remains.
    await setupDiffMock();

    const { classifyDiff } = await import('./spine-classifier.js');
    const today = new Date().toISOString().slice(0, 10);
    const base = 'All env vars go through env.ts';
    const fragmentDesc = base + ' (partial'; // truncated inside the word "partially"

    const mockEntry = {
      id: 'INV-001',
      date: '2026-09-01',
      sessionId: 'old-session',
      description: fragmentDesc,
    };

    const { findEntry, writeSpine, readSpine } = await import('./spine-store.js');
    vi.mocked(readSpine).mockReturnValue({
      sections: [
        { name: 'Invariants', prefix: 'INV', entries: [mockEntry] },
        { name: 'Explicitly Rejected Patterns', prefix: 'REJ', entries: [] },
        { name: 'Taste Calls Made', prefix: 'TST', entries: [] },
      ],
      trailer: '',
    });
    vi.mocked(findEntry).mockReturnValue(mockEntry);
    vi.mocked(classifyDiff).mockResolvedValue(makeWeakensMock(fragmentDesc));

    const hook = createSpineSessionEndHook({ repoRoot: '/fake/repo' });
    await hook(makeSessionEndContext());

    // Fragment must be stripped, not stacked
    expect(mockEntry.description).not.toContain('(partial (partially weakened');
    expect(mockEntry.description).toContain(`(partially weakened ${today})`);
    const matches = mockEntry.description.match(/\(partially weakened /g) ?? [];
    expect(matches).toHaveLength(1);
    expect(writeSpine).toHaveBeenCalled();
  });
});

// ── Pending-log write assertions (strengthens-unresolved / weakens-unresolved) ─

// These tests verify that hallucinated IDs cause a write to spine-pending.jsonl
// with the correct `type` field. appendFileSync is mocked at module level above;
// _capturedAppendCalls accumulates every call made during a test.

describe('createSpineSessionEndHook — pending-log writes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env['AFK_DISABLE_SPINE_UPDATE'];
    // Clear the capture array for each test.
    _capturedAppendCalls.length = 0;
  });

  it('strengthens-unresolved: logs to pending.jsonl with type="strengthens-unresolved"', async () => {
    await setupDiffMock();

    const { classifyDiff } = await import('./spine-classifier.js');
    vi.mocked(classifyDiff).mockResolvedValue({
      items: [
        {
          label: 'strengthens',
          existingId: 'INV-999',
          existingDescription: 'Does not exist',
          description: 'Confirms non-existent pattern',
          rationale: 'Hallucinated',
        },
      ],
      rawOutput: '[]',
      parsed: true,
    });

    const { findEntry, writeSpine, readSpine } = await import('./spine-store.js');
    vi.mocked(readSpine).mockReturnValue({
      sections: [
        { name: 'Invariants', prefix: 'INV', entries: [] },
        { name: 'Explicitly Rejected Patterns', prefix: 'REJ', entries: [] },
        { name: 'Taste Calls Made', prefix: 'TST', entries: [] },
      ],
      trailer: '',
    });
    vi.mocked(findEntry).mockReturnValue(undefined);

    const hook = createSpineSessionEndHook({ repoRoot: '/fake/repo' });
    await hook({ event: 'SessionEnd', sessionId: 'test-session-id' });

    // writeSpine must NOT be called for a hallucinated ID
    expect(writeSpine).not.toHaveBeenCalled();

    // At least one _capturedAppendCalls entry must include a JSON line with the expected type
    const parsed = _capturedAppendCalls
      .map((c) => c.data)
      .flatMap((l) => l.split('\n'))
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } })
      .filter((x): x is Record<string, unknown> => x !== null);

    const pending = parsed.find((e) => e['type'] === 'strengthens-unresolved');
    expect(pending).toBeDefined();
    expect(pending?.['sessionId']).toBe('test-session-id');
    expect(typeof pending?.['ts']).toBe('string');
  });

  it('weakens-unresolved: logs to pending.jsonl with type="weakens-unresolved"', async () => {
    await setupDiffMock();

    const { classifyDiff } = await import('./spine-classifier.js');
    vi.mocked(classifyDiff).mockResolvedValue({
      items: [
        {
          label: 'weakens',
          existingId: 'INV-888',
          existingDescription: 'Also does not exist',
          description: 'Weakens nothing real',
          rationale: 'Hallucinated ID',
        },
      ],
      rawOutput: '[]',
      parsed: true,
    });

    const { findEntry, writeSpine, readSpine } = await import('./spine-store.js');
    vi.mocked(readSpine).mockReturnValue({
      sections: [
        { name: 'Invariants', prefix: 'INV', entries: [] },
        { name: 'Explicitly Rejected Patterns', prefix: 'REJ', entries: [] },
        { name: 'Taste Calls Made', prefix: 'TST', entries: [] },
      ],
      trailer: '',
    });
    vi.mocked(findEntry).mockReturnValue(undefined);

    const hook = createSpineSessionEndHook({ repoRoot: '/fake/repo' });
    await hook({ event: 'SessionEnd', sessionId: 'test-session-id' });

    // writeSpine must NOT be called for a hallucinated ID
    expect(writeSpine).not.toHaveBeenCalled();

    const parsed = _capturedAppendCalls
      .map((c) => c.data)
      .flatMap((l) => l.split('\n'))
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } })
      .filter((x): x is Record<string, unknown> => x !== null);

    const pending = parsed.find((e) => e['type'] === 'weakens-unresolved');
    expect(pending).toBeDefined();
    expect(pending?.['sessionId']).toBe('test-session-id');
    expect(typeof pending?.['ts']).toBe('string');
  });

  it('weakens with valid ID: logs with type="weakens" (not "weakens-unresolved")', async () => {
    await setupDiffMock();

    const { classifyDiff } = await import('./spine-classifier.js');
    vi.mocked(classifyDiff).mockResolvedValue({
      items: [
        {
          label: 'weakens',
          existingId: 'INV-001',
          existingDescription: 'Real entry',
          description: 'One module bypasses env.ts for legacy reasons',
          rationale: 'legacy-compat.ts',
        },
      ],
      rawOutput: '[]',
      parsed: true,
    });

    const mockEntry = {
      id: 'INV-001',
      date: '2026-09-01',
      sessionId: 'old-session',
      description: 'Real entry',
    };

    const { findEntry, writeSpine, readSpine } = await import('./spine-store.js');
    vi.mocked(readSpine).mockReturnValue({
      sections: [
        { name: 'Invariants', prefix: 'INV', entries: [mockEntry] },
        { name: 'Explicitly Rejected Patterns', prefix: 'REJ', entries: [] },
        { name: 'Taste Calls Made', prefix: 'TST', entries: [] },
      ],
      trailer: '',
    });
    vi.mocked(findEntry).mockReturnValue(mockEntry);

    const hook = createSpineSessionEndHook({ repoRoot: '/fake/repo' });
    await hook({ event: 'SessionEnd', sessionId: 'test-session-id' });

    // writeSpine MUST be called (valid entry was mutated)
    expect(writeSpine).toHaveBeenCalled();

    const parsed = _capturedAppendCalls
      .map((c) => c.data)
      .flatMap((l) => l.split('\n'))
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } })
      .filter((x): x is Record<string, unknown> => x !== null);

    const pending = parsed.find((e) => e['type'] === 'weakens');
    expect(pending).toBeDefined();
    // Must NOT be the unresolved variant
    expect(parsed.find((e) => e['type'] === 'weakens-unresolved')).toBeUndefined();
  });

  it('contradicts: logs to pending.jsonl with type="contradicts"', async () => {
    await setupDiffMock();

    const { classifyDiff } = await import('./spine-classifier.js');
    vi.mocked(classifyDiff).mockResolvedValue({
      items: [
        {
          label: 'contradicts',
          existingId: 'INV-001',
          existingDescription: 'All env vars go through env.ts',
          description: 'This module reads process.env directly',
          rationale: 'legacy.ts:42',
        },
      ],
      rawOutput: '[]',
      parsed: true,
    });

    const { writeSpine, readSpine } = await import('./spine-store.js');
    vi.mocked(readSpine).mockReturnValue({
      sections: [
        { name: 'Invariants', prefix: 'INV', entries: [] },
        { name: 'Explicitly Rejected Patterns', prefix: 'REJ', entries: [] },
        { name: 'Taste Calls Made', prefix: 'TST', entries: [] },
      ],
      trailer: '',
    });

    const hook = createSpineSessionEndHook({ repoRoot: '/fake/repo' });
    await hook({ event: 'SessionEnd', sessionId: 'test-session-id' });

    // SPINE.md must not be mutated for contradictions
    expect(writeSpine).not.toHaveBeenCalled();

    const parsed = _capturedAppendCalls
      .map((c) => c.data)
      .flatMap((l) => l.split('\n'))
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } })
      .filter((x): x is Record<string, unknown> => x !== null);

    const pending = parsed.find((e) => e['type'] === 'contradicts');
    expect(pending).toBeDefined();
    expect(pending?.['sessionId']).toBe('test-session-id');
    expect(typeof pending?.['ts']).toBe('string');
  });
});
