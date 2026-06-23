/**
 * Telegram MCP session wiring contract.
 *
 * Exercises the remote bot session construction path with a project-local MCP
 * fixture config: load Telegram's session-scoped McpManager, pass it into the
 * Telegram provider, construct the Telegram session config, and verify the
 * provider-visible tool catalog includes the bridged fixture tools.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { OpenAICompatibleProvider } from '../agent/providers/index.js';
import type { ProviderEvent } from '../agent/provider.js';
import type { AgentConfig, IAgentSession } from '../agent/types.js';
import type { AgentSession } from '../agent/session.js';
import { McpManager } from '../agent/mcp/index.js';
import type { TraceWriter } from '../agent/trace/index.js';
import { constructTelegramSession } from './construct-session.js';
import { attachMcpCleanup, loadTelegramMcpManager } from './mcp-session.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, '../agent/mcp/__fixtures__/test-server.mjs');
const FIXTURE_TOOL_NAMES = [
  'mcp__testsrv__add',
  'mcp__testsrv__boom',
  'mcp__testsrv__echo',
];

async function* emptyPrompt(): AsyncIterable<never> {
  // Intentionally empty: the provider emits session.init before reading user input.
}

async function writeFixtureMcpConfig(cwd: string): Promise<void> {
  await writeFile(
    join(cwd, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        testsrv: {
          type: 'stdio',
          command: process.execPath,
          args: [FIXTURE],
        },
      },
    }),
    'utf8',
  );
}

describe('Telegram MCP session wiring', () => {
  let tmpHome: string;
  let projectCwd: string;
  let noConfigCwd: string;
  let savedAfkHome: string | undefined;
  let savedAllowProjectMcp: string | undefined;
  let manager: McpManager | undefined;
  let provider: OpenAICompatibleProvider | undefined;

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), 'afk-tg-mcp-home-'));
    projectCwd = await mkdtemp(join(tmpdir(), 'afk-tg-mcp-project-'));
    noConfigCwd = await mkdtemp(join(tmpdir(), 'afk-tg-mcp-empty-'));
    savedAfkHome = process.env['AFK_HOME'];
    savedAllowProjectMcp = process.env['AFK_ALLOW_PROJECT_MCP'];
    process.env['AFK_HOME'] = tmpHome;
    process.env['AFK_ALLOW_PROJECT_MCP'] = '1';
  });

  afterEach(async () => {
    provider?.close();
    provider = undefined;
    await manager?.disconnectAll();
    manager = undefined;
    if (savedAfkHome === undefined) delete process.env['AFK_HOME'];
    else process.env['AFK_HOME'] = savedAfkHome;
    if (savedAllowProjectMcp === undefined) delete process.env['AFK_ALLOW_PROJECT_MCP'];
    else process.env['AFK_ALLOW_PROJECT_MCP'] = savedAllowProjectMcp;
    await rm(tmpHome, { recursive: true, force: true });
    await rm(projectCwd, { recursive: true, force: true });
    await rm(noConfigCwd, { recursive: true, force: true });
  });

  it('returns undefined when the Telegram session has no MCP config', async () => {
    await expect(loadTelegramMcpManager(noConfigCwd)).resolves.toBeUndefined();
  });

  it(
    'forwards the traceWriter option into McpManager.fromConfig',
    async () => {
      await writeFixtureMcpConfig(projectCwd);
      const fakeWriter = { __trace: true } as unknown as TraceWriter;

      const fromConfigSpy = vi.spyOn(McpManager, 'fromConfig');
      try {
        manager = await loadTelegramMcpManager(projectCwd, { traceWriter: fakeWriter });
        expect(manager).toBeDefined();
        expect(fromConfigSpy).toHaveBeenCalledOnce();
        // The second argument to fromConfig must carry our traceWriter.
        const optsArg = fromConfigSpy.mock.calls[0]?.[1];
        expect(optsArg?.traceWriter).toBe(fakeWriter);
      } finally {
        fromConfigSpy.mockRestore();
      }
    },
    { timeout: 15_000 },
  );

  it(
    'exposes project-local fixture MCP tools through the Telegram provider/session path',
    async () => {
      await writeFixtureMcpConfig(projectCwd);
      manager = await loadTelegramMcpManager(projectCwd);
      expect(manager?.getMcpToolWireNames().sort()).toEqual(FIXTURE_TOOL_NAMES);

      provider = new OpenAICompatibleProvider({ surface: 'telegram', mcpManager: manager });
      let captured: AgentConfig | undefined;
      constructTelegramSession(
        {
          model: 'gpt-4o-mini',
          apiKey: 'test-openai-key',
          cwd: projectCwd,
          provider,
        },
        {
          createTraceWriter: () => null,
          newSession: (config): AgentSession => {
            captured = config;
            return { close: async () => {} } as unknown as AgentSession;
          },
        },
      );

      expect(captured?.surface).toBe('telegram');
      expect(captured?.provider).toBe(provider);

      const query = provider.query({ prompt: emptyPrompt(), config: captured! });
      try {
        const first = await query[Symbol.asyncIterator]().next();
        expect(first.done).toBe(false);
        expect(first.value?.type).toBe('session.init');
        const init = first.value as Extract<ProviderEvent, { type: 'session.init' }>;
        expect(init.info.tools).toEqual(expect.arrayContaining(FIXTURE_TOOL_NAMES));
        expect(init.info.mcpServers).toEqual([{ name: 'testsrv', status: 'connected' }]);
      } finally {
        await query.close();
      }
    },
    { timeout: 15_000 },
  );
});

describe('attachMcpCleanup', () => {
  it('wraps session.close() to disconnect the manager exactly once, after close', async () => {
    const order: string[] = [];
    const disconnectAll = vi.fn(async () => {
      order.push('disconnect');
    });
    const close = vi.fn(async () => {
      order.push('close');
    });
    const session = { close } as unknown as IAgentSession;
    const manager = { disconnectAll } as unknown as McpManager;

    const wrapped = attachMcpCleanup(session, manager);
    expect(wrapped).toBe(session);

    await wrapped.close();
    expect(close).toHaveBeenCalledTimes(1);
    expect(disconnectAll).toHaveBeenCalledTimes(1);
    // Teardown order mirrors the other surfaces: session closes BEFORE MCP disconnect.
    expect(order).toEqual(['close', 'disconnect']);

    // Idempotent: a second close() does not double-disconnect the manager.
    await wrapped.close();
    expect(close).toHaveBeenCalledTimes(2);
    expect(disconnectAll).toHaveBeenCalledTimes(1);
  });

  it('still disconnects the manager when the wrapped close() rejects', async () => {
    const disconnectAll = vi.fn(async () => {});
    const close = vi.fn(async () => {
      throw new Error('close failed');
    });
    const session = { close } as unknown as IAgentSession;
    const manager = { disconnectAll } as unknown as McpManager;

    const wrapped = attachMcpCleanup(session, manager);
    await expect(wrapped.close()).rejects.toThrow('close failed');
    // The finally in attachMcpCleanup runs disconnectAll even on a failed close.
    expect(disconnectAll).toHaveBeenCalledTimes(1);
  });

  it('is a no-op passthrough when no manager is supplied', () => {
    const close = vi.fn();
    const session = { close } as unknown as IAgentSession;
    expect(attachMcpCleanup(session, undefined)).toBe(session);
    // close is left unwrapped.
    expect(session.close).toBe(close);
  });
});
