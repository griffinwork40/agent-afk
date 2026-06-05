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
  it('gates.defaultBriefsDir returns ~/.afk/agent-framework/briefs', async () => {
    const { defaultBriefsDir } = await import('./gates.js');
    const briefs = defaultBriefsDir();
    expect(briefs).toBe(join(tmpHome, '.afk', 'agent-framework', 'briefs'));
    expect(briefs).not.toContain('.claude');
  });
});
