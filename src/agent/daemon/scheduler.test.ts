/**
 * Unit tests for CronScheduler — focused on telemetry correctness.
 *
 * Uses the `sessionFactory` and `telemetryPath` injection seams so no real
 * AgentSession or filesystem path is ever touched.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const schedulerTestState = vi.hoisted(() => ({ cleanupOrder: [] as string[] }));

vi.mock('../providers/index.js', () => ({
  resolveProvider: () => { throw new Error('resolveProvider is not used by scheduler tests'); },
  providerForModel: () => 'anthropic-direct',
}));

vi.mock('../default-hook-registry.js', () => ({
  createDefaultHookRegistry: () => ({
    registry: undefined,
    memoryStore: { close: () => schedulerTestState.cleanupOrder.push('memory.close') },
  }),
}));

import { CronScheduler, daemonTraceLabel, resolveWorktreePruneRoot } from './scheduler.js';
import { getTraceDir } from '../../paths.js';
import { AgentSession } from '../session/agent-session.js';
import type { AgentConfig } from '../types.js';
import type { ModelProvider, ProviderEvent, ProviderQuery, ProviderQueryArgs, ProviderUserTurn } from '../provider.js';
import type { ExecFileFn } from '../worktree-sweep.js';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'agent-afk-scheduler-'));
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MCP_FIXTURE = resolve(__dirname, '../mcp/__fixtures__/test-server.mjs');

let isolatedAfkHome: string | undefined;
let savedAfkHome: string | undefined;
let savedAllowProjectMcp: string | undefined;

beforeEach(() => {
  isolatedAfkHome = makeTmpDir();
  savedAfkHome = process.env['AFK_HOME'];
  savedAllowProjectMcp = process.env['AFK_ALLOW_PROJECT_MCP'];
  process.env['AFK_HOME'] = isolatedAfkHome;
  process.env['AFK_ALLOW_PROJECT_MCP'] = '0';
});

afterEach(() => {
  if (savedAfkHome === undefined) delete process.env['AFK_HOME'];
  else process.env['AFK_HOME'] = savedAfkHome;
  if (savedAllowProjectMcp === undefined) delete process.env['AFK_ALLOW_PROJECT_MCP'];
  else process.env['AFK_ALLOW_PROJECT_MCP'] = savedAllowProjectMcp;
  if (isolatedAfkHome !== undefined) rmSync(isolatedAfkHome, { recursive: true, force: true });
  isolatedAfkHome = undefined;
});

/**
 * Build a minimal fake AgentSession whose sendMessage() either resolves or
 * rejects with the given Error.
 */
function makeSession(opts: { throws?: Error; response?: string }): AgentSession {
  return {
    sendMessage: opts.throws
      ? () => Promise.reject(opts.throws)
      : () => Promise.resolve({ content: opts.response ?? '' }),
    close: () => Promise.resolve(),
  } as unknown as AgentSession;
}

