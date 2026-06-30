/**
 * Separation contract test — agent-afk must run fully under ~/.afk/
 * with zero writes to ~/.claude/.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let tmpHome: string;
let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env['HOME'];
  tmpHome = join(tmpdir(), `afk-sep-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
  process.env['HOME'] = tmpHome;
});

afterEach(() => {
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
  if (originalHome !== undefined) process.env['HOME'] = originalHome;
  else delete process.env['HOME'];
});

describe('separation — daemon resolves all paths under ~/.afk', () => {
  it('getQueueDir resolves under ~/.afk, never ~/.claude', async () => {
    const { getQueueDir } = await import('../../paths.js');
    const queueDir = getQueueDir();
    expect(queueDir.startsWith(join(tmpHome, '.afk'))).toBe(true);
    expect(queueDir).not.toContain('.claude');
  });
});
