// Contract: warnIfAfkMdOversize() emits a one-shot stderr warning when the
// composed AFK.md overlay exceeds OVERLAY_TOKEN_WARN_THRESHOLD estimated
// tokens, and stays silent for small overlays. loadAfkMd() itself never warns
// (it doubles as the shadow-report probe), loadConfig() warns only when the
// AFK.md tier wins, and deferral holds the warning until it is flushed.
//
// Uses a real tmp-dir so the fs mock layer from config.test.ts is not needed
// here — this exercises the loader's own warn path directly.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  loadAfkMd,
  resetAfkMdCache,
  _resetAfkMdSizeWarnCache,
  warnIfAfkMdOversize,
  deferAfkMdSizeWarnings,
  flushDeferredAfkMdSizeWarnings,
  OVERLAY_TOKEN_WARN_THRESHOLD,
} from './afk-md-tier.js';
import { loadConfig, _resetConfigCache } from '../config.js';
import { drainBootWarnings } from '../commands/interactive/boot-warnings.js';

// Silence/capture console.warn without suppressing test output.
let warnSpy: ReturnType<typeof vi.spyOn>;

// We need to control AFK_HOME so the user-tier path points into our tmp dir.
const TRACKED_ENV = ['AFK_HOME', 'AFK_SYSTEM_PROMPT'] as const;
let saved: Record<string, string | undefined>;
let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'afk-size-warn-'));
  saved = {};
  for (const k of TRACKED_ENV) saved[k] = process.env[k];
  // Point user-tier at a non-existent path inside tmp so only the project
  // tier (cwd) matters — avoids real ~/.afk/AFK.md bleeding in.
  process.env['AFK_HOME'] = join(tmpRoot, 'home');
  delete process.env['AFK_SYSTEM_PROMPT'];
  mkdirSync(join(tmpRoot, 'home'), { recursive: true });

  _resetConfigCache();
  resetAfkMdCache();
  _resetAfkMdSizeWarnCache();
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  for (const k of TRACKED_ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(tmpRoot, { recursive: true, force: true });
  _resetConfigCache();
  resetAfkMdCache();
  _resetAfkMdSizeWarnCache();
});

/** Build a string of approximately `tokens` estimated tokens (chars/3.5). */
function makeContent(tokens: number): string {
  // Each 'a' is 1 char = 1/3.5 tokens; multiply by 3.5 and add a small pad.
  return 'a'.repeat(Math.ceil(tokens * 3.5) + 10);
}

/** Write a project AFK.md of roughly `tokens` estimated tokens; return its cwd. */
function projectWith(name: string, tokens: number): string {
  const cwd = join(tmpRoot, name);
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, 'AFK.md'), makeContent(tokens));
  return cwd;
}

