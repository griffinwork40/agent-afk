/**
 * Wiring regression: the capture call must actually fire from a real session
 * turn, for FORKS ONLY.
 *
 * The writer module is unit-tested separately; this file pins the single line in
 * `sendMessageStreamInternal` that invokes it. Without this, the feature could
 * pass every unit test while being hooked up to nothing — or, worse, while
 * capturing top-level operator turns, which it must never do (a top-level
 * session's own prompts are the operator's, not a dispatched child's).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-prompt-wiring-home-'));
process.env['AFK_HOME'] = tmpHome;

const { AgentSession } = await import('./agent-session.js');
const { createMockProvider } = await import('../__fixtures__/mock-provider.js');
const { getPromptsDir } = await import('../../paths.js');

async function drainTurn(session: InstanceType<typeof AgentSession>, text: string): Promise<void> {
  for await (const event of session.sendMessageStream(text)) {
    if (event.type === 'done' || event.type === 'error') break;
  }
}

function promptFiles(sessionId: string): string[] {
  const dir = getPromptsDir(sessionId);
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

/**
 * Capture is fire-and-forget by contract (it must never delay or fail a turn),
 * so the file is not guaranteed to exist the instant `drainTurn` resolves. Poll
 * rather than sleep a fixed interval — asserting the artifact eventually lands
 * without pinning a timing assumption into the test.
 */
async function waitForPromptFiles(sessionId: string, count: number): Promise<string[]> {
  const deadline = Date.now() + 2000;
  for (;;) {
    const files = promptFiles(sessionId);
    if (files.length >= count) return files;
    if (Date.now() > deadline) return files;
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('subagent prompt capture wiring', () => {
  beforeEach(() => {
    process.env['AFK_CAPTURE_SUBAGENT_PROMPTS'] = '1';
  });
  afterEach(() => {
    delete process.env['AFK_CAPTURE_SUBAGENT_PROMPTS'];
  });

  it('captures a forked child’s inbound prompt on a real turn', async () => {
    const sessionId = `wiring-fork-${Date.now()}`;
    const provider = createMockProvider({ sessionId });
    const session = new AgentSession({
      model: 'sonnet',
      provider,
      depth: 1,
      parentSessionId: 'parent-abc',
      isSubagentFork: true,
      subagentId: 'research-agent-7',
    });
    try {
      await drainTurn(session, 'map the dispatch layer and report file:line');
      const files = await waitForPromptFiles(sessionId, 1);
      expect(files).toHaveLength(1);
      const body = fs.readFileSync(path.join(getPromptsDir(sessionId), files[0] as string), 'utf8');
      expect(body).toContain('map the dispatch layer and report file:line');
      expect(body).toContain('subagentId: "research-agent-7"');
    } finally {
      await session.close();
      fs.rmSync(getPromptsDir(sessionId), { recursive: true, force: true });
    }
  });

  it('captures nothing for a top-level session — operator turns are not dispatches', async () => {
    const sessionId = `wiring-top-${Date.now()}`;
    const provider = createMockProvider({ sessionId });
    const session = new AgentSession({ model: 'sonnet', provider });
    try {
      await drainTurn(session, 'this is the operator talking, not a dispatch');
      expect(promptFiles(sessionId)).toHaveLength(0);
    } finally {
      await session.close();
    }
  });

  it('captures nothing when the flag is off, even for a fork', async () => {
    delete process.env['AFK_CAPTURE_SUBAGENT_PROMPTS'];
    const sessionId = `wiring-off-${Date.now()}`;
    const provider = createMockProvider({ sessionId });
    const session = new AgentSession({
      model: 'sonnet',
      provider,
      depth: 1,
      isSubagentFork: true,
      subagentId: 'research-agent-9',
    });
    try {
      await drainTurn(session, 'should not be recorded');
      expect(promptFiles(sessionId)).toHaveLength(0);
    } finally {
      await session.close();
    }
  });

  it('records each turn of a multi-turn child separately', async () => {
    const sessionId = `wiring-multi-${Date.now()}`;
    const provider = createMockProvider({ sessionId });
    const session = new AgentSession({
      model: 'sonnet',
      provider,
      depth: 1,
      isSubagentFork: true,
      subagentId: 'general-2',
    });
    try {
      await drainTurn(session, 'first dispatch');
      await drainTurn(session, 'second dispatch');
      const files = await waitForPromptFiles(sessionId, 2);
      expect(files).toHaveLength(2);
      expect(files.some((f) => f.endsWith('-t1.md'))).toBe(true);
      expect(files.some((f) => f.endsWith('-t2.md'))).toBe(true);
    } finally {
      await session.close();
      fs.rmSync(getPromptsDir(sessionId), { recursive: true, force: true });
    }
  });
});
