/**
 * Command-level tests for `/afk-md`.
 *
 * The load-bearing case is the hot-reload ordering invariant: the AFK.md cache
 * MUST be busted before the prompt is re-derived, and the value handed to
 * `setSystemPrompt` MUST be the fully composed base prompt from
 * `resolveBaseSystemPrompt()` — never the bare `loadAfkMd().content`, which would
 * silently strip the framework doctrine from a running session.
 *
 * `shared-helpers` and `afk-md-tier` are mocked so the assertion is exact and
 * machine-independent (it does not depend on the operator's real config tiers).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmpRoot = '';
const userDir = (): string => join(tmpRoot, 'home');
const projectDir = (): string => join(tmpRoot, 'repo');

/** Ordered log of the cache-bust / read / apply sequence. */
let callLog: string[] = [];
/** Overlay text the mocked loader reports. */
let overlayContent: string | null = null;
let promptSource = 'framework+afk-md:/fixture/AFK.md';

const COMPOSED_SENTINEL = 'FRAMEWORK-DOCTRINE\n\n# Operator configuration\n\nOVERLAY-TEXT';

// Invariant: this specifier MUST resolve to `src/paths.ts` — from
// `src/cli/slash/commands/` that is THREE levels up, not two. The global test
// setup (`src/__test-utils__/redirect-paths-env.ts`) redirects AFK_HOME so the
// USER tier is already safe, but nothing redirects `process.cwd()`, so the
// PROJECT tier resolves to the real repo-root AFK.md. A wrong specifier here is
// silently inert and the project-tier tests then read and APPEND to this
// repository's own tracked AFK.md.
vi.mock('../../../paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../paths.js')>();
  return {
    ...actual,
    getUserAfkMdPath: (): string => join(userDir(), 'AFK.md'),
    getProjectAfkMdPath: (cwd?: string): string => join(cwd ?? projectDir(), 'AFK.md'),
  };
});

vi.mock('../../config/afk-md-tier.js', () => ({
  resetAfkMdCache: (): void => { callLog.push('bust'); },
  loadAfkMd: (): { content: string; paths: string[] } | null => {
    callLog.push('read');
    return overlayContent === null ? null : { content: overlayContent, paths: [] };
  },
}));

vi.mock('../../config.js', () => ({
  _resetConfigCache: (): void => { callLog.push('bust-composed'); },
  loadConfig: (): { autoRouting: { interactive: boolean } } => ({
    autoRouting: { interactive: false },
  }),
}));

vi.mock('../../shared-helpers.js', () => ({
  resolveBaseSystemPrompt: (): { prompt: string; source: string } => {
    callLog.push('compose');
    return { prompt: COMPOSED_SENTINEL, source: promptSource };
  },
}));

const spawnMock = vi.fn();
vi.mock('./editor-spawn.js', () => ({
  resolveEditor: (): { cmd: string; args: string[] } | null => ({ cmd: 'vim', args: [] }),
  spawnEditorOnPath: (...args: unknown[]): unknown => spawnMock(...args),
}));

const { afkMdCmd } = await import('./afk-md.js');
import type { SlashContext } from '../types.js';

function plain(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001B\[[0-9;]*m/g, '');
}

interface Harness {
  ctx: SlashContext;
  lines: string[];
  setSystemPrompt: ReturnType<typeof vi.fn>;
  text: () => string;
}

function makeCtx(opts: { tty?: boolean; applied?: boolean; cwd?: string } = {}): Harness {
  const lines: string[] = [];
  const push = (s: string): void => { lines.push(plain(s)); };
  const setSystemPrompt = vi.fn((_p: string | undefined) => {
    callLog.push('apply');
    return opts.applied ?? true;
  });
  const compositor = opts.tty === false ? null : ({} as unknown);
  const ctx = {
    session: { current: { setSystemPrompt } },
    out: {
      line: push,
      raw: push,
      success: (s: string) => push(`OK ${s}`),
      info: (s: string) => push(`INFO ${s}`),
      warn: (s: string) => push(`WARN ${s}`),
      error: (s: string) => push(`ERR ${s}`),
    },
    ui: { clearScreen: vi.fn(), repaintStatusLine: vi.fn() },
    stats: { model: 'test', cwd: opts.cwd ?? projectDir() },
    getCompositor: () => compositor,
  } as unknown as SlashContext;
  return { ctx, lines, setSystemPrompt, text: () => lines.join('\n') };
}