describe('warnIfAfkMdOversize()', () => {
  it('emits a console.warn when the overlay exceeds OVERLAY_TOKEN_WARN_THRESHOLD', () => {
    const cwd = projectWith('project-large', OVERLAY_TOKEN_WARN_THRESHOLD + 500);
    const result = loadAfkMd(cwd)!;

    warnIfAfkMdOversize(result);

    expect(result.estimatedTokens).toBeGreaterThan(OVERLAY_TOKEN_WARN_THRESHOLD);
    expect(warnSpy).toHaveBeenCalledOnce();
    const msg: string = warnSpy.mock.calls[0]![0] as string;
    expect(msg).toMatch(/\[afk\]/);
    expect(msg).toMatch(/AFK\.md/);
    expect(msg).toContain(join(cwd, 'AFK.md'));
    expect(msg).toMatch(/est\. tokens/);
    expect(msg).toMatch(/every API request/);
    expect(msg).toMatch(/\/afk-md/);
  });

  it('does NOT warn when the overlay is below the threshold', () => {
    const cwd = join(tmpRoot, 'project-small');
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, 'AFK.md'), 'Small AFK.md content.');
    const result = loadAfkMd(cwd)!;

    warnIfAfkMdOversize(result);

    expect(result.estimatedTokens).toBeLessThan(OVERLAY_TOKEN_WARN_THRESHOLD);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does NOT warn at exactly the threshold (strict >, same as /afk-md)', () => {
    warnIfAfkMdOversize({
      content: 'x',
      paths: ['/tmp/AFK.md'],
      estimatedTokens: OVERLAY_TOKEN_WARN_THRESHOLD,
    });
    expect(warnSpy).not.toHaveBeenCalled();
    warnIfAfkMdOversize({
      content: 'x',
      paths: ['/tmp/AFK.md'],
      estimatedTokens: OVERLAY_TOKEN_WARN_THRESHOLD + 1,
    });
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('warns exactly once per path set even when called multiple times', () => {
    const cwd = projectWith('project-once', OVERLAY_TOKEN_WARN_THRESHOLD + 100);

    warnIfAfkMdOversize(loadAfkMd(cwd)!);
    warnIfAfkMdOversize(loadAfkMd(cwd)!);
    resetAfkMdCache();
    warnIfAfkMdOversize(loadAfkMd(cwd)!);

    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('warns independently for two different oversized path sets', () => {
    // Positive dedup complement: each distinct path set gets its own warning.
    // This guards against the empty-key collapse bug (paths.join('\0') === ''
    // when paths is empty) by verifying that two *different* non-empty path
    // sets each produce exactly one warning — i.e. the dedup key is
    // path-set-specific, not global.
    warnIfAfkMdOversize({
      content: 'x',
      paths: ['/tmp/project-a/AFK.md'],
      estimatedTokens: OVERLAY_TOKEN_WARN_THRESHOLD + 1,
    });
    warnIfAfkMdOversize({
      content: 'x',
      paths: ['/tmp/project-b/AFK.md'],
      estimatedTokens: OVERLAY_TOKEN_WARN_THRESHOLD + 1,
    });
    expect(warnSpy).toHaveBeenCalledTimes(2);

    // Calling again with the same path sets produces no additional warnings.
    warnIfAfkMdOversize({
      content: 'x',
      paths: ['/tmp/project-a/AFK.md'],
      estimatedTokens: OVERLAY_TOKEN_WARN_THRESHOLD + 1,
    });
    warnIfAfkMdOversize({
      content: 'x',
      paths: ['/tmp/project-b/AFK.md'],
      estimatedTokens: OVERLAY_TOKEN_WARN_THRESHOLD + 1,
    });
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it('populates estimatedTokens on the result', () => {
    const cwd = join(tmpRoot, 'project-tokens');
    mkdirSync(cwd, { recursive: true });
    const content = 'hello world';
    writeFileSync(join(cwd, 'AFK.md'), content);

    const result = loadAfkMd(cwd);

    expect(result).not.toBeNull();
    // estimateTokens = ceil(11 / 3.5) = 4
    expect(result!.estimatedTokens).toBe(Math.ceil(content.length / 3.5));
  });
});

describe('loadAfkMd() is side-effect-free', () => {
  it('never warns, even for an oversized overlay', () => {
    const cwd = projectWith('project-probe', OVERLAY_TOKEN_WARN_THRESHOLD + 500);
    expect(loadAfkMd(cwd)).not.toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('loadConfig() size warning wiring', () => {
  it('warns when the AFK.md tier supplies the prompt', () => {
    const cwd = projectWith('cfg-wins', OVERLAY_TOKEN_WARN_THRESHOLD + 500);
    const cfg = loadConfig(undefined, cwd);
    expect(cfg.systemPromptSource).toContain('afk-md:');
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('does NOT warn for a shadowed AFK.md (AFK_SYSTEM_PROMPT wins)', () => {
    const cwd = projectWith('cfg-shadowed', OVERLAY_TOKEN_WARN_THRESHOLD + 500);
    process.env['AFK_SYSTEM_PROMPT'] = 'env prompt';
    _resetConfigCache();
    const cfg = loadConfig(undefined, cwd);
    expect(cfg.systemPromptSource).toBe('env:AFK_SYSTEM_PROMPT');
    expect(cfg.shadowedAfkMdPaths).toEqual([join(cwd, 'AFK.md')]);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('deferred size warnings (REPL screen-clear survival)', () => {
  it('holds the warning until flushed, then prints it once', () => {
    const cwd = projectWith('defer-flush', OVERLAY_TOKEN_WARN_THRESHOLD + 500);
    deferAfkMdSizeWarnings();
    warnIfAfkMdOversize(loadAfkMd(cwd)!);
    expect(warnSpy).not.toHaveBeenCalled();

    flushDeferredAfkMdSizeWarnings();
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]![0]).toContain(join(cwd, 'AFK.md'));

    flushDeferredAfkMdSizeWarnings();
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('flushing ends deferral so later warnings print immediately', () => {
    deferAfkMdSizeWarnings();
    flushDeferredAfkMdSizeWarnings();
    const cwd = projectWith('defer-after', OVERLAY_TOKEN_WARN_THRESHOLD + 500);
    warnIfAfkMdOversize(loadAfkMd(cwd)!);
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('drainBootWarnings (the post-clear REPL drain) flushes deferred warnings', () => {
    const cwd = projectWith('defer-drain', OVERLAY_TOKEN_WARN_THRESHOLD + 500);
    deferAfkMdSizeWarnings();
    warnIfAfkMdOversize(loadAfkMd(cwd)!);
    expect(warnSpy).not.toHaveBeenCalled();

    drainBootWarnings([]);
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]![0]).toContain(join(cwd, 'AFK.md'));
  });
});
