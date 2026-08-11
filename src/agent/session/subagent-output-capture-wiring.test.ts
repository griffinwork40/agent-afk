/**
 * Wiring regression: the output-capture recorder must actually fire from a real
 * session turn, for FORKS ONLY.
 *
 * The recorder is unit-tested separately; this file pins the lines in
 * `sendMessageStreamInternal` that construct and feed it. Without this, the
 * feature could pass every unit test while being hooked up to nothing — or,
 * worse, while capturing a top-level operator session's own output, which it
 * must never do.
 *
 * Mirrors `subagent-prompt-capture-wiring.test.ts` deliberately: the two
 * features share a call site and must not drift apart.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-output-wiring-home-'));
process.env['AFK_HOME'] = tmpHome;

const { AgentSession } = await import('./agent-session.js');
const { createMockProvider } = await import('../__fixtures__/mock-provider.js');
const { getSubagentOutputsDir } = await import('../../paths.js');

const FLAG = 'AFK_CAPTURE_SUBAGENT_OUTPUT';

async function drainTurn(session: InstanceType<typeof AgentSession>, text: string): Promise<void> {
  for await (const event of session.sendMessageStream(text)) {
    if (event.type === 'done' || event.type === 'error') break;
  }
}

function outputFiles(sessionId: string): string[] {
  const dir = getSubagentOutputsDir(sessionId);
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

/**
 * Capture is fire-and-forget by contract (it must never delay or fail a turn),
 * so the file is not guaranteed to exist the instant `drainTurn` resolves. Poll
 * rather than sleep a fixed interval.
 */
async function waitForOutputFiles(sessionId: string, count: number): Promise<string[]> {
  const deadline = Date.now() + 2000;
  for (;;) {
    const files = outputFiles(sessionId);
    if (files.length >= count) return files;
    if (Date.now() > deadline) return files;
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Poll a short window and fail if ANY output file appears. Guards against a
 *  negative assertion that passes only because capture had not run yet. */
async function expectNoOutputFiles(sessionId: string, windowMs = 250): Promise<void> {
  const deadline = Date.now() + windowMs;
  for (;;) {
    if (outputFiles(sessionId).length > 0) {
      throw new Error(`expected no output files for ${sessionId}, found some`);
    }
    if (Date.now() > deadline) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('subagent output capture wiring', () => {
  beforeEach(() => {
    process.env[FLAG] = '1';
  });
  afterEach(() => {
    delete process.env[FLAG];
  });

  it('captures a forked child’s own output on a real turn', async () => {
    const sessionId = `owiring-fork-${Date.now()}`;
    const session = new AgentSession({
      model: 'sonnet',
      provider: createMockProvider({ sessionId }),
      depth: 1,
      parentSessionId: 'parent-abc',
      isSubagentFork: true,
      subagentId: 'forge-qualify-9',
    });
    try {
      await drainTurn(session, 'evaluate the candidate skill');
      const files = await waitForOutputFiles(sessionId, 1);
      expect(files).toEqual(['forge-qualify-9.md']);
      const body = fs.readFileSync(
        path.join(getSubagentOutputsDir(sessionId), 'forge-qualify-9.md'),
        'utf8',
      );
      expect(body).toContain('subagentId: "forge-qualify-9"');
      // The mock provider emits `assistant.message` with no text deltas — this
      // asserts the non-streaming fallback path records the turn.
      expect(body).toContain('### assistant');
    } finally {
      await session.close();
      fs.rmSync(getSubagentOutputsDir(sessionId), { recursive: true, force: true });
    }
  });

  it('appends successive turns to ONE transcript per child', async () => {
    const sessionId = `owiring-append-${Date.now()}`;
    const session = new AgentSession({
      model: 'sonnet',
      provider: createMockProvider({ sessionId }),
      depth: 1,
      isSubagentFork: true,
      subagentId: 'multi-turn-child',
    });
    try {
      await drainTurn(session, 'first');
      await drainTurn(session, 'second');
      const files = await waitForOutputFiles(sessionId, 1);
      expect(files).toHaveLength(1);
      // Capture writes are fire-and-forget (async appendFile chained off the
      // event loop). The file exists after the first turn, but the second
      // turn's append may not have flushed yet — poll for the expected content
      // rather than reading once.
      const filePath = path.join(getSubagentOutputsDir(sessionId), 'multi-turn-child.md');
      const deadline = Date.now() + 2000;
      let body = '';
      while (Date.now() < deadline) {
        body = fs.readFileSync(filePath, 'utf8');
        if ((body.match(/### assistant/g) ?? []).length >= 2) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      // Header written once; two turns recorded into the same file.
      expect(body.match(/subagentId:/g)?.length).toBe(1);
      expect((body.match(/### assistant/g) ?? []).length).toBeGreaterThanOrEqual(2);
    } finally {
      await session.close();
      fs.rmSync(getSubagentOutputsDir(sessionId), { recursive: true, force: true });
    }
  });

  it('captures nothing for a top-level session — operator turns are not dispatches', async () => {
    const sessionId = `owiring-top-${Date.now()}`;
    const session = new AgentSession({
      model: 'sonnet',
      provider: createMockProvider({ sessionId }),
    });
    try {
      await drainTurn(session, 'this is the operator talking, not a dispatch');
      await expectNoOutputFiles(sessionId);
    } finally {
      await session.close();
    }
  });

  it('captures nothing when the flag is off, even for a fork', async () => {
    delete process.env[FLAG];
    const sessionId = `owiring-off-${Date.now()}`;
    const session = new AgentSession({
      model: 'sonnet',
      provider: createMockProvider({ sessionId }),
      depth: 1,
      isSubagentFork: true,
      subagentId: 'silent-child',
    });
    try {
      await drainTurn(session, 'should not be captured');
      await expectNoOutputFiles(sessionId);
    } finally {
      await session.close();
    }
  });
});
