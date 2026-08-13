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
 * Fix: `dispatchSessionEndOnce` gates `sealTraceWriter(...)` on `isSubagentFork`
 * — a field whose sole meaning is "I am a fork", stamped unconditionally by
 * `SubagentManager.forkSubagent`. Subagents still emit their own `closure`
 * record; the process-exit backstop still seals an orphaned top-level trace if
 * close() never runs.
 *
 * The gate previously probed `subagentToolOutputCapBytes` — a tool-output cap
 * that merely happened to be fork-only. That coupling was invisible and
 * load-bearing: a top-level session legitimately setting an output cap would
 * silently stop sealing its own trace. The last case below pins that fix.
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
  it('accepts a write-only TraceSink without treating it as a seal owner', async () => {
    const kinds: string[] = [];
    const sink = {
      async write(event: { kind: string }): Promise<void> {
        kinds.push(event.kind);
      },
      getTracePath(): string {
        return 'in-memory://write-only';
      },
    };
    const session = new AgentSession({
      model: 'sonnet',
      provider: createMockProvider({ sessionId: `write-only-${Date.now()}` }),
      traceWriter: sink,
    });

    await drainTurn(session, 'write only');
    await session.close();

    expect(kinds).toContain('closure');
    expect(kinds).not.toContain('session_sealed');
  });

  it('top-level session close() seals the trace (closure + session_sealed)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-seal-own-top-'));
    try {
      const writer = new NdjsonTraceWriter({ traceDir: dir });
      const provider = createMockProvider({ sessionId: `seal-top-${Date.now()}` });
      const session = new AgentSession({ model: 'sonnet', provider, traceWriter: writer }, writer);

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
        isSubagentFork: true,
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

  it('stub-parent fork close() does NOT seal even without parentSessionId', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-seal-own-stub-sub-'));
    try {
      const writer = new NdjsonTraceWriter({ traceDir: dir });
      const provider = createMockProvider({ sessionId: `seal-stub-sub-${Date.now()}` });
      const session = new AgentSession({
        model: 'sonnet',
        provider,
        depth: 1,
        // Stub-parent skill forks may not have a real parent session id, but
        // forkSubagent still stamps `isSubagentFork`. That marker, not
        // parentSessionId, owns trace-seal gating.
        isSubagentFork: true,
        traceWriter: writer,
      });

      await drainTurn(session, 'stub child work');
      await session.close();

      const kinds = readTrace(dir).map((e) => e.kind);
      expect(kinds).toContain('closure');
      expect(kinds).not.toContain('session_sealed');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('full TraceWriter in config without second arg does NOT seal', async () => {
    // A caller that puts a full TraceWriter into config.traceWriter but omits
    // the second constructor arg must NOT acquire seal ownership — the two-arg
    // ceremony is the only path to ownsTraceSeal=true.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-seal-own-full-no-owner-'));
    try {
      const writer = new NdjsonTraceWriter({ traceDir: dir });
      const session = new AgentSession({
        model: 'sonnet',
        provider: createMockProvider({ sessionId: `full-no-owner-${Date.now()}` }),
        traceWriter: writer,
      });

      await drainTurn(session, 'full writer in config only');
      await session.close();

      const kinds = readTrace(dir).map((e) => e.kind);
      expect(kinds).toContain('closure');
      expect(kinds).not.toContain('session_sealed');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('mismatched writers: config and ownedTraceWriter are different objects → no seal', async () => {
    // The ownsTraceSeal predicate uses referential equality
    // (config.traceWriter === ownedTraceWriter). Two distinct TraceWriter
    // instances must not grant seal ownership — a refactor bug that passes
    // a stale reference would hit this path.
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-seal-own-mismatch-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-seal-own-mismatch-b-'));
    try {
      const writerA = new NdjsonTraceWriter({ traceDir: dirA });
      const writerB = new NdjsonTraceWriter({ traceDir: dirB });
      const session = new AgentSession({
        model: 'sonnet',
        provider: createMockProvider({ sessionId: `mismatch-${Date.now()}` }),
        traceWriter: writerA,
      }, writerB);

      await drainTurn(session, 'mismatched writers');
      await session.close();

      // writerA (config) should get closure but NOT session_sealed
      const kindsA = readTrace(dirA).map((e) => e.kind);
      expect(kindsA).toContain('closure');
      expect(kindsA).not.toContain('session_sealed');

      // writerB (owned) should have nothing — it was rejected by the
      // referential equality check and never used
      expect(fs.existsSync(path.join(dirB, 'trace.jsonl'))).toBe(false);
    } finally {
      fs.rmSync(dirA, { recursive: true, force: true });
      fs.rmSync(dirB, { recursive: true, force: true });
    }
  });

  it('directly constructed legacy fork does NOT seal its parent writer', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-seal-own-legacy-sub-'));
    try {
      const writer = new NdjsonTraceWriter({ traceDir: dir });
      const parent = new AgentSession({
        model: 'sonnet',
        provider: createMockProvider({ sessionId: `seal-legacy-parent-${Date.now()}` }),
        traceWriter: writer,
      }, writer);
      // Legacy fork signal: subagentToolOutputCapBytes was the pre-isSubagentFork
      // indicator. Without the second constructor arg (ownedTraceWriter), the
      // child cannot acquire seal ownership regardless of config contents.
      const child = new AgentSession({
        model: 'sonnet',
        provider: createMockProvider({ sessionId: `seal-legacy-child-${Date.now()}` }),
        subagentToolOutputCapBytes: 100_000,
        traceWriter: writer,
      });

      await drainTurn(child, 'legacy child work');
      await child.close();
      expect(readTrace(dir).map((e) => e.kind)).not.toContain('session_sealed');

      await drainTurn(parent, 'parent work after child close');
      await parent.close();
      expect(readTrace(dir).map((e) => e.kind)).toContain('session_sealed');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('top-level session that sets an output cap STILL seals (marker decoupled)', async () => {
    // Regression for the latent bug the old gate carried: seal ownership used
    // to be inferred from `subagentToolOutputCapBytes`, so a top-level session
    // that legitimately capped tool output silently stopped sealing its own
    // trace — the trace would read `sealed-crashed` forever. Ownership now
    // keys off `isSubagentFork`, which this session does not set.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-seal-own-cap-'));
    try {
      const writer = new NdjsonTraceWriter({ traceDir: dir });
      const provider = createMockProvider({ sessionId: `seal-cap-${Date.now()}` });
      const session = new AgentSession({
        model: 'sonnet',
        provider,
        subagentToolOutputCapBytes: 100_000,
        traceWriter: writer,
      }, writer);

      await drainTurn(session, 'top-level with a cap');
      await session.close();

      const kinds = readTrace(dir).map((e) => e.kind);
      expect(kinds).toContain('closure');
      expect(kinds).toContain('session_sealed');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

});
