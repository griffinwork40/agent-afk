import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from './session-manager.js';
import { constructTelegramSession } from './construct-session.js';
import type { AgentConfig, IAgentSession } from '../agent/types.js';

it('interactive Telegram session manager opts in and construction stamps the trusted surface', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'telegram-lsp-'));
  let captured: AgentConfig | undefined;
  const session = { state: 'idle', close: vi.fn(async () => {}) } as unknown as IAgentSession;
  const manager = new SessionManager({ dataDir: dir, defaultModel: 'sonnet', apiKey: 'test',
    createSession: async config => constructTelegramSession(config, {
      traceWriter: null,
      newSession: c => { captured = c; return session as never; },
    }),
  });
  try {
    await manager.getSession(123456);
    expect(captured).toMatchObject({ surface: 'telegram', lspInstallAllowed: true });
  } finally { await manager.closeAll(); await rm(dir, { recursive: true, force: true }); }
});
