import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { createDefaultHookRegistry, _resetWarningForTests } from './default-hook-registry.js';
import { elicitationRouter } from './elicitation-router.js';
import { ASK_QUESTION_GATE_REASON } from './ask-question-gate.js';
import { EPISODE_BLOCK_REASON, resetWhatifEpisodeGateForTests } from './whatif-episode-gate.js';
import { SessionToolDispatcher } from './tools/dispatcher.js';
import { builtinToolSchemas } from './tools/schemas.js';
import type { GrantManager } from './tools/grant-manager.js';
import type { ToolHandler } from './tools/types.js';

vi.mock('../telegram/push.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../telegram/push.js')>(),
  pushIfConfigured: vi.fn().mockResolvedValue(undefined),
}));

// workspace is created fresh per test so the root exists on disk and grants
// resolve against a real directory (previously a literal tmpdir path was used
// which never existed; worked only because the handler spy is inert, but caused
// confusion for path-approval hooks that inspect the root).
let workspace: string;
const outside = path.join(tmpdir(), 'afk-liveness-outside', 'note.txt');

function setup(toolName: string, grants?: GrantManager, parentSessionId?: string) {
  const { registry } = createDefaultHookRegistry(undefined, 'cli', undefined, undefined, undefined, { cwd: workspace });
  // Contract: the handler is an inert spy; these tests never read, write, or execute a tool payload.
  const handler = vi.fn<ToolHandler>().mockResolvedValue({ content: 'inert handler' });
  const dispatcher = new SessionToolDispatcher({
    handlers: new Map([[toolName, handler]]),
    schemas: [...builtinToolSchemas],
    permissions: { allowedTools: [toolName] },
    hookRegistry: registry,
    ...(grants ? { sessionGrantManager: grants } : {}),
    ...(parentSessionId ? { parentSessionId } : {}),
  });
  const execute = (input: unknown) => dispatcher.execute({
    id: 'liveness-call', name: toolName, input, signal: new AbortController().signal,
  });
  return { registry, handler, execute };
}

function confinedGrants(): GrantManager {
  return {
    getGrants: () => ({ resolveBase: workspace, readRoots: [workspace], writeRoots: [workspace] }),
    addReadRoot: vi.fn(), addWriteRoot: vi.fn(), revokeRoot: vi.fn(),
  };
}

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), 'afk-liveness-workspace-'));
  vi.stubEnv('AFK_WHATIF_EPISODE', '0');
  vi.stubEnv('AFK_WHATIF_TOOL_LOG', '');
  vi.stubEnv('AFK_DISABLE_PATH_APPROVAL', '0');
  vi.stubEnv('AFK_DISABLE_BASH_INTERPRETER_GUARD', '0');
  vi.stubEnv('AFK_FORCE_BASH_INTERPRETER_GUARD', '0');
  elicitationRouter.uninstall();
  resetWhatifEpisodeGateForTests();
  _resetWarningForTests();
});

afterEach(() => {
  elicitationRouter.uninstall();
  resetWhatifEpisodeGateForTests();
  _resetWarningForTests();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  try {
    rmSync(workspace, { recursive: true, force: true });
  } catch {
    // force:true already suppresses ENOENT (directory already removed or never
    // created when mkdtempSync in beforeEach failed).  This catch guards against
    // non-ENOENT failures such as permission errors or OS-level locks.
  }
});

describe('default registry safety gate liveness through dispatcher initialization', () => {
  it('path approval receives dispatcher grants and denies an outside read', async () => {
    const approval = vi.fn().mockResolvedValue({ action: 'accept', content: { value: 'deny' } });
    elicitationRouter.install(approval);
    const { execute, handler } = setup('read_file', confinedGrants());
    const result = await execute({ file_path: outside });
    expect(approval).toHaveBeenCalledOnce();
    expect(result.isError).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it('bash restriction receives dispatcher grants and blocks credential interpreter payloads', async () => {
    const { execute, handler } = setup('bash', confinedGrants());
    const result = await execute({ command: `python3 -c 'print("${path.join(homedir(), '.ssh', 'id_rsa')}")'` });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/interpreter/i);
    expect(handler).not.toHaveBeenCalled();
  });

  it('question gate blocks without a handler and observes a handler installed after initialization', async () => {
    const { execute, handler } = setup('ask_question');
    const blocked = await execute({ question: 'Continue?' });
    expect(blocked.isError).toBe(true);
    expect(blocked.content).toContain(ASK_QUESTION_GATE_REASON);
    expect(handler).not.toHaveBeenCalled();
    elicitationRouter.install(async () => ({ action: 'decline' }));
    const allowed = await execute({ question: 'Continue?' });
    expect(allowed.isError).not.toBe(true);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('child hot-memory guard receives parent identity and blocks hot writes but permits facts', async () => {
    const { execute, handler } = setup('memory_update', undefined, 'parent-liveness');
    const blocked = await execute({ target: 'hot', action: 'set', content: 'test' });
    expect(blocked.isError).toBe(true);
    expect(blocked.content).toMatch(/hot/i);
    expect(handler).not.toHaveBeenCalled();
    const allowed = await execute({ target: 'fact', action: 'set', category: 'learning', content: 'test' });
    expect(allowed.isError).not.toBe(true);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('episode gate blocks before child hot-memory guard and latches subsequent reads', async () => {
    vi.stubEnv('AFK_WHATIF_EPISODE', '1');
    const { execute, handler, registry } = setup('memory_update', undefined, 'parent-liveness');
    const blocked = await execute({ target: 'hot', action: 'set', content: 'test' });
    expect(blocked.isError).toBe(true);
    expect(blocked.content).toContain(EPISODE_BLOCK_REASON);
    expect(handler).not.toHaveBeenCalled();
    await expect(registry.dispatch({ event: 'PreToolUse', toolName: 'read_file', input: { file_path: outside } }))
      .rejects.toMatchObject({ message: expect.stringContaining(EPISODE_BLOCK_REASON) });
  });

  it('disable flag removes both path approval and bash restriction registration', async () => {
    const enabled = setup('bash', confinedGrants());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('AFK_DISABLE_PATH_APPROVAL', '1');
    const disabled = setup('bash', confinedGrants());
    expect(enabled.registry.count('PreToolUse') - disabled.registry.count('PreToolUse')).toBe(2);
    expect(enabled.registry.count('PostToolUse') - disabled.registry.count('PostToolUse')).toBe(1);
    expect(enabled.registry.count('SessionEnd') - disabled.registry.count('SessionEnd')).toBe(1);
    const result = await disabled.execute({ command: `python3 -c 'print("${path.join(homedir(), '.ssh', 'id_rsa')}")'` });
    expect(result.isError).not.toBe(true);
    expect(disabled.handler).toHaveBeenCalledOnce();
    setup('bash');
    expect(warn.mock.calls.filter(([message]) => String(message).includes('AFK_DISABLE_PATH_APPROVAL'))).toHaveLength(1);
  });
});
