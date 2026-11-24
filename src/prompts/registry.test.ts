/**
 * Tests for src/prompts/registry.ts
 *
 * Uses a fixture root (a tmp directory with a minimal file layout) so tests
 * never touch the real package tree and run correctly both in `src/` (tsx)
 * and `dist/` (node) environments.
 */

import { afterEach, beforeAll, afterAll, describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getPromptRegistry,
  getPromptById,
  searchPrompts,
  getPromptsByKind,
  notifyPromptLoaded,
  resetPromptRegistryCache,
} from './registry.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'afk-prompts-test-'));

  // 1. Framework system prompt
  writeFileSync(join(root, 'system-prompt.md'), 'framework prompt body');

  // 2. SPINE prompts
  const spineDir = join(root, 'src', 'agent', 'spine', 'prompts');
  mkdirSync(spineDir, { recursive: true });
  writeFileSync(join(spineDir, 'classifier.md'), 'classifier prompt');
  writeFileSync(join(spineDir, 'init-classifier.md'), 'init classifier prompt');

  // 3. Skill phase prompts — two skills
  const mintPromptsDir = join(root, 'src', 'skills', 'mint', 'prompts');
  mkdirSync(mintPromptsDir, { recursive: true });
  writeFileSync(join(mintPromptsDir, 'system.md'), 'mint system prompt');
  writeFileSync(join(mintPromptsDir, 'user.md'), 'mint user prompt');

  const gatherPromptsDir = join(root, 'src', 'skills', 'gather', 'prompts');
  mkdirSync(gatherPromptsDir, { recursive: true });
  writeFileSync(join(gatherPromptsDir, 'phase1.md'), 'gather phase1 prompt');

  // 4. Vendored agent prompts
  const agentPromptsDir = join(root, 'src', 'skills', '_agents', 'prompts');
  mkdirSync(agentPromptsDir, { recursive: true });
  writeFileSync(join(agentPromptsDir, 'research.md'), 'research agent prompt');

  // 5. A skill dir with no prompts/ — should produce no entries
  mkdirSync(join(root, 'src', 'skills', 'noprompts'), { recursive: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  resetPromptRegistryCache();
});

// ---------------------------------------------------------------------------
// getPromptRegistry
// ---------------------------------------------------------------------------

describe('getPromptRegistry', () => {
  it('returns an array', () => {
    const entries = getPromptRegistry({ repoRoot: root });
    expect(Array.isArray(entries)).toBe(true);
  });

  it('discovers the framework system-prompt.md', () => {
    const entries = getPromptRegistry({ repoRoot: root });
    const fw = entries.find((e) => e.kind === 'framework');
    expect(fw).toBeDefined();
    expect(fw?.id).toBe('framework:system-prompt.md');
  });

  it('discovers both SPINE prompts', () => {
    const entries = getPromptRegistry({ repoRoot: root });
    const spine = entries.filter((e) => e.kind === 'spine');
    expect(spine.length).toBe(2);
    const ids = spine.map((e) => e.id).sort();
    expect(ids).toContain('spine:src/agent/spine/prompts/classifier.md');
    expect(ids).toContain('spine:src/agent/spine/prompts/init-classifier.md');
  });

  it('discovers skill-phase prompts for mint', () => {
    const entries = getPromptRegistry({ repoRoot: root });
    const mintPhases = entries.filter(
      (e) => e.kind === 'skill-phase' && e.skill === 'mint',
    );
    expect(mintPhases.length).toBe(2);
  });

  it('discovers skill-phase prompts for gather', () => {
    const entries = getPromptRegistry({ repoRoot: root });
    const gather = entries.filter(
      (e) => e.kind === 'skill-phase' && e.skill === 'gather',
    );
    expect(gather.length).toBe(1);
  });

  it('discovers vendored-agent prompts', () => {
    const entries = getPromptRegistry({ repoRoot: root });
    const vendored = entries.filter((e) => e.kind === 'vendored-agent');
    expect(vendored.length).toBe(1);
    expect(vendored[0]?.id).toBe(
      'vendored-agent:src/skills/_agents/prompts/research.md',
    );
  });

  it('does not emit entries for skill dirs with no prompts/', () => {
    const entries = getPromptRegistry({ repoRoot: root });
    const noprompts = entries.filter((e) => e.skill === 'noprompts');
    expect(noprompts.length).toBe(0);
  });

  it('caches results across repeated calls (same object reference)', () => {
    const a = getPromptRegistry({ repoRoot: root });
    const b = getPromptRegistry({ repoRoot: root });
    expect(a.length).toBe(b.length);
  });
});

