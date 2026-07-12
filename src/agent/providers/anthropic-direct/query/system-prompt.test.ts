/**
 * Unit tests for the shared system-prompt assembler
 * (query/system-prompt.ts). These lock the seam that closes the
 * "assembled twice" duplication (#362): the first-turn path (index.ts) and the
 * on-cwd-change rebuild (cwd-dependents.ts) both route through
 * `assembleSystemPrompt`, so the env fragment lands at the same position and
 * the stable prefix is built identically on both paths.
 */

import { describe, it, expect } from 'vitest';
import {
  assembleSystemPrompt,
  buildStableSystemPrefix,
  type EnvironmentIdentity,
} from './system-prompt.js';

const IDENTITY: EnvironmentIdentity = {
  surface: 'cli',
  sessionId: undefined,
  depth: undefined,
  maxDepth: undefined,
  workspace: null,
};

describe('buildStableSystemPrefix', () => {
  it('always includes toolBase + memoryPrompt in order', () => {
    const parts = buildStableSystemPrefix({
      toolBase: 'TOOL',
      memoryPrompt: 'MEM',
      manifest: '',
      userSystem: null,
    });
    expect(parts).toEqual(['TOOL', 'MEM']);
  });

  it('omits empty manifest and null/empty userSystem', () => {
    expect(
      buildStableSystemPrefix({ toolBase: 'T', memoryPrompt: 'M', manifest: '', userSystem: '' }),
    ).toEqual(['T', 'M']);
    expect(
      buildStableSystemPrefix({ toolBase: 'T', memoryPrompt: 'M', manifest: '', userSystem: null }),
    ).toEqual(['T', 'M']);
  });

  it('appends manifest then userSystem when present, in that order', () => {
    const parts = buildStableSystemPrefix({
      toolBase: 'T',
      memoryPrompt: 'M',
      manifest: 'MANIFEST',
      userSystem: 'USER',
    });
    expect(parts).toEqual(['T', 'M', 'MANIFEST', 'USER']);
  });
});

describe('assembleSystemPrompt', () => {
  it('splices the # Environment fragment at index 2 (between memoryPrompt and the rest)', () => {
    const prefix = buildStableSystemPrefix({
      toolBase: 'TOOL',
      memoryPrompt: 'MEM',
      manifest: 'MANIFEST',
      userSystem: 'USER',
    });
    const out = assembleSystemPrompt(prefix, '/tmp/work', IDENTITY);
    const sections = out.split('\n\n');
    expect(sections[0]).toBe('TOOL');
    expect(sections[1]).toBe('MEM');
    // formatEnvironmentFragment always emits the working-directory line.
    expect(sections[2]).toContain('Working directory: /tmp/work');
    expect(sections[3]).toBe('MANIFEST');
    expect(sections[4]).toBe('USER');
  });

  it('reflects the cwd in the environment fragment (only the env line changes across cwds)', () => {
    const prefix = buildStableSystemPrefix({
      toolBase: 'TOOL',
      memoryPrompt: 'MEM',
      manifest: '',
      userSystem: null,
    });
    const a = assembleSystemPrompt(prefix, '/repo/a', IDENTITY);
    const b = assembleSystemPrompt(prefix, '/repo/b', IDENTITY);
    expect(a).toContain('Working directory: /repo/a');
    expect(b).toContain('Working directory: /repo/b');
    // Stable parts are byte-identical; only the env fragment differs.
    expect(a.split('\n\n')[0]).toBe(b.split('\n\n')[0]);
    expect(a.split('\n\n')[1]).toBe(b.split('\n\n')[1]);
    expect(a).not.toBe(b);
  });

  it('handles a minimal prefix (toolBase + memoryPrompt only)', () => {
    const prefix = buildStableSystemPrefix({
      toolBase: 'TOOL',
      memoryPrompt: 'MEM',
      manifest: '',
      userSystem: null,
    });
    const out = assembleSystemPrompt(prefix, '/x', IDENTITY);
    const sections = out.split('\n\n');
    expect(sections).toHaveLength(3);
    expect(sections[0]).toBe('TOOL');
    expect(sections[1]).toBe('MEM');
    expect(sections[2]).toContain('Working directory: /x');
  });

  it('appends a Session line when an identity field is known', () => {
    const prefix = buildStableSystemPrefix({
      toolBase: 'T',
      memoryPrompt: 'M',
      manifest: '',
      userSystem: null,
    });
    const out = assembleSystemPrompt(prefix, '/x', { ...IDENTITY, sessionId: 'sess-123' });
    expect(out).toContain('sess-123');
  });
});