function makeToolSurfacingProvider(): ModelProvider {
  return {
    name: 'scheduler-mcp-fixture-provider',
    query(args: ProviderQueryArgs): ProviderQuery {
      const promptIter = args.prompt[Symbol.asyncIterator]();
      const mcpTools = args.config.mcpManager?.getMcpToolWireNames().sort() ?? [];
      const mcpServers = args.config.mcpManager?.getServerStates().map((s) => ({
        name: s.serverName,
        status: s.status,
      })) ?? [];
      const originalDisconnect = args.config.mcpManager?.disconnectAll.bind(args.config.mcpManager);
      if (args.config.mcpManager && originalDisconnect) {
        vi.spyOn(args.config.mcpManager, 'disconnectAll').mockImplementation(async () => {
          schedulerTestState.cleanupOrder.push('mcp.disconnect');
          await originalDisconnect();
        });
      }

      let closed = false;
      let closeResolve: (() => void) | undefined;
      const closedPromise = new Promise<'__closed__'>((resolveClose) => {
        closeResolve = () => resolveClose('__closed__');
      });

      return {
        async *[Symbol.asyncIterator](): AsyncIterator<ProviderEvent> {
          yield {
            type: 'session.init',
            info: {
              sessionId: 'scheduler-mcp-fixture-session',
              model: 'sonnet',
              permissionMode: 'bypassPermissions',
              cwd: args.config.cwd,
              tools: mcpTools,
              slashCommands: [],
              skills: [],
              plugins: [],
              mcpServers,
              apiKeySource: 'api-key',
              version: 'scheduler-mcp-fixture-provider',
            },
          };

          while (!closed) {
            const nextOrClose = await Promise.race([promptIter.next(), closedPromise]);
            if (nextOrClose === '__closed__') break;
            const turn = nextOrClose as IteratorResult<ProviderUserTurn>;
            if (turn.done) break;
            const content = typeof turn.value.content === 'string' ? turn.value.content : '[blocks]';
            yield { type: 'assistant.message', text: `Echo: ${content}`, sessionId: 'scheduler-mcp-fixture-session' };
            yield {
              type: 'turn.completed',
              sessionId: 'scheduler-mcp-fixture-session',
              usage: {
                resultSubtype: 'success',
                stopReason: 'end_turn',
                durationMs: 1,
                totalCostUsd: 0,
              },
            };
          }
        },
        async interrupt() {},
        async setModel() {},
        async setPermissionMode() {},
        async supportedCommands() { return []; },
        async supportedModels() { return []; },
        async supportedAgents() { return []; },
        async getContextUsage() { return { tools: mcpTools, isAutoCompactEnabled: false, apiUsage: null }; },
        async mcpServerStatus() { return mcpServers; },
        async accountInfo() { return { subscriptionType: 'api-key' }; },
        async rewindFiles() { return { canRewind: false }; },
        close() {
          schedulerTestState.cleanupOrder.push('session.close');
          closed = true;
          closeResolve?.();
        },
      };
    },
  };
}

