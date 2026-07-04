/**
 * Tests for the new path helpers that back the AFK ⇢ `~/.afk/` separation
 * from `~/.claude/`. These helpers are consumed by scheduler/gates and by
 * the user-scope scanners that resolve AFK state directly.
 *
 * Points HOME at a tmp dir so nothing touches the real ~/.afk.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  getAgentFrameworkDir,
  getTelemetryPath,
  getBriefsDir,
  getSdkHomeDir,
  getAfkHome,
  getPluginsDir,
} from './paths.js';
import { useUnsetAfkHome } from './__test-utils__/unset-afk-home.js';

let tmpHome: string;
let originalHome: string | undefined;

// This suite asserts the unset-AFK_HOME fallback ($HOME/.afk) — drop the
// global sentinel AFK_HOME per test; HOME is redirected to a tmp dir below.
useUnsetAfkHome();

beforeEach(() => {
  originalHome = process.env['HOME'];
  tmpHome = join(tmpdir(), `afk-sep-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  process.env['HOME'] = tmpHome;
});

afterEach(() => {
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
  if (originalHome !== undefined) process.env['HOME'] = originalHome;
  else delete process.env['HOME'];
});

describe('paths — separation helpers', () => {
  it('getSdkHomeDir equals getAfkHome (SDK config root)', () => {
    expect(getSdkHomeDir()).toBe(getAfkHome());
    expect(getSdkHomeDir()).toBe(join(tmpHome, '.afk'));
  });

  it('getAgentFrameworkDir nests under ~/.afk, not ~/.claude', () => {
    expect(getAgentFrameworkDir()).toBe(join(tmpHome, '.afk', 'agent-framework'));
    expect(getAgentFrameworkDir()).not.toContain('.claude');
  });

  it('getTelemetryPath points at ~/.afk/agent-framework/forge-telemetry.jsonl', () => {
    expect(getTelemetryPath()).toBe(
      join(tmpHome, '.afk', 'agent-framework', 'forge-telemetry.jsonl')
    );
  });

  it('getBriefsDir points at ~/.afk/agent-framework/briefs', () => {
    expect(getBriefsDir()).toBe(join(tmpHome, '.afk', 'agent-framework', 'briefs'));
  });

  it('getPluginsDir points at ~/.afk/plugins', () => {
    expect(getPluginsDir()).toBe(join(tmpHome, '.afk', 'plugins'));
    expect(getPluginsDir()).not.toContain('.claude');
  });
});