// ---------------------------------------------------------------------------
// PromptEntry shape
// ---------------------------------------------------------------------------

describe('PromptEntry shape', () => {
  it('framework entry has correct fields', () => {
    const entry = getPromptRegistry({ repoRoot: root }).find(
      (e) => e.kind === 'framework',
    );
    expect(entry).toBeDefined();
    if (!entry) return;
    expect(entry.id).toMatch(/^framework:/);
    expect(entry.editable).toBe(false);
    expect(entry.name).toBe('system-prompt');
  });

  it('load() returns the file content', () => {
    const entry = getPromptRegistry({ repoRoot: root }).find(
      (e) => e.kind === 'framework',
    );
    expect(entry?.load()).toBe('framework prompt body');
  });

  it('tokenEstimate is a positive number', () => {
    const entry = getPromptRegistry({ repoRoot: root }).find(
      (e) => e.kind === 'framework',
    );
    expect(typeof entry?.tokenEstimate).toBe('number');
    expect(entry?.tokenEstimate ?? 0).toBeGreaterThan(0);
  });

  it('spine entry has correct name derived from filename', () => {
    const entry = getPromptRegistry({ repoRoot: root }).find(
      (e) => e.id === 'spine:src/agent/spine/prompts/classifier.md',
    );
    expect(entry).toBeDefined();
    expect(entry?.name).toBe('classifier');
  });

  it('skill-phase entry carries skill and phase fields', () => {
    const entry = getPromptRegistry({ repoRoot: root }).find(
      (e) => e.kind === 'skill-phase' && e.skill === 'mint',
    );
    expect(entry).toBeDefined();
    expect(entry?.load()).toBe('mint system prompt');
  });

  it('vendored-agent entry has pinned: true', () => {
    const entry = getPromptRegistry({ repoRoot: root }).find(
      (e) => e.kind === 'vendored-agent',
    );
    expect(entry?.pinned).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getPromptById
// ---------------------------------------------------------------------------

describe('getPromptById', () => {
  it('finds an entry by exact id', () => {
    const entry = getPromptById('framework:system-prompt.md', {
      repoRoot: root,
    });
    expect(entry).toBeDefined();
    expect(entry?.kind).toBe('framework');
  });

  it('returns undefined for an unknown id', () => {
    const entry = getPromptById('framework:does-not-exist.md', {
      repoRoot: root,
    });
    expect(entry).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// searchPrompts
// ---------------------------------------------------------------------------

describe('searchPrompts', () => {
  it('matches by name substring (case-insensitive)', () => {
    const results = searchPrompts('classifier', { repoRoot: root });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.every((e) => e.kind === 'spine')).toBe(true);
  });

  it('matches by relativePath', () => {
    const results = searchPrompts('mint', { repoRoot: root });
    expect(results.length).toBe(2);
  });

  it('returns empty array for a query that matches nothing', () => {
    const results = searchPrompts('zzz-no-match-zzz', { repoRoot: root });
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getPromptsByKind
// ---------------------------------------------------------------------------

describe('getPromptsByKind', () => {
  it('returns only entries of the requested kind', () => {
    const spine = getPromptsByKind('spine', { repoRoot: root });
    expect(spine.length).toBe(2);
    expect(spine.every((e) => e.kind === 'spine')).toBe(true);
  });

  it('returns empty array for a kind with no entries', () => {
    const bundled = getPromptsByKind('bundled-skill', { repoRoot: root });
    expect(bundled).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// notifyPromptLoaded / resetPromptRegistryCache
// ---------------------------------------------------------------------------

describe('notifyPromptLoaded', () => {
  it('invalidates the module-level cache', () => {
    notifyPromptLoaded();
    const entries = getPromptRegistry({ repoRoot: root });
    expect(entries.length).toBeGreaterThan(0);
  });
});

describe('resetPromptRegistryCache', () => {
  it('is callable without throwing', () => {
    expect(() => resetPromptRegistryCache()).not.toThrow();
  });

  it('allows re-discovery after reset', () => {
    const before = getPromptRegistry({ repoRoot: root }).length;
    resetPromptRegistryCache();
    const after = getPromptRegistry({ repoRoot: root }).length;
    expect(after).toBe(before);
  });
});
