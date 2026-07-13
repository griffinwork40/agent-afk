/**
 * Tests for the config-bridge that registers shell-hook handlers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHookRegistry } from '../hooks.js';
import { HookBlockedError } from '../../utils/errors.js';
import { loadAndRegisterConfigHooks } from './config-bridge.js';
import { loadHooksConfig } from './config-loader.js';
import type { LoadedHooksConfig } from './config-loader.js';
import { createDefaultHookRegistry } from '../default-hook-registry.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'hook-bridge-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEnabledConfig(overrides: Partial<LoadedHooksConfig> = {}): LoadedHooksConfig {
  return {
    hooks: {},
    userGlobalEnabled: true,
    allowProjectHooks: false,
    sources: [],
    warnings: [],
    ...overrides,
  };
}

function makeDisabledConfig(overrides: Partial<LoadedHooksConfig> = {}): LoadedHooksConfig {
  return {
    hooks: {},
    userGlobalEnabled: false,
    allowProjectHooks: false,
    sources: [],
    warnings: [],
    ...overrides,
  };
}

/** Helper: build a ResolvedMatcherGroup with a default tier. */
function makeGroup(
  hooks: Array<{ type: 'command'; command: string; timeoutMs: number }>,
  opts: { matcher?: string; tier?: 'user-global' | 'project-local' } = {},
) {
  return {
    ...(opts.matcher !== undefined ? { matcher: opts.matcher } : {}),
    hooks,
    tier: opts.tier ?? 'user-global',
  };
}

function writeScript(name: string, content: string): string {
  const path = join(tmp, name);
  writeFileSync(path, content, 'utf-8');
  chmodSync(path, 0o755);
  return path;
}

// ---------------------------------------------------------------------------
// Trust gate
// ---------------------------------------------------------------------------

describe('trust gate', () => {
  it('no userGlobalEnabled → 0 handlers registered, console.warn emitted', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const registry = createHookRegistry();
    const config = makeDisabledConfig({
      hooks: {
        PreToolUse: [
          { hooks: [{ type: 'command', command: 'echo test', timeoutMs: 5000 }] },
        ],
      },
    });
    loadAndRegisterConfigHooks(registry, config, { cwd: tmp });
    expect(registry.count('PreToolUse')).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('enableShellHooks'),
    );
  });

  it('no userGlobalEnabled + no hooks → no warning (nothing to skip)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const registry = createHookRegistry();
    loadAndRegisterConfigHooks(registry, makeDisabledConfig(), { cwd: tmp });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('userGlobalEnabled=true → handlers ARE registered', () => {
    const registry = createHookRegistry();
    const config = makeEnabledConfig({
      hooks: {
        PreToolUse: [
          { hooks: [{ type: 'command', command: 'exit 0', timeoutMs: 5000 }] },
        ],
      },
    });
    loadAndRegisterConfigHooks(registry, config, { cwd: tmp });
    expect(registry.count('PreToolUse')).toBe(1);
  });

  it('project-local enableShellHooks alone does NOT activate hooks', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Simulate: project-local file has enableShellHooks: true but user-global doesn't.
    const registry = createHookRegistry();
    const config = makeDisabledConfig({
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: 'echo hi', timeoutMs: 3000 }] },
        ],
      },
    });
    // userGlobalEnabled is false (project-local only)
    loadAndRegisterConfigHooks(registry, config, { cwd: tmp });
    expect(registry.count('SessionStart')).toBe(0);
    expect(warnSpy).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Matcher filtering
// ---------------------------------------------------------------------------

