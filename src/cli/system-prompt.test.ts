/**
 * Unit tests for loadSystemPrompt() — specifically the AFK_FRAMEWORK_PROMPT_FILE
 * override path that allows A/B testing of framework prompt changes via whatif.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Env setup: set/restore AFK_FRAMEWORK_PROMPT_FILE around each test
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'afk-sysprompt-test-'));
  // Clear env var before each test
  delete process.env['AFK_FRAMEWORK_PROMPT_FILE'];
});

afterEach(async () => {
  delete process.env['AFK_FRAMEWORK_PROMPT_FILE'];
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('loadSystemPrompt() — AFK_FRAMEWORK_PROMPT_FILE override', () => {
  it('returns the content of the override file when set to a readable path', async () => {
    const overridePath = join(tmpDir, 'custom-prompt.md');
    await writeFile(overridePath, 'Custom framework prompt content.', 'utf-8');
    process.env['AFK_FRAMEWORK_PROMPT_FILE'] = overridePath;

    // This dynamic import returns the cached module, not a fresh one. The new
    // value is still seen because loadSystemPrompt() reads the env getter
    // lazily on every call.
    const { loadSystemPrompt } = await import('./system-prompt.js');
    const result = loadSystemPrompt();
    expect(result).toBe('Custom framework prompt content.');
  });

  it('throws, naming the path, when the override path is unreadable', async () => {
    process.env['AFK_FRAMEWORK_PROMPT_FILE'] = join(tmpDir, 'nonexistent.md');
    const { loadSystemPrompt } = await import('./system-prompt.js');
    expect(() => loadSystemPrompt()).toThrow(/AFK_FRAMEWORK_PROMPT_FILE=".*nonexistent\.md" is unreadable/);
  });

  it('returns the bundled prompt when AFK_FRAMEWORK_PROMPT_FILE is unset', async () => {
    const { loadSystemPrompt, loadBundledSystemPrompt } = await import('./system-prompt.js');
    const bundled = loadBundledSystemPrompt();
    expect(bundled).toContain('Run the loop');
    expect(loadSystemPrompt()).toBe(bundled);
  });

  it('treats a whitespace-only AFK_FRAMEWORK_PROMPT_FILE as unset', async () => {
    process.env['AFK_FRAMEWORK_PROMPT_FILE'] = '   ';
    const { loadSystemPrompt, loadBundledSystemPrompt } = await import('./system-prompt.js');
    expect(loadSystemPrompt()).toBe(loadBundledSystemPrompt());
  });

  it('throws when AFK_FRAMEWORK_PROMPT_FILE is a relative path (not absolute)', async () => {
    process.env['AFK_FRAMEWORK_PROMPT_FILE'] = 'relative/path/prompt.md';
    const { loadSystemPrompt } = await import('./system-prompt.js');
    expect(() => loadSystemPrompt()).toThrow(
      /AFK_FRAMEWORK_PROMPT_FILE="relative\/path\/prompt\.md" must be an absolute path/,
    );
  });
});
