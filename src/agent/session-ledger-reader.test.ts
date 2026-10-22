import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSessionLedgerDir, getSessionLedgerPath } from '../paths.js';
import { ledgerGeneration, tailLedger } from './session-ledger-reader.js';
import type { LedgerRecord } from './session-ledger.js';

const id = 'reset-reader';
const line = (text: string) => JSON.stringify({ v: 1, ts: Date.now(), kind: 'assistant', text }) + '\n';
function replace(contents: string) {
  const path = getSessionLedgerPath(id);
  writeFileSync(`${path}.next`, contents);
  renameSync(`${path}.next`, path);
}
beforeEach(() => {
  vi.stubEnv('AFK_STATE_DIR', mkdtempSync(join(tmpdir(), 'ledger-reset-')));
  mkdirSync(getSessionLedgerDir(id), { recursive: true });
});
afterEach(() => vi.unstubAllEnvs());

describe('tailLedger generation resets', () => {
  it('survives a reset seal and follows repeated atomic replacement, even larger than old offset', async () => {
    writeFileSync(getSessionLedgerPath(id), line('old'));
    const abort = new AbortController();
    const seen: LedgerRecord[] = [];
    const generations: string[] = [];
    const reading = (async () => {
      for await (const record of tailLedger(id, { fromStart: true, signal: abort.signal, onGeneration: (g) => generations.push(g) })) seen.push(record);
    })();
    try {
      await vi.waitFor(() => expect(seen).toHaveLength(1));
      appendFileSync(getSessionLedgerPath(id), JSON.stringify({ v: 1, ts: Date.now(), kind: 'closed', reason: 'reset' }) + '\n');
      // Let a real polling cycle consume the seal BEFORE the new inode exists.
      await new Promise((resolve) => setTimeout(resolve, 300));
      replace(line('new'.repeat(1000)));
      await vi.waitFor(() => expect(seen).toHaveLength(2));
      replace(line('last'));
      await vi.waitFor(() => expect(seen).toHaveLength(3));
      expect(generations).toHaveLength(3);
      expect(new Set(generations).size).toBe(3);
      expect(seen.map((r) => r.kind)).toEqual(['assistant', 'assistant', 'assistant']);
    } finally { abort.abort(); await reading; }
  });

  it('rebases a shrunken file and discards partial JSON framing from the old generation', async () => {
    writeFileSync(getSessionLedgerPath(id), line('old') + '{"v":1,"ts":');
    const abort = new AbortController();
    const seen: LedgerRecord[] = [];
    const reading = (async () => {
      for await (const record of tailLedger(id, { fromStart: true, signal: abort.signal })) seen.push(record);
    })();
    try {
      await vi.waitFor(() => expect(seen).toHaveLength(1));
      writeFileSync(getSessionLedgerPath(id), line('x'));
      await vi.waitFor(() => expect(seen).toHaveLength(2));
      expect(seen[1]).toMatchObject({ text: 'x' });
    } finally { abort.abort(); await reading; }
  });
});

describe('ledgerGeneration', () => {
  it('separates replacements that reuse a freed inode (Linux) by birth time', () => {
    const first = ledgerGeneration({ dev: 1, ino: 42, birthtimeMs: 1_000.4 });
    const reused = ledgerGeneration({ dev: 1, ino: 42, birthtimeMs: 1_600.9 });
    expect(first).not.toBe(reused);
    expect(first).toBe('1-42-1000');
  });
  it('is stable for one file and degrades to dev+ino when birth time is unavailable', () => {
    const stat = { dev: 7, ino: 9, birthtimeMs: 0 };
    expect(ledgerGeneration(stat)).toBe(ledgerGeneration({ ...stat }));
    expect(ledgerGeneration(stat)).toBe('7-9-0');
  });
});