describe('matcher filtering', () => {
  it('exact matcher "bash" → fires for bash, skips write_file', async () => {
    const scriptPath = writeScript('approve.sh', '#!/bin/sh\necho \'{"decision":"approve"}\'\n');
    const registry = createHookRegistry();
    const config = makeEnabledConfig({
      hooks: {
        PreToolUse: [
          {
            matcher: 'bash',
            hooks: [{ type: 'command', command: scriptPath, timeoutMs: 5000 }],
          },
        ],
      },
    });
    loadAndRegisterConfigHooks(registry, config, { cwd: tmp });

    // bash → should fire and approve
    const bashResult = await registry.dispatch({
      event: 'PreToolUse',
      toolName: 'bash',
    });
    expect(bashResult.decision).toBe('approve');

    // write_file → handler should return {} (no-match)
    const writeResult = await registry.dispatch({
      event: 'PreToolUse',
      toolName: 'write_file',
    });
    expect(writeResult.decision).toBeUndefined();
  });

  it('regex matcher "/^write_/" → fires for write_file, skips bash', async () => {
    const scriptPath = writeScript('approve.sh', '#!/bin/sh\necho \'{"decision":"approve"}\'\n');
    const registry = createHookRegistry();
    const config = makeEnabledConfig({
      hooks: {
        PreToolUse: [
          {
            matcher: '/^write_/',
            hooks: [{ type: 'command', command: scriptPath, timeoutMs: 5000 }],
          },
        ],
      },
    });
    loadAndRegisterConfigHooks(registry, config, { cwd: tmp });

    const writeResult = await registry.dispatch({
      event: 'PreToolUse',
      toolName: 'write_file',
    });
    expect(writeResult.decision).toBe('approve');

    const bashResult = await registry.dispatch({
      event: 'PreToolUse',
      toolName: 'bash',
    });
    expect(bashResult.decision).toBeUndefined();
  });

  it('no matcher (undefined) → fires for any tool name', async () => {
    const scriptPath = writeScript('approve.sh', '#!/bin/sh\necho \'{"decision":"approve"}\'\n');
    const registry = createHookRegistry();
    const config = makeEnabledConfig({
      hooks: {
        PreToolUse: [
          {
            hooks: [{ type: 'command', command: scriptPath, timeoutMs: 5000 }],
          },
        ],
      },
    });
    loadAndRegisterConfigHooks(registry, config, { cwd: tmp });

    const r1 = await registry.dispatch({ event: 'PreToolUse', toolName: 'bash' });
    const r2 = await registry.dispatch({ event: 'PreToolUse', toolName: 'read_file' });
    expect(r1.decision).toBe('approve');
    expect(r2.decision).toBe('approve');
  });

  it('"*" matcher fires for any tool name', async () => {
    const scriptPath = writeScript('approve.sh', '#!/bin/sh\necho \'{"decision":"approve"}\'\n');
    const registry = createHookRegistry();
    const config = makeEnabledConfig({
      hooks: {
        PreToolUse: [
          {
            matcher: '*',
            hooks: [{ type: 'command', command: scriptPath, timeoutMs: 5000 }],
          },
        ],
      },
    });
    loadAndRegisterConfigHooks(registry, config, { cwd: tmp });
    const result = await registry.dispatch({ event: 'PreToolUse', toolName: 'anything' });
    expect(result.decision).toBe('approve');
  });
});

// ---------------------------------------------------------------------------
// Non-tool events (no matcher applied)
// ---------------------------------------------------------------------------

describe('non-tool events', () => {
  it('SubagentStop with additionalContext → injectContext propagates', async () => {
    const scriptPath = writeScript(
      'subagent-stop.sh',
      '#!/bin/sh\necho \'{"hookSpecificOutput":{"additionalContext":"summary: all good"}}\'\n',
    );
    const registry = createHookRegistry();
    const config = makeEnabledConfig({
      hooks: {
        SubagentStop: [
          {
            hooks: [{ type: 'command', command: scriptPath, timeoutMs: 5000 }],
          },
        ],
      },
    });
    loadAndRegisterConfigHooks(registry, config, { cwd: tmp });
    const result = await registry.dispatch({
      event: 'SubagentStop',
      subagentId: 'sa-1',
      status: 'succeeded',
    });
    expect(result.injectContext).toBe('summary: all good');
  });

  it('SessionStart hook fires without matcher check', async () => {
    const scriptPath = writeScript(
      'session-start.sh',
      '#!/bin/sh\necho \'{"decision":"approve"}\'\n',
    );
    const registry = createHookRegistry();
    const config = makeEnabledConfig({
      hooks: {
        SessionStart: [
          {
            hooks: [{ type: 'command', command: scriptPath, timeoutMs: 5000 }],
          },
        ],
      },
    });
    loadAndRegisterConfigHooks(registry, config, { cwd: tmp });
    const result = await registry.dispatch({ event: 'SessionStart' });
    expect(result.decision).toBe('approve');
  });
});

// ---------------------------------------------------------------------------
// Blocking
// ---------------------------------------------------------------------------

describe('blocking', () => {
  it('exit 2 from hook → HookBlockedError propagated from dispatch', async () => {
    const scriptPath = writeScript(
      'block.sh',
      '#!/bin/sh\necho "not allowed" >&2\nexit 2\n',
    );
    const registry = createHookRegistry();
    const config = makeEnabledConfig({
      hooks: {
        PreToolUse: [
          {
            hooks: [{ type: 'command', command: scriptPath, timeoutMs: 5000 }],
          },
        ],
      },
    });
    loadAndRegisterConfigHooks(registry, config, { cwd: tmp });
    await expect(
      registry.dispatch({ event: 'PreToolUse', toolName: 'bash' }),
    ).rejects.toThrow(HookBlockedError);
  });
});

// ---------------------------------------------------------------------------
// Multiple handlers registered for same event
// ---------------------------------------------------------------------------

