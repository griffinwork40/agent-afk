/**
 * Integration: AgentSession × session ledger.
 *
 * Verifies the full chain — a turn through a (mock) provider lands user /
 * assistant / done records in ~/.afk/state/sessions/<id>/events.jsonl, and
 * close() seals the file with a terminal record. Also verifies the gates:
 * subagent configs and the env opt-out produce no ledger.
 */

import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-ledger-int-test-'));
process.env['AFK_HOME'] = tmpDir;

import { AgentSession } from './agent-session.js';
import { createMockProvider } from '../__fixtures__/mock-provider.js';
import { readLedger, type LedgerRecord } from '../session-ledger.js';
import { getSessionLedgerPath } from '../../paths.js';

async function collect(sessionId: string): Promise<LedgerRecord[]> {
  const out: LedgerRecord[] = [];
  for await (const r of readLedger(sessionId)) out.push(r);
  return out;
}

async function drainTurn(session: AgentSession, text: string): Promise<void> {
  for await (const event of session.sendMessageStream(text)) {
    if (event.type === 'done' || event.type === 'error') break;
  }
}

describe('AgentSession ledger integration', () => {
  it('writes meta/user/assistant/done records for a turn and seals on close', async () => {
    const sessionId = `ledger-int-${Date.now()}-a`;
    const provider = createMockProvider({ sessionId });
    const session = new AgentSession({ model: 'sonnet', provider });

    await drainTurn(session, 'hello ledger');
    await session.close();

    const records = await collect(sessionId);
    const kinds = records.map((r) => r.kind);
    expect(kinds[0]).toBe('meta');
    expect(kinds).toContain('user');
    expect(kinds).toContain('assistant');
    expect(kinds).toContain('done');
    expect(kinds.at(-1)).toBe('closed');

    const user = records.find((r) => r.kind === 'user');
    expect(user).toMatchObject({ kind: 'user', text: 'hello ledger' });
    const assistant = records.find((r) => r.kind === 'assistant');
    expect(assistant).toMatchObject({ kind: 'assistant', text: 'Echo: hello ledger' });
    const closed = records.at(-1);
    expect(closed).toMatchObject({ kind: 'closed', reason: 'close' });
  });

  it('does not write a ledger for subagent sessions', async () => {
    const sessionId = `ledger-int-${Date.now()}-sub`;
    const provider = createMockProvider({ sessionId });
    const session = new AgentSession({
      model: 'sonnet',
      provider,
      depth: 1,
      parentSessionId: 'parent-123',
    });

    await drainTurn(session, 'child work');
    await session.close();

    expect(fs.existsSync(getSessionLedgerPath(sessionId))).toBe(false);
  });

  it('honors AFK_SESSION_LEDGER_DISABLED=1', async () => {
    process.env['AFK_SESSION_LEDGER_DISABLED'] = '1';
    try {
      const sessionId = `ledger-int-${Date.now()}-off`;
      const provider = createMockProvider({ sessionId });
      const session = new AgentSession({ model: 'sonnet', provider });
      await drainTurn(session, 'silent');
      await session.close();
      expect(fs.existsSync(getSessionLedgerPath(sessionId))).toBe(false);
    } finally {
      delete process.env['AFK_SESSION_LEDGER_DISABLED'];
    }
  });

  it('seals the ledger on reset and starts a fresh one for the next cycle', async () => {
    const sessionId = `ledger-int-${Date.now()}-reset`;
    const provider = createMockProvider({ sessionId });
    const session = new AgentSession({ model: 'sonnet', provider });

    await drainTurn(session, 'before reset');
    await session.reset();

    let records = await collect(sessionId);
    expect(records.at(-1)).toMatchObject({ kind: 'closed', reason: 'reset' });

    // Mock provider reuses the same session id, so the post-reset cycle
    // appends to the same file after the closed record (a fresh provider
    // would issue a new id and a new file).
    await drainTurn(session, 'after reset');
    await session.close();

    records = await collect(sessionId);
    const closedIdx = records.findIndex((r) => r.kind === 'closed');
    const after = records.slice(closedIdx + 1);
    expect(after.some((r) => r.kind === 'user' && 'text' in r && r.text === 'after reset')).toBe(true);
    expect(after.at(-1)).toMatchObject({ kind: 'closed', reason: 'close' });
  });
});