beforeEach(() => {
  tmpRoot = join(tmpdir(), `afk-md-cmd-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(userDir(), { recursive: true });
  mkdirSync(projectDir(), { recursive: true });
  callLog = [];
  overlayContent = 'OVERLAY-TEXT';
  promptSource = 'framework+afk-md:/fixture/AFK.md';
  spawnMock.mockReset();
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('/afk-md registration', () => {
  it('is aliased to /memory for Claude Code muscle memory', () => {
    expect(afkMdCmd.name).toBe('/afk-md');
    expect(afkMdCmd.aliases).toContain('/memory');
  });
});

describe('/afk-md overview', () => {
  it('disambiguates the /memory alias from AFK cross-session memory', async () => {
    const h = makeCtx();
    await afkMdCmd.handler(h.ctx, '');
    expect(h.text()).toContain('memory_update');
    expect(h.text()).toContain('AFK.md prompt overlay');
  });

  it('names the resolved editor', async () => {
    const h = makeCtx();
    await afkMdCmd.handler(h.ctx, '');
    expect(h.text()).toContain('editor: vim');
  });
});

describe('/afk-md show', () => {
  it('prints the composed overlay verbatim', async () => {
    const h = makeCtx();
    await afkMdCmd.handler(h.ctx, 'show');
    expect(h.text()).toContain('OVERLAY-TEXT');
  });

  it('works on a non-TTY surface (no editor required)', async () => {
    const h = makeCtx({ tty: false });
    const result = await afkMdCmd.handler(h.ctx, 'show');
    expect(result).toBe('continue');
    expect(h.text()).toContain('OVERLAY-TEXT');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('reports honestly when no overlay is active', async () => {
    overlayContent = null;
    const h = makeCtx();
    await afkMdCmd.handler(h.ctx, 'show');
    expect(h.text()).toContain('No AFK.md overlay is active');
  });
});

describe('/afk-md reload — ordering invariant', () => {
  it('busts the cache BEFORE re-deriving, and applies only after', async () => {
    const h = makeCtx();
    await afkMdCmd.handler(h.ctx, 'reload');

    const bust = callLog.indexOf('bust');
    const compose = callLog.indexOf('compose');
    const apply = callLog.indexOf('apply');
    expect(bust).toBeGreaterThanOrEqual(0);
    expect(compose).toBeGreaterThan(bust);
    expect(apply).toBeGreaterThan(compose);
  });

  it('applies the FULL composed prompt, not the bare AFK.md overlay', async () => {
    const h = makeCtx();
    await afkMdCmd.handler(h.ctx, 'reload');

    expect(h.setSystemPrompt).toHaveBeenCalledTimes(1);
    const applied = h.setSystemPrompt.mock.calls[0]?.[0] as string;
    expect(applied).toContain(COMPOSED_SENTINEL);
    // The regression this guards: passing loadAfkMd().content would lose the
    // framework doctrine entirely.
    expect(applied).toContain('FRAMEWORK-DOCTRINE');
    expect(applied).toContain('# Operator configuration');
    expect(applied).toContain('Every turn must end in one externally identifiable terminal state');
    expect(applied).not.toBe('OVERLAY-TEXT');
  });

  it('claims a hot-reload only when the provider actually applied it', async () => {
    const ok = makeCtx({ applied: true });
    await afkMdCmd.handler(ok.ctx, 'reload');
    expect(ok.text()).toContain('Takes effect on your next message');

    callLog = [];
    const no = makeCtx({ applied: false });
    await afkMdCmd.handler(no.ctx, 'reload');
    expect(no.text()).toContain('applies on next launch');
    expect(no.text()).not.toContain('Takes effect on your next message');
  });

  it('reports AFK.md as shadowed by a higher-priority prompt override', async () => {
    promptSource = 'framework+env:AFK_SYSTEM_PROMPT';
    const h = makeCtx();
    await afkMdCmd.handler(h.ctx, 'reload');
    expect(h.text()).toContain('shadowed by a higher-priority system prompt override');
    expect(h.text()).not.toContain('Takes effect on your next message');
  });
});

describe('/afk-md add', () => {
  it('appends a bullet to the project tier by default and names the destination', async () => {
    const h = makeCtx();
    await afkMdCmd.handler(h.ctx, 'add always use pnpm');
    const written = readFileSync(join(projectDir(), 'AFK.md'), 'utf-8');
    expect(written).toContain('- always use pnpm');
    expect(h.text()).toContain(join(projectDir(), 'AFK.md'));
  });

  it('retargets to the personal tier with --user', async () => {
    const h = makeCtx();
    await afkMdCmd.handler(h.ctx, 'add --user be terse');
    expect(readFileSync(join(userDir(), 'AFK.md'), 'utf-8')).toContain('- be terse');
    expect(existsSync(join(projectDir(), 'AFK.md'))).toBe(false);
  });

  it('targets the active session cwd instead of the launch cwd', async () => {
    const activeCwd = join(tmpRoot, 'active-worktree');
    mkdirSync(activeCwd, { recursive: true });
    const h = makeCtx({ cwd: activeCwd });
    await afkMdCmd.handler(h.ctx, 'add worktree rule');
    expect(readFileSync(join(activeCwd, 'AFK.md'), 'utf-8')).toContain('- worktree rule');
    expect(existsSync(join(projectDir(), 'AFK.md'))).toBe(false);
  });

  it('creates the file with a scaffold when absent', async () => {
    const h = makeCtx();
    await afkMdCmd.handler(h.ctx, 'add first rule');
    const written = readFileSync(join(projectDir(), 'AFK.md'), 'utf-8');
    expect(written).toContain('# Operator configuration');
    expect(written).toContain('- first rule');
    expect(h.text()).toContain('Created');
  });

  it('does not stack blank lines when appending to an existing file', async () => {
    writeFileSync(join(projectDir(), 'AFK.md'), '- one', 'utf-8');
    const h = makeCtx();
    await afkMdCmd.handler(h.ctx, 'add two');
    expect(readFileSync(join(projectDir(), 'AFK.md'), 'utf-8')).toBe('- one\n- two\n');
  });

  it('rejects an empty add without touching disk', async () => {
    const h = makeCtx();
    await afkMdCmd.handler(h.ctx, 'add   ');
    expect(h.text()).toContain('Nothing to add');
    expect(existsSync(join(projectDir(), 'AFK.md'))).toBe(false);
  });

  it('hot-reloads after appending', async () => {
    const h = makeCtx();
    await afkMdCmd.handler(h.ctx, 'add x');
    expect(h.setSystemPrompt.mock.calls[0]?.[0]).toContain(COMPOSED_SENTINEL);
  });
});

describe('/afk-md edit', () => {
  it('refuses on a non-TTY surface and points at the file instead', async () => {
    spawnMock.mockResolvedValue({ outcome: 'no-tty', exitCode: null });
    const h = makeCtx({ tty: false });
    const result = await afkMdCmd.handler(h.ctx, 'project');
    expect(result).toBe('continue');
    expect(h.text()).toContain('Edit it directly');
    expect(h.setSystemPrompt).not.toHaveBeenCalled();
  });

  it('does not reload when the editor made no changes', async () => {
    writeFileSync(join(projectDir(), 'AFK.md'), '- unchanged\n', 'utf-8');
    spawnMock.mockResolvedValue({ outcome: 'clean', exitCode: 0 });
    const h = makeCtx();
    await afkMdCmd.handler(h.ctx, 'project');
    expect(h.text()).toContain('No changes');
    expect(h.setSystemPrompt).not.toHaveBeenCalled();
  });

  it('diffs and reloads when the editor changed the file', async () => {
    const path = join(projectDir(), 'AFK.md');
    writeFileSync(path, '- old\n', 'utf-8');
    spawnMock.mockImplementation(async () => {
      writeFileSync(path, '- old\n- new\n', 'utf-8');
      return { outcome: 'clean', exitCode: 0 };
    });
    const h = makeCtx();
    await afkMdCmd.handler(h.ctx, 'project');
    expect(h.text()).toContain('+1');
    expect(h.text()).toContain('- new');
    expect(h.setSystemPrompt.mock.calls[0]?.[0]).toContain(COMPOSED_SENTINEL);
  });

  it('warns when an edit empties the tier', async () => {
    const path = join(userDir(), 'AFK.md');
    writeFileSync(path, '- something\n', 'utf-8');
    spawnMock.mockImplementation(async () => {
      writeFileSync(path, '\n', 'utf-8');
      return { outcome: 'clean', exitCode: 0 };
    });
    const h = makeCtx();
    await afkMdCmd.handler(h.ctx, 'user');
    expect(h.text()).toContain('treated as ABSENT');
  });

  it('treats a nonzero editor exit as discard and reloads nothing', async () => {
    writeFileSync(join(projectDir(), 'AFK.md'), '- keep\n', 'utf-8');
    spawnMock.mockResolvedValue({ outcome: 'nonzero', exitCode: 1 });
    const h = makeCtx();
    await afkMdCmd.handler(h.ctx, 'project');
    expect(h.text()).toContain('discard');
    expect(h.setSystemPrompt).not.toHaveBeenCalled();
  });

  it('accepts the numeric row labels from the overview', async () => {
    spawnMock.mockResolvedValue({ outcome: 'clean', exitCode: 0 });
    const h = makeCtx();
    await afkMdCmd.handler(h.ctx, '1');
    expect(spawnMock).toHaveBeenCalled();
    const arg = spawnMock.mock.calls[0]?.[0] as { filePath: string };
    expect(arg.filePath).toBe(join(userDir(), 'AFK.md'));
  });
});

describe('/afk-md unknown subcommand', () => {
  it('prints usage and continues rather than throwing', async () => {
    const h = makeCtx();
    const result = await afkMdCmd.handler(h.ctx, 'frobnicate');
    expect(result).toBe('continue');
    expect(h.text()).toContain('Unknown subcommand');
    expect(h.text()).toContain('/afk-md show');
    expect(h.setSystemPrompt).not.toHaveBeenCalled();
  });
});
