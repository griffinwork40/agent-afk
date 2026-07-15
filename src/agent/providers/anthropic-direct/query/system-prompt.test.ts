/**
 * Unit tests for the shared system-prompt assembler
 * (query/system-prompt.ts). These lock two things:
 *
 *  1. The "assembled twice" seam (#362): the first-turn path (index.ts) and the
 *     on-cwd-change rebuild (cwd-dependents.ts) both route through
 *     `assembleSystemPrompt`, so the env fragment lands at the same position and
 *     the stable parts are built identically on both paths.
 *  2. The top-level ORDER: the `# Agent AFK` doctrine (carried in `userSystem`)
 *     appears after the tool/runtime conventions but BEFORE the cross-session
 *     memory (instructions + `<cross-session-memory>` hot-memory block) and the
 *     skill manifest. This is the ordering guarantee this module owns.
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

/** Distinct, collision-free sentinels for each top-level part. */
const FULL = {
  toolBase: 'TOOL',
  memoryPrompt: 'MEM',
  hotMemory: 'HOT',
  manifest: 'MANIFEST',
  userSystem: 'DOCTRINE',
};

describe('buildStableSystemPrefix', () => {
  it('captures the cwd-independent named parts', () => {
    expect(buildStableSystemPrefix(FULL)).toEqual(FULL);
  });
});

describe('assembleSystemPrompt — top-level order', () => {
  it('orders: toolBase, userSystem (doctrine), memoryPrompt, hotMemory, # Environment, manifest', () => {
    const out = assembleSystemPrompt(buildStableSystemPrefix(FULL), '/tmp/work', IDENTITY);
    const sections = out.split('\n\n');
    expect(sections[0]).toBe('TOOL');
    expect(sections[1]).toBe('DOCTRINE');
    expect(sections[2]).toBe('MEM');
    expect(sections[3]).toBe('HOT');
    // formatEnvironmentFragment always emits the working-directory line.
    expect(sections[4]).toContain('Working directory: /tmp/work');
    expect(sections[5]).toBe('MANIFEST');
  });

  it('places the doctrine after tool conventions but before cross-session memory and the skill manifest', () => {
    const out = assembleSystemPrompt(buildStableSystemPrefix(FULL), '/x', IDENTITY);
    const iTool = out.indexOf('TOOL');
    const iDoctrine = out.indexOf('DOCTRINE');
    const iMemInstructions = out.indexOf('MEM');
    const iHotMemory = out.indexOf('HOT');
    const iManifest = out.indexOf('MANIFEST');
    // after essential runtime/tool conventions
    expect(iTool).toBeGreaterThanOrEqual(0);
    expect(iTool).toBeLessThan(iDoctrine);
    // before cross-session memory (instructions AND hot-memory project context)
    expect(iDoctrine).toBeLessThan(iMemInstructions);
    expect(iDoctrine).toBeLessThan(iHotMemory);
    // before the skills catalog
    expect(iDoctrine).toBeLessThan(iManifest);
  });

  it('keeps # Environment before the manifest even when userSystem/hotMemory are absent', () => {
    const out = assembleSystemPrompt(
      buildStableSystemPrefix({
        toolBase: 'TOOL',
        memoryPrompt: 'MEM',
        hotMemory: '',
        manifest: 'MANIFEST',
        userSystem: null,
      }),
      '/x',
      IDENTITY,
    );
    const sections = out.split('\n\n');
    expect(sections[0]).toBe('TOOL');
    expect(sections[1]).toBe('MEM');
    expect(sections[2]).toContain('Working directory: /x');
    expect(sections[3]).toBe('MANIFEST');
  });

  it('omits empty optional parts (userSystem, hotMemory, manifest)', () => {
    const out = assembleSystemPrompt(
      buildStableSystemPrefix({
        toolBase: 'TOOL',
        memoryPrompt: 'MEM',
        hotMemory: '',
        manifest: '',
        userSystem: null,
      }),
      '/x',
      IDENTITY,
    );
    const sections = out.split('\n\n');
    expect(sections).toHaveLength(3);
    expect(sections[0]).toBe('TOOL');
    expect(sections[1]).toBe('MEM');
    expect(sections[2]).toContain('Working directory: /x');
  });

  it('reflects the cwd in the environment fragment (only the env line changes across cwds)', () => {
    const parts = buildStableSystemPrefix({
      toolBase: 'TOOL',
      memoryPrompt: 'MEM',
      hotMemory: '',
      manifest: '',
      userSystem: null,
    });
    const a = assembleSystemPrompt(parts, '/repo/a', IDENTITY);
    const b = assembleSystemPrompt(parts, '/repo/b', IDENTITY);
    expect(a).toContain('Working directory: /repo/a');
    expect(b).toContain('Working directory: /repo/b');
    // Stable parts are byte-identical; only the env fragment differs.
    expect(a.split('\n\n')[0]).toBe(b.split('\n\n')[0]);
    expect(a.split('\n\n')[1]).toBe(b.split('\n\n')[1]);
    expect(a).not.toBe(b);
  });

  it('appends a Session line when an identity field is known', () => {
    const out = assembleSystemPrompt(
      buildStableSystemPrefix({
        toolBase: 'T',
        memoryPrompt: 'M',
        hotMemory: '',
        manifest: '',
        userSystem: null,
      }),
      '/x',
      { ...IDENTITY, sessionId: 'sess-123' },
    );
    expect(out).toContain('sess-123');
  });
});
