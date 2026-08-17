import { describe, it, expect, vi } from 'vitest';
import { checkImportAvailable, checkAnthropicKey } from './doctor-checks.js';
import type { DetectedSource } from '../../config/import-sources.js';

/** Minimal fixture for a present source with zero assets. */
function makeSource(
  overrides: Partial<DetectedSource> = {},
): DetectedSource {
  return {
    binary: 'claude-code',
    label: 'Claude Code',
    present: true,
    plugins: [],
    skills: [],
    mcpServers: [],
    mcpConfigPath: null,
    mcpFormat: 'json',
    ...overrides,
  };
}

vi.mock('../../agent/auth/credential-resolver.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../agent/auth/credential-resolver.js')>();
  return { ...orig, preloadClaudeKeychainOAuth: vi.fn().mockResolvedValue(undefined) };
});

describe('checkAnthropicKey', () => {
  it('calls preloadClaudeKeychainOAuth before checking the key', async () => {
    const { preloadClaudeKeychainOAuth } = await import(
      '../../agent/auth/credential-resolver.js'
    );
    await checkAnthropicKey();
    expect(preloadClaudeKeychainOAuth).toHaveBeenCalledWith('anthropic-direct');
  });
});

describe('checkImportAvailable', () => {
  it('returns null when detected list is empty', async () => {
    const result = await checkImportAvailable({ detected: [] });
    expect(result).toBeNull();
  });

  it('returns null when all sources are not present', async () => {
    const result = await checkImportAvailable({
      detected: [makeSource({ present: false, plugins: [{ name: 'my-plugin', path: '/p' }] })],
    });
    expect(result).toBeNull();
  });

  it('returns null when present source has no plugins or skills', async () => {
    const result = await checkImportAvailable({
      detected: [makeSource({ present: true, plugins: [], skills: [] })],
    });
    expect(result).toBeNull();
  });

  it('returns null when every present source with assets is already trusted', async () => {
    const result = await checkImportAvailable({
      detected: [
        makeSource({
          binary: 'claude-code',
          present: true,
          plugins: [{ name: 'my-plugin', path: '/p' }],
        }),
      ],
      trusted: { 'claude-code': { plugins: true, skills: true, mcp: true } },
    });
    expect(result).toBeNull();
  });

  it('returns a warn Check when an untrusted present source has plugins', async () => {
    const result = await checkImportAvailable({
      detected: [
        makeSource({
          binary: 'claude-code',
          label: 'Claude Code',
          present: true,
          plugins: [{ name: 'my-plugin', path: '/p' }],
          skills: [],
        }),
      ],
      trusted: {},
    });
    expect(result).not.toBeNull();
    expect(result?.state).toBe('warn');
    expect(result?.detail).toContain('Claude Code');
    expect(result?.fix).toContain('afk migrate');
  });

  it('returns a warn Check when an untrusted present source has skills', async () => {
    const result = await checkImportAvailable({
      detected: [
        makeSource({
          binary: 'codex',
          label: 'Codex',
          present: true,
          plugins: [],
          skills: [{ name: 'my-skill', path: '/s' }],
        }),
      ],
      trusted: {},
    });
    expect(result).not.toBeNull();
    expect(result?.state).toBe('warn');
    expect(result?.detail).toContain('Codex');
    expect(result?.fix).toContain('afk migrate');
  });

  it('reports only untrusted sources when mixed', async () => {
    const result = await checkImportAvailable({
      detected: [
        makeSource({
          binary: 'claude-code',
          label: 'Claude Code',
          present: true,
          plugins: [{ name: 'p', path: '/p' }],
        }),
        makeSource({
          binary: 'codex',
          label: 'Codex',
          present: true,
          skills: [{ name: 's', path: '/s' }],
        }),
      ],
      trusted: { 'claude-code': { plugins: true, skills: true, mcp: true } },
    });
    // Only 'codex' is untrusted
    expect(result).not.toBeNull();
    expect(result?.state).toBe('warn');
    expect(result?.detail).toContain('Codex');
    expect(result?.detail).not.toContain('Claude Code');
  });
});