describe('CronScheduler telemetry — errorMessage redaction', () => {
  let dir: string;
  let telemetryPath: string;

  beforeEach(() => {
    dir = makeTmpDir();
    telemetryPath = join(dir, 'forge-telemetry.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('redacts an Anthropic API key in errorMessage (sk-ant-…)', async () => {
    const rawSecret = 'sk-ant-api03-abc123XYZABC123xyz-0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000XXXX';
    const err = new Error(`HTTP 401 Unauthorized: Authorization: Bearer ${rawSecret}`);

    const scheduler = new CronScheduler({
      telemetryPath,
      sessionFactory: () => makeSession({ throws: err }),
    });

    scheduler.register({
      taskId: 'secret-test',
      command: 'run-report',
      trigger: 'cron',
      cronExpression: '* * * * *',
    });

    const record = await scheduler.tick('secret-test');

    // The returned record must already be redacted
    expect(record.status).toBe('error');
    expect(record.errorMessage).not.toContain(rawSecret);
    expect(record.errorMessage).toMatch(/REDACTED/);

    // The persisted JSONL line must also be redacted
    const line = readFileSync(telemetryPath, 'utf-8').trim();
    const persisted = JSON.parse(line) as { errorMessage?: string };
    expect(persisted.errorMessage).not.toContain(rawSecret);
    expect(persisted.errorMessage).toMatch(/REDACTED/);

    await scheduler.stop();
  });

  it('redacts a Bearer token in errorMessage', async () => {
    const bearerToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.somePayload.signature';
    const err = new Error(`API error: Bearer ${bearerToken} was rejected`);

    const scheduler = new CronScheduler({
      telemetryPath,
      sessionFactory: () => makeSession({ throws: err }),
    });

    scheduler.register({
      taskId: 'bearer-test',
      command: 'sync',
      trigger: 'cron',
      cronExpression: '* * * * *',
    });

    const record = await scheduler.tick('bearer-test');

    expect(record.status).toBe('error');
    expect(record.errorMessage).not.toContain(bearerToken);
    expect(record.errorMessage).toMatch(/REDACTED/);

    const line = readFileSync(telemetryPath, 'utf-8').trim();
    const persisted = JSON.parse(line) as { errorMessage?: string };
    expect(persisted.errorMessage).not.toContain(bearerToken);
    expect(persisted.errorMessage).toMatch(/REDACTED/);

    await scheduler.stop();
  });

  it('passes through error messages that contain no secrets', async () => {
    const safeMessage = 'connection timeout after 30s';
    const err = new Error(safeMessage);

    const scheduler = new CronScheduler({
      telemetryPath,
      sessionFactory: () => makeSession({ throws: err }),
    });

    scheduler.register({
      taskId: 'safe-error-test',
      command: 'health-check',
      trigger: 'cron',
      cronExpression: '* * * * *',
    });

    const record = await scheduler.tick('safe-error-test');

    expect(record.status).toBe('error');
    expect(record.errorMessage).toBe(safeMessage);

    await scheduler.stop();
  });

  it('success path: responseExcerpt is still redacted', async () => {
    const rawSecret = 'sk-ant-api03-secretkeyABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcdefghijklmnopqrstu';
    const scheduler = new CronScheduler({
      telemetryPath,
      sessionFactory: () => makeSession({ response: `Here is the token: ${rawSecret}` }),
    });

    scheduler.register({
      taskId: 'success-redact-test',
      command: 'query',
      trigger: 'cron',
      cronExpression: '* * * * *',
    });

    const record = await scheduler.tick('success-redact-test');

    expect(record.status).toBe('success');
    expect(record.responseExcerpt).not.toContain(rawSecret);
    expect(record.responseExcerpt).toMatch(/REDACTED/);

    await scheduler.stop();
  });

  it('passes full redacted response to completion callback without persisting it', async () => {
    const rawSecret = 'sk-ant-api03-secretkeyABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcdefghijklmnopqrstu';
    const tail = 'TAIL_AFTER_EXCERPT';
    const response = `${'x'.repeat(350)}${rawSecret}\n${tail}`;
    const onTaskComplete = vi.fn();
    const scheduler = new CronScheduler({
      telemetryPath,
      sessionFactory: () => makeSession({ response }),
      onTaskComplete,
    });

    scheduler.register({
      taskId: 'full-response-test',
      command: 'query',
      trigger: 'cron',
      cronExpression: '* * * * *',
    });

    const record = await scheduler.tick('full-response-test');

    expect(record.status).toBe('success');
    expect(record.responseExcerpt).not.toContain(tail);
    expect(onTaskComplete).toHaveBeenCalledOnce();
    const [callbackRecord, details] = onTaskComplete.mock.calls[0]!;
    expect(callbackRecord).toBe(record);
    expect(details?.responseText).toContain(tail);
    expect(details?.responseText).toContain('REDACTED');
    expect(details?.responseText).not.toContain(rawSecret);

    const line = readFileSync(telemetryPath, 'utf-8').trim();
    expect(line).not.toContain(tail);
    expect(line).not.toContain(rawSecret);

    await scheduler.stop();
  });
});

describe('CronScheduler — witness trace-writer wiring', () => {
  let dir: string;
  let telemetryPath: string;
  let savedHome: string | undefined;
  let savedDisabled: string | undefined;

  beforeEach(() => {
    dir = makeTmpDir();
    telemetryPath = join(dir, 'forge-telemetry.jsonl');
    savedHome = process.env['AFK_HOME'];
    savedDisabled = process.env['AFK_TRACE_DISABLED'];
    // Isolate any witness directory under the temp dir; the fake session never
    // writes through the lazy writer, so no trace file is actually created.
    process.env['AFK_HOME'] = dir;
    delete process.env['AFK_TRACE_DISABLED'];
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env['AFK_HOME'];
    else process.env['AFK_HOME'] = savedHome;
    if (savedDisabled === undefined) delete process.env['AFK_TRACE_DISABLED'];
    else process.env['AFK_TRACE_DISABLED'] = savedDisabled;
    rmSync(dir, { recursive: true, force: true });
  });

  it('threads a default trace writer into the spawned session config', async () => {
    let captured: AgentConfig | undefined;
    const scheduler = new CronScheduler({
      telemetryPath,
      sessionFactory: (config) => {
        captured = config;
        return makeSession({ response: 'ok' });
      },
    });
    scheduler.register({
      taskId: 'trace-on',
      command: 'hello',
      trigger: 'cron',
      cronExpression: '* * * * *',
    });

    await scheduler.tick('trace-on');

    expect(captured?.traceWriter).toBeDefined();

    await scheduler.stop();
  });

  it('omits the trace writer when AFK_TRACE_DISABLED=1', async () => {
    process.env['AFK_TRACE_DISABLED'] = '1';
    let captured: AgentConfig | undefined;
    const scheduler = new CronScheduler({
      telemetryPath,
      sessionFactory: (config) => {
        captured = config;
        return makeSession({ response: 'ok' });
      },
    });
    scheduler.register({
      taskId: 'trace-off',
      command: 'hello',
      trigger: 'cron',
      cronExpression: '* * * * *',
    });

    await scheduler.tick('trace-off');

    expect(captured?.traceWriter).toBeUndefined();

    await scheduler.stop();
  });

  it('fallback (no sessionFactory) path stamps surface:daemon on the AgentConfig — Fix 3', async () => {
    // The `sessionFactory` injection seam: capture the config the scheduler
    // would pass to a real AgentSession without constructing one (avoids
    // provider / SDK wiring).
    let captured: AgentConfig | undefined;
    const scheduler = new CronScheduler({
      telemetryPath,
      sessionFactory: (config) => {
        captured = config;
        return makeSession({ response: 'ok' });
      },
    });
    scheduler.register({
      taskId: 'surface-fallback-test',
      command: 'hello',
      trigger: 'cron',
      cronExpression: '* * * * *',
    });

    await scheduler.tick('surface-fallback-test');

    // Fix 3: the fallback config must carry surface:'daemon' so routing-decision
    // telemetry rows derive origin:'daemon' instead of 'unknown'.
    expect(captured?.surface).toBe('daemon');

    await scheduler.stop();
  });
});

describe('CronScheduler — MCP fixture wiring', () => {
  it(
    'spawns a headless AgentSession with fixture mcp__ tools and cleans up session before MCP before memory',
    async () => {
      const dir = makeTmpDir();
      const telemetryPath = join(dir, 'forge-telemetry.jsonl');
      const savedHome = process.env['AFK_HOME'];
      const savedTraceDisabled = process.env['AFK_TRACE_DISABLED'];
      const savedAllowProjectMcp = process.env['AFK_ALLOW_PROJECT_MCP'];
      process.env['AFK_HOME'] = dir;
      process.env['AFK_TRACE_DISABLED'] = '1';
      process.env['AFK_ALLOW_PROJECT_MCP'] = '1';
      writeFileSync(
        join(dir, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            testsrv: {
              type: 'stdio',
              command: process.execPath,
              args: [MCP_FIXTURE],
            },
          },
        }),
        'utf-8',
      );

      schedulerTestState.cleanupOrder.length = 0;

      let scheduler: CronScheduler | undefined;
      let capturedConfig: AgentConfig | undefined;
      let spawnedSession: AgentSession | undefined;
      try {
        scheduler = new CronScheduler({
          telemetryPath,
          sessionConfig: { cwd: dir, provider: makeToolSurfacingProvider() },
          sessionFactory: (config) => {
            capturedConfig = config;
            spawnedSession = new AgentSession(config);
            return spawnedSession;
          },
        });
        scheduler.register({
          taskId: 'scheduler-mcp-fixture',
          command: 'hello fixture mcp',
          trigger: 'cron',
          cronExpression: '* * * * *',
        });

        const record = await scheduler.tick('scheduler-mcp-fixture');

        expect(record.status).toBe('success');
        expect(capturedConfig?.isNonInteractive).toBe(true);
        expect(capturedConfig?.permissionMode).toBe('bypassPermissions');
        expect(spawnedSession?.getSessionMetadata().tools?.sort()).toEqual([
          'mcp__testsrv__add',
          'mcp__testsrv__boom',
          'mcp__testsrv__echo',
        ]);
        expect(spawnedSession?.getSessionMetadata().mcpServers).toEqual([
          { name: 'testsrv', status: 'connected' },
        ]);
        expect(schedulerTestState.cleanupOrder).toEqual(['session.close', 'mcp.disconnect', 'memory.close']);
      } finally {
        await scheduler?.stop();
        if (savedHome === undefined) delete process.env['AFK_HOME'];
        else process.env['AFK_HOME'] = savedHome;
        if (savedTraceDisabled === undefined) delete process.env['AFK_TRACE_DISABLED'];
        else process.env['AFK_TRACE_DISABLED'] = savedTraceDisabled;
        if (savedAllowProjectMcp === undefined) delete process.env['AFK_ALLOW_PROJECT_MCP'];
        else process.env['AFK_ALLOW_PROJECT_MCP'] = savedAllowProjectMcp;
        rmSync(dir, { recursive: true, force: true });
      }
    },
    { timeout: 15_000 },
  );
});

