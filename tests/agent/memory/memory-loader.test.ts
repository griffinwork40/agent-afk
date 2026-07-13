/**
 * Tests for src/agent/memory/memory-loader.ts — hot memory injection into system prompt.
 *
 * Points HOME at a tmp dir so nothing touches the real ~/.afk.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import type { AgentConfig } from '../../../src/agent/types/config-types.js';
import { loadHotMemory, injectHotMemory } from '../../../src/agent/memory/memory-loader.js';
import { useUnsetAfkHome } from '../../../src/__test-utils__/unset-afk-home.js';

let tmpHome: string;
let originalHome: string | undefined;

// HOT.md fixtures are written under $HOME/.afk/state/memory and the loader
// resolves that via the unset-AFK_HOME fallback — drop the global sentinel
// AFK_HOME per test; HOME is redirected to a tmp dir below.
useUnsetAfkHome();

beforeEach(() => {
  originalHome = process.env['HOME'];
  tmpHome = join(tmpdir(), `afk-mem-loader-${randomUUID()}`);
  mkdirSync(join(tmpHome, '.afk', 'state', 'memory'), { recursive: true });
  process.env['HOME'] = tmpHome;
});

afterEach(() => {
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
  if (originalHome !== undefined) process.env['HOME'] = originalHome;
  else delete process.env['HOME'];
});

describe('loadHotMemory', () => {
  it('returns null when no HOT.md exists', () => {
    const result = loadHotMemory();
    expect(result).toBeNull();
  });

  it('returns content when HOT.md exists', () => {
    const hotPath = join(tmpHome, '.afk', 'state', 'memory', 'HOT.md');
    const content = '# Hot Memory\nSome important facts';
    writeFileSync(hotPath, content, 'utf-8');

    const result = loadHotMemory();
    expect(result).toBe(content);
  });

  it('returns null for empty HOT.md', () => {
    const hotPath = join(tmpHome, '.afk', 'state', 'memory', 'HOT.md');
    writeFileSync(hotPath, '', 'utf-8');

    const result = loadHotMemory();
    expect(result).toBeNull();
  });

  it('returns null for whitespace-only HOT.md', () => {
    const hotPath = join(tmpHome, '.afk', 'state', 'memory', 'HOT.md');
    writeFileSync(hotPath, '   \n\n  ', 'utf-8');

    const result = loadHotMemory();
    expect(result).toBeNull();
  });

  it('handles read errors gracefully', () => {
    const hotPath = join(tmpHome, '.afk', 'state', 'memory', 'HOT.md');
    mkdirSync(hotPath, { recursive: true }); // Make it a directory, not a file

    const result = loadHotMemory();
    expect(result).toBeNull();
  });
});

describe('injectHotMemory', () => {
  it('returns config unchanged when no HOT.md exists', () => {
    const config: AgentConfig = {
      model: 'sonnet',
      systemPrompt: 'Base prompt',
    };

    const result = injectHotMemory(config);
    expect(result).toEqual(config);
  });

  it('prepends memory block to string systemPrompt', () => {
    const hotPath = join(tmpHome, '.afk', 'state', 'memory', 'HOT.md');
    const hotContent = 'Previous session: user prefers brevity';
    writeFileSync(hotPath, hotContent, 'utf-8');

    const config: AgentConfig = {
      model: 'sonnet',
      systemPrompt: 'Base system prompt',
    };

    const result = injectHotMemory(config);
    expect(result.systemPrompt).toBe(
      `<cross-session-memory>\n${hotContent}\n</cross-session-memory>\n\nBase system prompt`,
    );
  });

  it('appends to append field when systemPrompt is preset', () => {
    const hotPath = join(tmpHome, '.afk', 'state', 'memory', 'HOT.md');
    const hotContent = 'Important context from previous session';
    writeFileSync(hotPath, hotContent, 'utf-8');

    const config: AgentConfig = {
      model: 'sonnet',
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: 'Extra instructions',
      },
    };

    const result = injectHotMemory(config);
    expect(result.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: `<cross-session-memory>\n${hotContent}\n</cross-session-memory>\n\nExtra instructions`,
    });
  });

  it('appends to append field when no append exists', () => {
    const hotPath = join(tmpHome, '.afk', 'state', 'memory', 'HOT.md');
    const hotContent = 'Context data';
    writeFileSync(hotPath, hotContent, 'utf-8');

    const config: AgentConfig = {
      model: 'sonnet',
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
      },
    };

    const result = injectHotMemory(config);
    expect(result.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: `<cross-session-memory>\n${hotContent}\n</cross-session-memory>\n\n`,
    });
  });

  it('sets systemPrompt when undefined', () => {
    const hotPath = join(tmpHome, '.afk', 'state', 'memory', 'HOT.md');
    const hotContent = 'Memory block content';
    writeFileSync(hotPath, hotContent, 'utf-8');

    const config: AgentConfig = {
      model: 'sonnet',
    };

    const result = injectHotMemory(config);
    expect(result.systemPrompt).toBe(
      `<cross-session-memory>\n${hotContent}\n</cross-session-memory>`,
    );
  });

  it('does not mutate the original config', () => {
    const hotPath = join(tmpHome, '.afk', 'state', 'memory', 'HOT.md');
    writeFileSync(hotPath, 'Hot content', 'utf-8');

    const config: AgentConfig = {
      model: 'sonnet',
      systemPrompt: 'Original',
    };
    const configBefore = JSON.stringify(config);

    injectHotMemory(config);
    const configAfter = JSON.stringify(config);

    expect(configBefore).toBe(configAfter);
  });

  it('preserves all other config fields', () => {
    const hotPath = join(tmpHome, '.afk', 'state', 'memory', 'HOT.md');
    writeFileSync(hotPath, 'Memory', 'utf-8');

    const config: AgentConfig = {
      model: 'opus',
      apiKey: 'sk-test',
      maxTurns: 100,
      systemPrompt: 'Base',
      timeoutMs: 5000,
    };

    const result = injectHotMemory(config);
    expect(result.model).toBe('opus');
    expect(result.apiKey).toBe('sk-test');
    expect(result.maxTurns).toBe(100);
    expect(result.timeoutMs).toBe(5000);
  });
});
