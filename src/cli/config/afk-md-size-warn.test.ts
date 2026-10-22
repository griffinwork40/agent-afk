// Contract: loadAfkMd() emits a one-shot stderr warning when the composed
// AFK.md overlay exceeds OVERLAY_TOKEN_WARN_THRESHOLD estimated tokens, and
// stays silent for small overlays.
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
  OVERLAY_TOKEN_WARN_THRESHOLD,
} from './afk-md-tier.js';

// Silence/capture console.warn without suppressing test output.
let warnSpy: ReturnType<typeof vi.spyOn>;

// We need to control AFK_HOME so the user-tier path points into our tmp dir.
const TRACKED_ENV = ['AFK_HOME'] as const;
let saved: Record<string, string | undefined>;
let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'afk-size-warn-'));
  saved = {};
  for (const k of TRACKED_ENV) saved[k] = process.env[k];
  // Point user-tier at a non-existent path inside tmp so only the project
  // tier (cwd) matters — avoids real ~/.afk/AFK.md bleeding in.
  process.env['AFK_HOME'] = join(tmpRoot, 'home');
  mkdirSync(join(tmpRoot, 'home'), { recursive: true });

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
  resetAfkMdCache();
  _resetAfkMdSizeWarnCache();
});

/** Build a string of approximately `tokens` estimated tokens (chars/3.5). */
function makeContent(tokens: number): string {
  // Each 'a' is 1 char = 1/3.5 tokens; multiply by 3.5 and add a small pad.
  return 'a'.repeat(Math.ceil(tokens * 3.5) + 10);
}

describe('loadAfkMd() size warning', () => {
  it('emits a console.warn when the overlay exceeds OVERLAY_TOKEN_WARN_THRESHOLD', () => {
    const cwd = join(tmpRoot, 'project-large');
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, 'AFK.md'), makeContent(OVERLAY_TOKEN_WARN_THRESHOLD + 500));

    const result = loadAfkMd(cwd);

    expect(result).not.toBeNull();
    expect(result!.estimatedTokens).toBeGreaterThanOrEqual(OVERLAY_TOKEN_WARN_THRESHOLD);
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
    // Well under the 10k threshold
    writeFileSync(join(cwd, 'AFK.md'), 'Small AFK.md content.');

    const result = loadAfkMd(cwd);

    expect(result).not.toBeNull();
    expect(result!.estimatedTokens).toBeLessThan(OVERLAY_TOKEN_WARN_THRESHOLD);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns exactly once per path set even when called multiple times', () => {
    const cwd = join(tmpRoot, 'project-once');
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, 'AFK.md'), makeContent(OVERLAY_TOKEN_WARN_THRESHOLD + 100));

    loadAfkMd(cwd); // first call — warns, populates cache
    loadAfkMd(cwd); // second call — returns from cache; warn NOT repeated

    // Bust the cache and call again — path key already in warnedAfkMdSize
    resetAfkMdCache();
    loadAfkMd(cwd);

    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('includes the path in the warning message', () => {
    const cwd = join(tmpRoot, 'project-path-check');
    mkdirSync(cwd, { recursive: true });
    const afkMdPath = join(cwd, 'AFK.md');
    writeFileSync(afkMdPath, makeContent(OVERLAY_TOKEN_WARN_THRESHOLD + 200));

    loadAfkMd(cwd);

    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]![0]).toContain(afkMdPath);
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