describe('daemonTraceLabel', () => {
  const SAFE = /^[a-zA-Z0-9_-]+$/;

  it('prefixes the taskId so traces are greppable by task name', () => {
    const label = daemonTraceLabel('nightly-forge');
    expect(label.startsWith('nightly-forge-')).toBe(true);
    expect(SAFE.test(label)).toBe(true);
  });

  it('sanitizes disallowed characters so getTraceDir never throws', () => {
    const label = daemonTraceLabel('weird/../id with spaces.json');
    expect(SAFE.test(label)).toBe(true);
    expect(() => getTraceDir(label)).not.toThrow();
  });

  it('is unique per call so repeated ticks get their own trace dir', () => {
    expect(daemonTraceLabel('t')).not.toBe(daemonTraceLabel('t'));
  });

  it('falls back to a non-empty label when the taskId has no safe characters', () => {
    const label = daemonTraceLabel('///');
    expect(SAFE.test(label)).toBe(true);
    expect(label.startsWith('task-')).toBe(true);
  });
});

describe('resolveWorktreePruneRoot', () => {
  it('returns the explicit override without invoking git', async () => {
    const mock = vi.fn();
    const root = await resolveWorktreePruneRoot(mock as unknown as ExecFileFn, '/anywhere', '/pinned/repo');
    expect(root).toBe('/pinned/repo');
    expect(mock).not.toHaveBeenCalled();
  });

  it('discovers the repo root via git rev-parse when no override is set', async () => {
    const mock = vi.fn().mockResolvedValue({ stdout: '/Users/me/proj\n', stderr: '' });
    const root = await resolveWorktreePruneRoot(mock as unknown as ExecFileFn, '/Users/me/proj/sub', undefined);
    expect(root).toBe('/Users/me/proj');
    expect(mock).toHaveBeenCalledWith('git', ['rev-parse', '--show-toplevel'], { cwd: '/Users/me/proj/sub' });
  });

  it('returns null when cwd is not a git repo (rev-parse throws) — the daemon $HOME case', async () => {
    const mock = vi.fn().mockRejectedValue(new Error('fatal: not a git repository'));
    const root = await resolveWorktreePruneRoot(mock as unknown as ExecFileFn, '/Users/me', undefined);
    expect(root).toBeNull();
  });

  it('returns null when git yields empty output', async () => {
    const mock = vi.fn().mockResolvedValue({ stdout: '   \n', stderr: '' });
    const root = await resolveWorktreePruneRoot(mock as unknown as ExecFileFn, '/x', undefined);
    expect(root).toBeNull();
  });

  it('treats an empty-string override as unset and falls back to discovery', async () => {
    const mock = vi.fn().mockResolvedValue({ stdout: '/repo\n', stderr: '' });
    const root = await resolveWorktreePruneRoot(mock as unknown as ExecFileFn, '/repo/x', '');
    expect(root).toBe('/repo');
    expect(mock).toHaveBeenCalled();
  });
});
