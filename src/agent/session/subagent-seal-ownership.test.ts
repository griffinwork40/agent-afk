/**
 * Regression: only the TOP-LEVEL session may seal the shared witness trace.
 *
 * Symptom (observed 2026-07-21, session afb74e27): a session tree shares ONE
 * TraceWriter by reference. Because every `AgentSession.close()` sealed that
 * writer unconditionally — and `seal()` is one-shot/idempotent — the FIRST
 * descendant torn down (a nested grandchild git-investigator) sealed the whole
 * file with status "succeeded" ~34 min BEFORE the top-level `agent` dispatch
 * actually ended (it was still mid-tool-use, later aborted). The witness trace
 * thus reported a clean success for a session that hung and was cancelled, and
 * every subsequent ancestor event hit the sealed writer and was swallowed.
 *
 * Fix: `dispatchSessionEndOnce` gates `sealTraceWriter(...)` on
 * `this.config.parentSessionId === undefined` (top-level only). Subagents still
 * emit their own `closure` record; the process-exit backstop still seals an
 * orphaned top-level trace if close() never runs.
 *
 * Invariant locked here: a subagent's close() emits `closure` but does NOT
 * append `session_sealed`; a top-level's close() appends both.
 */

import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-seal-own-home-'));
process.env['AFK_HOME'] = tmpHome;

import { AgentSession } from './agent-session.js';
import { createMockProvider } from '../__fixtures__/mock-provider.js';
import { NdjsonTraceWriter } from '../trace/writer.js';

async function drainTurn(session: AgentSession, text: string): Promise<void> {
  for await (const event of session.sendMessageStream(text)) {
    if (event.type === 'done' || event.type === 'error') break;
  }
}

function readTrace(dir: string): Array<{ kind: string; payload: Record<string, unknown> }> {
  const content = fs.readFileSync(path.join(dir, 'trace.jsonl'), 'utf8');
  return content
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { kind: string; payload: Record<string, unknown> });
}

describe('witness seal ownership', () => {
  it('top-level session close() seals the trace (closure + session_sealed)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-seal-own-top-'));
    try {
      const writer = new NdjsonTraceWriter({ traceDir: dir });
      const provider = createMockProvider({ sessionId: `seal-top-${Date.now()}` });
      const session = new AgentSession({ model: 'sonnet', provider, traceWriter: writer });

      await drainTurn(session, 'hello');
      await session.close();

      const kinds = readTrace(dir).map((e) => e.kind);
      expect(kinds).toContain('closure');
      expect(kinds).toContain('session_sealed');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('subagent session close() emits closure but does NOT seal the shared trace', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-seal-own-sub-'));
    try {
      const writer = new NdjsonTraceWriter({ traceDir: dir });
      const provider = createMockProvider({ sessionId: `seal-sub-${Date.now()}` });
      const session = new AgentSession({
        model: 'sonnet',
        provider,
        depth: 1,
        parentSessionId: 'parent-abc',
        traceWriter: writer,
      });

      await drainTurn(session, 'child work');
      await session.close();

      const kinds = readTrace(dir).map((e) => e.kind);
      // The subagent's own end is still recorded...
      expect(kinds).toContain('closure');
      // ...but it must NOT seal the writer it shares with its still-live parent.
      expect(kinds).not.toContain('session_sealed');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
