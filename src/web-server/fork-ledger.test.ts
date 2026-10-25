import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { getSessionLedgerDir, getSessionLedgerPath } from '../paths.js';

const journal = vi.hoisted(() => ({ messages: [] as unknown[] }));
vi.mock('../agent/journal/index.js', () => ({
  loadDisplayMessages: () => journal.messages,
  hydrateMessages: (m: unknown[]) => m,
}));

import { seedForkLedger } from './fork-ledger.js';

beforeEach(() => { journal.messages = []; });

describe('seedForkLedger', () => {
  it('writes meta plus the projected visible turns for a fork with history', () => {
    const id = randomUUID();
    journal.messages = [
      { role: 'user', content: [{ type: 'text', text: 'hello there' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hi!' }] },
    ];
    expect(seedForkLedger(id, { model: 'sonnet', cwd: '/w' })).toBe(true);
    const lines = readFileSync(getSessionLedgerPath(id), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({ kind: 'meta', sessionId: id, model: 'sonnet', cwd: '/w' });
    expect(JSON.stringify(lines)).toContain('hello there');
    expect(lines.length).toBeGreaterThan(1);
  });

  it('never overwrites an existing ledger', () => {
    const id = randomUUID();
    mkdirSync(getSessionLedgerDir(id), { recursive: true });
    writeFileSync(getSessionLedgerPath(id), 'existing\n');
    journal.messages = [{ role: 'user', content: [{ type: 'text', text: 'x' }] }];
    expect(seedForkLedger(id, { model: 'sonnet' })).toBe(false);
    expect(readFileSync(getSessionLedgerPath(id), 'utf8')).toBe('existing\n');
  });

  it('does nothing for an empty journal', () => {
    const id = randomUUID();
    expect(seedForkLedger(id, { model: 'sonnet' })).toBe(false);
    expect(existsSync(getSessionLedgerPath(id))).toBe(false);
  });
});
