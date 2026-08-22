/**
 * Tests for the live system-prompt rebuild factory.
 *
 * The load-bearing property is the SHARED-PREFIX mutation: the factory writes the
 * new base prompt back into the same `StableSystemParts` object the cwd-rebuild
 * factory closes over, so a later `setCwd()` inherits the operator's edit instead
 * of resurrecting the launch-time prompt. A copy-then-assemble implementation
 * would pass a naive "does the output contain the new text" check and still
 * silently undo the hot-reload on the next `/cd`.
 */

import { describe, it, expect } from 'vitest';
import { createSystemPromptRebuildFactory } from './overlay-rebuild.js';
import { assembleSystemPrompt, buildStableSystemPrefix } from './system-prompt.js';
import type { AgentConfig } from '../../../types/config-types.js';
import type { RuntimeStateSource } from '../../../awareness/index.js';

function makeParts(userSystem: string | null): ReturnType<typeof buildStableSystemPrefix> {
  return buildStableSystemPrefix({
    toolBase: 'TOOL-BASE',
    memoryPrompt: 'MEMORY',
    workspacePrompt: '',
    hotMemory: '',
    manifest: '',
    userSystem,
  });
}

const runtimeStateSource = {
  getWorkspace: () => undefined,
} as unknown as RuntimeStateSource;

function makeFactory(
  parts: ReturnType<typeof buildStableSystemPrefix>,
  cwd: string | undefined,
  fallbackCwd = '/fallback',
) {
  return createSystemPromptRebuildFactory({
    stableSystemPrefix: parts,
    config: { sessionId: 's1' } as AgentConfig,
    surface: 'cli',
    runtimeStateSource,
    getCurrentCwd: () => cwd,
    fallbackCwd,
  });
}

describe('createSystemPromptRebuildFactory', () => {
  it('returns a prompt containing the new base prompt', () => {
    const parts = makeParts('OLD-PROMPT');
    const rebuilt = makeFactory(parts, '/repo')('NEW-PROMPT');
    expect(rebuilt).toContain('NEW-PROMPT');
    expect(rebuilt).not.toContain('OLD-PROMPT');
    expect(rebuilt).toContain('TOOL-BASE');
  });

  it('assembles against the LIVE cwd so an edit after /cd lands correctly', () => {
    const parts = makeParts(null);
    expect(makeFactory(parts, '/live/checkout')('P')).toContain('/live/checkout');
  });

  it('falls back to the query-entry cwd when the live accessor is unset', () => {
    const parts = makeParts(null);
    expect(makeFactory(parts, undefined, '/entry/cwd')('P')).toContain('/entry/cwd');
  });

  it('mutates the SHARED prefix so a later cwd rebuild inherits the new prompt', () => {
    const parts = makeParts('OLD-PROMPT');
    makeFactory(parts, '/repo')('NEW-PROMPT');

    // The shared object itself must now carry the new text...
    expect(parts.userSystem).toBe('NEW-PROMPT');

    // ...so re-running the cwd-rebuild assembler over the same parts (exactly
    // what createCwdDependentsFactory does on setCwd) keeps the operator's edit.
    const afterCwdChange = assembleSystemPrompt(parts, '/other/worktree', {
      surface: 'cli',
      sessionId: 's1',
      depth: undefined,
      maxDepth: undefined,
      workspace: undefined,
    });
    expect(afterCwdChange).toContain('NEW-PROMPT');
    expect(afterCwdChange).not.toContain('OLD-PROMPT');
    expect(afterCwdChange).toContain('/other/worktree');
  });

  it('normalizes a cleared overlay to null so no blank section is emitted', () => {
    const parts = makeParts('OLD-PROMPT');
    const rebuilt = makeFactory(parts, '/repo')(undefined);
    expect(parts.userSystem).toBeNull();
    expect(rebuilt).not.toContain('OLD-PROMPT');
    expect(rebuilt).toContain('TOOL-BASE');
    expect(rebuilt).not.toContain('\n\n\n');
  });

  it('treats an empty string the same as cleared', () => {
    const parts = makeParts('OLD-PROMPT');
    makeFactory(parts, '/repo')('');
    expect(parts.userSystem).toBeNull();
  });
});