describe('multiple handlers', () => {
  it('registers one handler per hook (two hooks → two registrations)', () => {
    const registry = createHookRegistry();
    const config = makeEnabledConfig({
      hooks: {
        PreToolUse: [
          {
            hooks: [
              { type: 'command', command: 'exit 0', timeoutMs: 3000 },
              { type: 'command', command: 'exit 0', timeoutMs: 3000 },
            ],
          },
        ],
      },
    });
    loadAndRegisterConfigHooks(registry, config, { cwd: tmp });
    expect(registry.count('PreToolUse')).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// createDefaultHookRegistry integration
// ---------------------------------------------------------------------------

describe('createDefaultHookRegistry integration', () => {
  let afkHome: string;
  let projectCwd: string;
  let originalAfkHome: string | undefined;
  let originalDisablePathApproval: string | undefined;

  beforeEach(() => {
    afkHome = join(tmp, 'afk-home');
    projectCwd = join(tmp, 'project');
    mkdirSync(join(afkHome, 'config'), { recursive: true });
    mkdirSync(projectCwd, { recursive: true });
    originalAfkHome = process.env['AFK_HOME'];
    process.env['AFK_HOME'] = afkHome;
    // These tests count config-driven PreToolUse hooks specifically. The
    // path-approval feature otherwise registers 2 always-on PreToolUse hooks
    // (path-approval + bash-restriction) in createDefaultHookRegistry, which
    // would inflate the counts and conflate two orthogonal concerns. Disable
    // it so the assertions measure only the config bridge under test.
    originalDisablePathApproval = process.env['AFK_DISABLE_PATH_APPROVAL'];
    process.env['AFK_DISABLE_PATH_APPROVAL'] = '1';
  });

  afterEach(() => {
    if (originalAfkHome === undefined) delete process.env['AFK_HOME'];
    else process.env['AFK_HOME'] = originalAfkHome;
    if (originalDisablePathApproval === undefined)
      delete process.env['AFK_DISABLE_PATH_APPROVAL'];
    else process.env['AFK_DISABLE_PATH_APPROVAL'] = originalDisablePathApproval;
  });

  it('createDefaultHookRegistry without hookConfig → 0 config hooks registered', () => {
    const { registry } = createDefaultHookRegistry();
    // Built-in handlers exist for SubagentStop and SessionEnd, plus the THREE
    // always-on built-in PreToolUse handlers (the ask-question gate, the
    // observe-only safe-destruct detector, and the observe-only release-boundary
    // detector), all registered unconditionally. No further PreToolUse hooks
    // since we passed no hookConfig (path-approval disabled above).
    expect(registry.count('PreToolUse')).toBe(3);
  });

  it('createDefaultHookRegistry with hookConfig → config hooks ARE registered', () => {
    const scriptPath = writeScript('my-hook.sh', '#!/bin/sh\nexit 0\n');
    const hookConfig: LoadedHooksConfig = {
      hooks: {
        PreToolUse: [
          {
            hooks: [{ type: 'command', command: scriptPath, timeoutMs: 3000 }],
          },
        ],
      },
      userGlobalEnabled: true,
      sources: [],
      warnings: [],
    };
    const { registry } = createDefaultHookRegistry(
      undefined,
      undefined,
      undefined,
      undefined,
      hookConfig,
      { cwd: projectCwd },
    );
    // 3 built-ins (ask-question gate + safe-destruct detector + release-boundary
    // detector) + 1 config hook
    expect(registry.count('PreToolUse')).toBe(4);
  });

  it('built-in SubagentStop handler still present when hookConfig is provided', () => {
    const scriptPath = writeScript('my-hook.sh', '#!/bin/sh\nexit 0\n');
    const hookConfig: LoadedHooksConfig = {
      hooks: {
        SubagentStop: [
          {
            hooks: [{ type: 'command', command: scriptPath, timeoutMs: 3000 }],
          },
        ],
      },
      userGlobalEnabled: true,
      sources: [],
      warnings: [],
    };
    const { registry } = createDefaultHookRegistry(
      undefined,
      undefined,
      undefined,
      undefined,
      hookConfig,
      { cwd: projectCwd },
    );
    // At least 2: built-in shadowVerifyNudge + the config hook
    expect(registry.count('SubagentStop')).toBeGreaterThanOrEqual(2);
  });

  it('loadHooksConfig layered load + createDefaultHookRegistry end-to-end', () => {
    // Write user-global config with enableShellHooks and a hook.
    writeFileSync(
      join(afkHome, 'config', 'afk.config.json'),
      JSON.stringify({
        enableShellHooks: true,
        hooks: {
          SessionStart: [
            { hooks: [{ type: 'command', command: 'exit 0' }] },
          ],
        },
      }),
      'utf-8',
    );
    const hookConfig = loadHooksConfig({ cwd: projectCwd });
    expect(hookConfig.userGlobalEnabled).toBe(true);

    const { registry } = createDefaultHookRegistry(
      undefined,
      undefined,
      undefined,
      undefined,
      hookConfig,
      { cwd: projectCwd },
    );
    expect(registry.count('SessionStart')).toBe(1);
  });
});
