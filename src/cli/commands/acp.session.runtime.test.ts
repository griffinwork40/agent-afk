import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../../config/env.js';
import { _resetConfigCache } from '../config.js';
import { __setOpenAIClientFactory } from '../../agent/providers/openai-compatible/index.js';
import { buildAcpSession, closeAcpSession } from './acp.session.js';
import type { AcpSessionHandle } from './acp.session.js';

// Keep real session, stores, executors, layered MCP and provider. Only the
// network SDK boundary and plugin boot (unrelated installed code) are replaced.
vi.mock('../../agent/tools/skill-bridge.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../agent/tools/skill-bridge.js')>(),
  ensurePluginEntrypointsLoaded: async () => {},
}));

const fixture = fileURLToPath(new URL('../../agent/mcp/__fixtures__/test-server.mjs', import.meta.url));
let root: string;
let handle: AcpSessionHandle | undefined;
const requests: Array<{ tools?: Array<{ function?: { name?: string } }>; messages?: unknown[] }> = [];

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'acp-session-runtime-')));
  vi.spyOn(env, 'AFK_HOME', 'get').mockReturnValue(path.join(root, 'home'));
  vi.spyOn(env, 'AFK_STATE_DIR', 'get').mockReturnValue(path.join(root, 'state'));
  vi.spyOn(env, 'AFK_TRACE_DISABLED', 'get').mockReturnValue(undefined);
  vi.spyOn(env, 'OPENAI_API_KEY', 'get').mockReturnValue('test-key');
  vi.spyOn(env, 'AFK_OPENAI_BASE_URL', 'get').mockReturnValue('http://localhost:1234/v1');
  vi.spyOn(env, 'AFK_SYSTEM_PROMPT', 'get').mockReturnValue(undefined);
  vi.spyOn(env, 'AFK_ALLOW_PROJECT_MCP', 'get').mockReturnValue('1');
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  _resetConfigCache();
  requests.length = 0;
  __setOpenAIClientFactory(() => ({ chat: { completions: { create: async (args: (typeof requests)[number]) => {
    requests.push(args);
    return (async function* () {
      yield { choices: [{ delta: { content: 'hello from test' }, finish_reason: null }] };
      yield { choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
    })();
  } } } }) as unknown as ReturnType<NonNullable<Parameters<typeof __setOpenAIClientFactory>[0]>>);
});

afterEach(async () => {
  try { if (handle !== undefined) await closeAcpSession(handle); }
  finally {
    handle = undefined;
    __setOpenAIClientFactory(null);
    vi.restoreAllMocks();
    _resetConfigCache();
    rmSync(root, { recursive: true, force: true });
  }
});

describe('real ACP session runtime', () => {
  it('offers client MCP tools to the model and persists a sealed witness trace', async () => {
    writeFileSync(path.join(root, 'AFK.md'), 'ACP_PROJECT_OVERLAY_SENTINEL');
    handle = await buildAcpSession({
      model: 'gpt-4o-mini', maxTurns: 0, cwd: root,
      canUseTool: async () => ({ behavior: 'allow' }),
      mcpServers: { gui: { type: 'stdio', command: process.execPath, args: [fixture] } },
    });
    await handle.session.waitForInitialization();
    for await (const _event of handle.session.sendMessageStream('hello')) { /* drain */ }
    expect(requests).toHaveLength(1);
    expect(requests[0]?.tools?.map((t) => t.function?.name)).toContain('mcp__gui__echo');
    expect(JSON.stringify(requests[0]?.messages)).toContain('ACP_PROJECT_OVERLAY_SENTINEL');
    await closeAcpSession(handle);
    handle = undefined;
    const witnessRoot = path.join(root, 'state', 'witness');
    const dirs = readdirSync(witnessRoot);
    expect(dirs).toHaveLength(1);
    const rows = readFileSync(path.join(witnessRoot, dirs[0]!, 'trace.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line) as { kind: string });
    expect(rows.some((r) => r.kind === 'session_phase')).toBe(true);
    expect(rows[rows.length - 1]?.kind).toBe('session_sealed');
  }, 20_000);

  it('offers user/project configured MCP tools and permits an eleventh uncapped message', async () => {
    const configDir = path.join(root, 'home', 'config');
    mkdirSync(configDir, { recursive: true });
    const server = { type: 'stdio', command: process.execPath, args: [fixture] };
    writeFileSync(path.join(configDir, 'mcp.json'), JSON.stringify({ mcpServers: { user: server } }));
    writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { project: server } }));
    handle = await buildAcpSession({ model: 'gpt-4o-mini', maxTurns: 0, cwd: root });
    await handle.session.waitForInitialization();
    for (let n = 0; n < 11; n++) {
      for await (const _event of handle.session.sendMessageStream(`hello ${n}`)) { /* drain */ }
    }
    expect(requests).toHaveLength(11);
    const tools = requests[10]?.tools?.map((t) => t.function?.name);
    expect(tools).toContain('mcp__user__echo');
    expect(tools).toContain('mcp__project__echo');
  }, 20_000);
});
