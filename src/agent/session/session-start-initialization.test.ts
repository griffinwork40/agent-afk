import { afterAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentSession } from './agent-session.js';
import { createMockProvider } from '../__fixtures__/mock-provider.js';
import { readSessionMeta, readSessionStart } from './session-meta.js';

const repos: string[] = [];
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}
function repo(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'afk-start-init-'));
  repos.push(cwd);
  git(cwd, 'init', '-b', 'main');
  git(cwd, 'config', 'user.email', 'test@afk');
  git(cwd, 'config', 'user.name', 'AFK Test');
  commit(cwd);
  return cwd;
}
function commit(cwd: string): string {
  git(cwd, 'commit', '--allow-empty', '-m', 'advance HEAD');
  return git(cwd, 'rev-parse', 'HEAD');
}
async function turn(session: AgentSession): Promise<void> {
  for await (const event of session.sendMessageStream('hello')) {
    if (event.type === 'done' || event.type === 'error') break;
  }
}

afterAll(() => {
  for (const cwd of repos) rmSync(cwd, { recursive: true, force: true });
});

describe('session initialization git baseline', () => {
  it('retains HEAD from before provider initialization and before the first message', async () => {
    const cwd = repo();
    const headSha = git(cwd, 'rev-parse', 'HEAD');
    const sessionId = `init-head-${crypto.randomUUID()}`;
    const provider = createMockProvider({ sessionId });
    const query = provider.query.bind(provider);
    provider.query = (args) => {
      // Provider setup itself may run before initialization settles.
      expect(commit(cwd)).not.toBe(headSha);
      return query(args);
    };
    const before = Date.now();
    const session = new AgentSession({ model: 'sonnet', cwd, provider });
    try {
      await session.waitForInitialization();
      const initializedAt = Date.now();
      expect(readSessionStart(sessionId)).toBeNull();
      git(cwd, 'switch', '-c', 'after-init');
      expect(commit(cwd)).not.toBe(headSha);
      await turn(session);
      await vi.waitFor(() => {
        expect(readSessionStart(sessionId)).toMatchObject({ branch: 'main', headSha });
      });
      const start = readSessionStart(sessionId)!;
      expect(start.capturedAt).toBeGreaterThanOrEqual(before);
      expect(start.capturedAt).toBeLessThanOrEqual(initializedAt);
      // The mock's session.init advertises a different cwd. The baseline and
      // persisted cwd must both describe the configured initialization repo.
      expect(readSessionMeta(sessionId)?.cwd).toBe(cwd);
      await turn(session);
      expect(readSessionStart(sessionId)).toEqual(start);
    } finally {
      await session.close();
    }
  });

  it('captures a fresh baseline on reset, including before any first turn', async () => {
    const cwd = repo();
    const sessionId = `reset-head-${crypto.randomUUID()}`;
    const session = new AgentSession({
      model: 'sonnet', cwd, provider: createMockProvider({ sessionId }),
    });
    try {
      await session.waitForInitialization();
      const resetHead = commit(cwd);
      await session.reset();
      await session.waitForInitialization();
      expect(commit(cwd)).not.toBe(resetHead);
      await turn(session);
      await vi.waitFor(() => {
        expect(readSessionStart(sessionId)?.headSha).toBe(resetHead);
      });
    } finally {
      await session.close();
    }
  });
});
