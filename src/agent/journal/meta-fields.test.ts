/**
 * Focused tests for journal meta-record fields added in #3808:
 *   - `afkVersion` appears on root and subagent journals
 *   - `model` and `provider` on a subagent journal reflect the CHILD's
 *     resolved model, not the parent's
 *
 * @module agent/journal/meta-fields.test
 */

import { describe, expect, it } from 'vitest';

import { getSessionJournalPath, getSubagentJournalPath } from '../../paths.js';
import { user, readLines, useTmpAfkHome } from './__test-utils__/helpers.js';
import { createMessageJournal } from './writer.js';

useTmpAfkHome();

describe('journal meta afkVersion (#3808)', () => {
  it('root journal meta carries afkVersion when provided', async () => {
    const j = createMessageJournal({
      getSessionId: () => 'root-ver',
      meta: { model: 'claude-opus-4', provider: 'anthropic', afkVersion: '1.2.3' },
    });
    j.append(0, user('hello'));
    await j.flush();

    const lines = readLines(getSessionJournalPath('root-ver'));
    const meta = lines.find((l) => l['kind'] === 'meta');
    expect(meta).toBeDefined();
    expect(meta!['afkVersion']).toBe('1.2.3');
    expect(meta!['model']).toBe('claude-opus-4');
    expect(meta!['provider']).toBe('anthropic');
  });

  it('root journal meta omits afkVersion when not provided', async () => {
    const j = createMessageJournal({
      getSessionId: () => 'root-no-ver',
      meta: { model: 'claude-opus-4' },
    });
    j.append(0, user('hello'));
    await j.flush();

    const lines = readLines(getSessionJournalPath('root-no-ver'));
    const meta = lines.find((l) => l['kind'] === 'meta');
    expect(meta).toBeDefined();
    expect('afkVersion' in meta!).toBe(false);
  });

  it('subagent journal meta carries afkVersion inherited from parent shared', async () => {
    const parent = createMessageJournal({
      getSessionId: () => 'parent-ver',
      meta: { model: 'claude-opus-4', provider: 'anthropic', afkVersion: '2.0.0' },
    });
    // No childMeta override: inherits parent shared (including afkVersion)
    const child = parent.forSubagent('child-a');
    child.append(0, user('child msg'));
    await child.flush();

    const lines = readLines(getSubagentJournalPath('parent-ver', 'child-a'));
    const meta = lines.find((l) => l['kind'] === 'meta');
    expect(meta).toBeDefined();
    expect(meta!['afkVersion']).toBe('2.0.0');
  });
});

describe('journal meta child model/provider (#3808)', () => {
  it('subagent journal meta.model reflects the child model override, not the parent', async () => {
    const parent = createMessageJournal({
      getSessionId: () => 'parent-model',
      meta: { model: 'claude-opus-4', provider: 'anthropic', afkVersion: '1.0.0' },
    });
    // Simulate what fork-child-config.ts now passes for a child running a
    // different model (e.g. dispatched with model: 'gpt-4o').
    const child = parent.forSubagent('child-b', {
      model: 'gpt-4o',
      provider: 'openai-compatible',
    });
    child.append(0, user('openai child'));
    await child.flush();

    const lines = readLines(getSubagentJournalPath('parent-model', 'child-b'));
    const meta = lines.find((l) => l['kind'] === 'meta');
    expect(meta).toBeDefined();
    // Child's own model, not the parent's
    expect(meta!['model']).toBe('gpt-4o');
    expect(meta!['provider']).toBe('openai-compatible');
    // afkVersion still inherited from parent shared
    expect(meta!['afkVersion']).toBe('1.0.0');
  });

  it('subagent journal meta.model matches parent when no override is given', async () => {
    const parent = createMessageJournal({
      getSessionId: () => 'parent-inherit',
      meta: { model: 'claude-sonnet-4', provider: 'anthropic', afkVersion: '1.0.0' },
    });
    const child = parent.forSubagent('child-c');
    child.append(0, user('same model child'));
    await child.flush();

    const lines = readLines(getSubagentJournalPath('parent-inherit', 'child-c'));
    const meta = lines.find((l) => l['kind'] === 'meta');
    expect(meta).toBeDefined();
    expect(meta!['model']).toBe('claude-sonnet-4');
    expect(meta!['provider']).toBe('anthropic');
  });

  it('a second forSubagent with same id and no close returns the same instance (cache hit)', async () => {
    const parent = createMessageJournal({
      getSessionId: () => 'parent-cache',
      meta: { model: 'claude-opus-4', provider: 'anthropic' },
    });
    const child1 = parent.forSubagent('child-d', { model: 'gpt-4o', provider: 'openai-compatible' });
    // Second call with same id — should return the SAME instance (cache hit, ignores new meta)
    const child2 = parent.forSubagent('child-d', { model: 'different-model', provider: 'anthropic' });
    expect(child1).toBe(child2);
  });
});

describe('journal meta.cwd (#4426)', () => {
  it('root journal meta carries cwd when provided', async () => {
    const j = createMessageJournal({
      getSessionId: () => 'root-cwd',
      meta: { model: 'claude-opus-4', provider: 'anthropic', cwd: '/projects/my-app' },
    });
    j.append(0, user('hello'));
    await j.flush();

    const lines = readLines(getSessionJournalPath('root-cwd'));
    const meta = lines.find((l) => l['kind'] === 'meta');
    expect(meta).toBeDefined();
    expect(meta!['cwd']).toBe('/projects/my-app');
  });

  it('root journal meta omits cwd when not provided', async () => {
    const j = createMessageJournal({
      getSessionId: () => 'root-no-cwd',
      meta: { model: 'claude-opus-4' },
    });
    j.append(0, user('hello'));
    await j.flush();

    const lines = readLines(getSessionJournalPath('root-no-cwd'));
    const meta = lines.find((l) => l['kind'] === 'meta');
    expect(meta).toBeDefined();
    expect('cwd' in meta!).toBe(false);
  });
});
