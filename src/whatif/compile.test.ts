/**
 * Tests for compile.ts — the NL → ChangeSpec compiler.
 */

import { describe, it, expect, vi } from 'vitest';
import { compileChangeSpec } from './compile.js';
import type { CompleteFn } from './types.js';

const MODEL = 'claude-haiku-4-5-20250929';
const CTX = { skills: ['diagnose', 'search'], plugins: ['git-helper'] };

function makeFake(text: string): CompleteFn {
  return vi.fn().mockResolvedValue({ text, costUsd: 0.001 });
}

describe('compileChangeSpec', () => {
  it('parses a valid memory-add change', async () => {
    const json = JSON.stringify({
      title: 'Add a preference',
      changes: [{ kind: 'memory-add', content: 'prefer pnpm', category: 'preference' }],
    });
    const fn = makeFake(json);
    const spec = await compileChangeSpec('remember I prefer pnpm', fn, MODEL, CTX);
    expect(spec.title).toBe('Add a preference');
    expect(spec.changes).toHaveLength(1);
    expect(spec.changes[0]).toMatchObject({ kind: 'memory-add', category: 'preference' });
  });

  it('parses from ```json fences', async () => {
    const text =
      '```json\n' +
      JSON.stringify({
        title: 'Disable a skill',
        changes: [{ kind: 'disable-skill', name: 'diagnose' }],
      }) +
      '\n```';
    const spec = await compileChangeSpec('disable diagnose', makeFake(text), MODEL, CTX);
    expect(spec.changes[0]).toMatchObject({ kind: 'disable-skill', name: 'diagnose' });
  });

  it('drops invalid change entries and keeps valid ones', async () => {
    const json = JSON.stringify({
      title: 'Mixed',
      changes: [
        { kind: 'INVALID_KIND', name: 'x' },
        { kind: 'model', model: 'haiku' },
      ],
    });
    const spec = await compileChangeSpec('change model', makeFake(json), MODEL, CTX);
    expect(spec.changes).toHaveLength(1);
    expect(spec.changes[0]).toMatchObject({ kind: 'model', model: 'haiku' });
  });

  it('throws when all changes are invalid', async () => {
    const json = JSON.stringify({
      title: 'All bad',
      changes: [{ kind: 'BOGUS' }, { kind: 'ALSO_BOGUS' }],
    });
    await expect(compileChangeSpec('bad', makeFake(json), MODEL, CTX)).rejects.toThrow(
      'no valid changes',
    );
  });

  it('returns UNRESOLVED spec without throwing', async () => {
    const json = JSON.stringify({
      title: 'UNRESOLVED: content not known',
      changes: [],
    });
    const spec = await compileChangeSpec('replace file with unknown content', makeFake(json), MODEL, CTX);
    expect(spec.title).toMatch(/^UNRESOLVED:/);
    expect(spec.changes).toHaveLength(0);
  });

  it('handles a model change', async () => {
    const json = JSON.stringify({
      title: 'Switch model',
      changes: [{ kind: 'model', model: 'claude-opus-5' }],
    });
    const spec = await compileChangeSpec('use opus', makeFake(json), MODEL, CTX);
    expect(spec.changes[0]).toMatchObject({ kind: 'model', model: 'claude-opus-5' });
  });

  it('handles env change', async () => {
    const json = JSON.stringify({
      title: 'Set env var',
      changes: [{ kind: 'env', key: 'MY_VAR', value: 'hello' }],
    });
    const spec = await compileChangeSpec('set MY_VAR=hello', makeFake(json), MODEL, CTX);
    expect(spec.changes[0]).toMatchObject({ kind: 'env', key: 'MY_VAR', value: 'hello' });
  });

  it('handles append change', async () => {
    const json = JSON.stringify({
      title: 'Append to AFK.md',
      changes: [{ kind: 'append', target: 'project-afk-md', text: 'Always ask first.' }],
    });
    const spec = await compileChangeSpec('append always ask first', makeFake(json), MODEL, CTX);
    expect(spec.changes[0]).toMatchObject({ kind: 'append', target: 'project-afk-md' });
  });

  it('passes context (skills/plugins) to the model', async () => {
    const fn = makeFake(
      JSON.stringify({ title: 't', changes: [{ kind: 'effort', effort: 'low' }] }),
    );
    await compileChangeSpec('use low effort', fn, MODEL, CTX);
    const call = (fn as ReturnType<typeof vi.fn>).mock.calls[0] as [Parameters<CompleteFn>[0]];
    expect(call[0].system).toContain('diagnose');
    expect(call[0].system).toContain('git-helper');
  });
});
