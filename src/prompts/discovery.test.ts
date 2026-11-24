/**
 * Tests for discoverPrompts() against the REAL repo tree.
 *
 * These tests rely on the actual files on disk — no fixtures, no mocking.
 * They verify counts and structural invariants for each of the 6 prompt kinds.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { discoverPrompts } from './discovery.js';
import { resetPromptRegistryCache, searchPrompts, getPromptsByKind } from './registry.js';

const thisFile = fileURLToPath(import.meta.url);
// src/prompts/ -> src/ -> repo root
const repoRoot = join(dirname(thisFile), '..', '..');

function discover() {
  return discoverPrompts({ repoRoot, afkHome: '/nonexistent-afk-home' });
}

beforeEach(() => {
  resetPromptRegistryCache();
});

describe('discoverPrompts() — all kinds present', () => {
  it('returns at least one entry for every PromptKind', () => {
    const entries = discover();
    const kinds = new Set(entries.map((e) => e.kind));
    expect(kinds.has('framework')).toBe(true);
    expect(kinds.has('spine')).toBe(true);
    expect(kinds.has('skill-phase')).toBe(true);
    expect(kinds.has('vendored-agent')).toBe(true);
    expect(kinds.has('bundled-skill')).toBe(true);
    // user-skill may be absent when afkHome doesn't exist — that is fine
  });
});

describe('framework', () => {
  it('has exactly 1 entry', () => {
    const entries = discover().filter((e) => e.kind === 'framework');
    expect(entries).toHaveLength(1);
  });

  it('entry name is "system-prompt" and kind is "framework"', () => {
    const entry = discover().find((e) => e.kind === 'framework');
    expect(entry?.name).toBe('system-prompt');
    expect(entry?.kind).toBe('framework');
  });

  it('is not editable and not pinned', () => {
    const entry = discover().find((e) => e.kind === 'framework');
    expect(entry?.editable).toBe(false);
    expect(entry?.pinned).toBe(false);
  });
});

describe('spine', () => {
  it('has exactly 2 entries (classifier.md, init-classifier.md)', () => {
    const entries = discover().filter((e) => e.kind === 'spine');
    expect(entries).toHaveLength(2);
  });

  it('entry names are classifier and init-classifier', () => {
    const names = discover()
      .filter((e) => e.kind === 'spine')
      .map((e) => e.name)
      .sort();
    expect(names).toEqual(['classifier', 'init-classifier']);
  });
});

describe('vendored-agent', () => {
  it('has exactly 3 entries', () => {
    const entries = discover().filter((e) => e.kind === 'vendored-agent');
    expect(entries).toHaveLength(3);
  });

  it('entry names are contract, git-investigator, research-agent', () => {
    const names = discover()
      .filter((e) => e.kind === 'vendored-agent')
      .map((e) => e.name)
      .sort();
    expect(names).toEqual(['contract', 'git-investigator', 'research-agent']);
  });

  it('all vendored-agent entries are pinned=true', () => {
    const entries = discover().filter((e) => e.kind === 'vendored-agent');
    expect(entries.every((e) => e.pinned)).toBe(true);
  });

  it('all vendored-agent entries are not editable', () => {
    const entries = discover().filter((e) => e.kind === 'vendored-agent');
    expect(entries.every((e) => !e.editable)).toBe(true);
  });
});

describe('skill-phase (mint)', () => {
  it('has at least 7 entries for the mint skill', () => {
    const mintPhases = discover().filter(
      (e) => e.kind === 'skill-phase' && e.skill === 'mint',
    );
    expect(mintPhases.length).toBeGreaterThanOrEqual(7);
  });

  it('mint has the expected phase names', () => {
    const phases = discover()
      .filter((e) => e.kind === 'skill-phase' && e.skill === 'mint')
      .map((e) => e.phase ?? '')
      .sort();
    expect(phases).toContain('spec');
    expect(phases).toContain('plan');
    expect(phases).toContain('research');
    expect(phases).toContain('build');
    expect(phases).toContain('verify');
    expect(phases).toContain('heal');
    expect(phases).toContain('ship');
  });

  it('skill-phase entries have skill and phase populated', () => {
    const entries = discover().filter((e) => e.kind === 'skill-phase');
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(e.skill).toBeDefined();
      expect(e.phase).toBeDefined();
    }
  });
});

describe('bundled-skill', () => {
  it('has at least 15 entries', () => {
    const entries = discover().filter((e) => e.kind === 'bundled-skill');
    expect(entries.length).toBeGreaterThanOrEqual(15);
  });

  it('every bundled-skill entry has skill populated', () => {
    const entries = discover().filter((e) => e.kind === 'bundled-skill');
    for (const e of entries) {
      expect(e.skill).toBeDefined();
    }
  });
});

describe('id invariants', () => {
  it('every entry id matches the pattern ${kind}:${relativePath}', () => {
    const entries = discover();
    for (const e of entries) {
      expect(e.id).toBe(`${e.kind}:${e.relativePath}`);
    }
  });

  it('all ids are unique', () => {
    const entries = discover();
    const ids = entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('load() and tokenEstimate', () => {
  it('load() returns a non-empty string for every entry', () => {
    const entries = discover();
    for (const e of entries) {
      const content = e.load();
      expect(typeof content).toBe('string');
      expect(content.length).toBeGreaterThan(0);
    }
  });

  it('tokenEstimate > 0 for every entry', () => {
    const entries = discover();
    for (const e of entries) {
      expect(e.tokenEstimate).toBeGreaterThan(0);
    }
  });
});

describe('registry helpers', () => {
  it('searchPrompts("mint") returns entries containing "mint"', () => {
    const results = searchPrompts('mint', { repoRoot, afkHome: '/nonexistent-afk-home' });
    expect(results.length).toBeGreaterThan(0);
    for (const e of results) {
      const haystack = `${e.name} ${e.relativePath} ${e.skill ?? ''} ${e.phase ?? ''}`.toLowerCase();
      expect(haystack).toContain('mint');
    }
  });

  it('getPromptsByKind("vendored-agent") returns exactly 3', () => {
    const results = getPromptsByKind('vendored-agent', {
      repoRoot,
      afkHome: '/nonexistent-afk-home',
    });
    expect(results).toHaveLength(3);
  });
});
