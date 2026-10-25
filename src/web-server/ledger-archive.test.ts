import { describe, it, expect } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { getSessionLedgerDir, getSessionLedgerPath } from '../paths.js';
import { archiveSessionLedger } from './ledger-archive.js';

function seedLedger(content: string): string {
  const id = randomUUID();
  mkdirSync(getSessionLedgerDir(id), { recursive: true });
  writeFileSync(getSessionLedgerPath(id), content);
  return id;
}

describe('archiveSessionLedger', () => {
  it('moves the ledger to an archive sibling with its content intact', () => {
    const id = seedLedger('{"kind":"tool_use","input":{"cmd":"ls"}}\n');
    const archive = archiveSessionLedger(id, new Date('2026-10-21T21:00:00.000Z'));
    expect(archive).toMatch(/events\.reset-2026-10-21T21-00-00-000Z\.jsonl$/);
    expect(readFileSync(archive!, 'utf8')).toContain('"cmd":"ls"');
    expect(existsSync(getSessionLedgerPath(id))).toBe(false);
  });

  it('is a no-op when the session has no ledger yet', () => {
    const id = randomUUID();
    expect(archiveSessionLedger(id)).toBeUndefined();
  });

  it('never overwrites an earlier archive from the same millisecond', () => {
    const id = seedLedger('first\n');
    const at = new Date('2026-10-21T21:00:00.000Z');
    const a = archiveSessionLedger(id, at);
    writeFileSync(getSessionLedgerPath(id), 'second\n');
    const b = archiveSessionLedger(id, at);
    expect(a).not.toBe(b);
    expect(readFileSync(a!, 'utf8')).toBe('first\n');
    expect(readFileSync(b!, 'utf8')).toBe('second\n');
    expect(readdirSync(getSessionLedgerDir(id)).filter((f) => f.startsWith('events.reset-'))).toHaveLength(2);
  });
});
