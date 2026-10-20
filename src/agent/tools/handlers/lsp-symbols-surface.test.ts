/**
 * Surface-layer validation tests for `createCodeSymbolsHandler` (finding 3).
 *
 * Verifies that invalid subcommand, line, and col values return isError
 * instead of silently defaulting.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createCodeSymbolsHandler } from '../lsp-symbols-surface.js';

describe('createCodeSymbolsHandler validation', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('returns undefined when feature is disabled', () => {
    vi.stubEnv('AFK_LSP_DIAGNOSTICS', '');
    expect(createCodeSymbolsHandler()).toBeUndefined();
  });

  it('rejects invalid subcommand with isError', async () => {
    vi.stubEnv('AFK_LSP_DIAGNOSTICS', '1');
    const handler = createCodeSymbolsHandler()!;
    const result = await handler(
      { file_path: '/any/file.ts', subcommand: 'bogus', line: 1, col: 1 },
      new AbortController().signal,
      undefined,
    );
    expect(result).toMatchObject({ isError: true });
    expect((result as { content: string }).content).toContain("invalid subcommand 'bogus'");
  });

  it('rejects non-numeric line with isError', async () => {
    vi.stubEnv('AFK_LSP_DIAGNOSTICS', '1');
    const handler = createCodeSymbolsHandler()!;
    const result = await handler(
      { file_path: '/any/file.ts', subcommand: 'definition', line: 'abc', col: 1 },
      new AbortController().signal,
      undefined,
    );
    expect(result).toMatchObject({ isError: true });
    expect((result as { content: string }).content).toContain('invalid line');
  });

  it('rejects non-numeric col with isError', async () => {
    vi.stubEnv('AFK_LSP_DIAGNOSTICS', '1');
    const handler = createCodeSymbolsHandler()!;
    const result = await handler(
      { file_path: '/any/file.ts', subcommand: 'definition', line: 1, col: -5 },
      new AbortController().signal,
      undefined,
    );
    expect(result).toMatchObject({ isError: true });
    expect((result as { content: string }).content).toContain('invalid col');
  });

  it('rejects missing file_path with isError', async () => {
    vi.stubEnv('AFK_LSP_DIAGNOSTICS', '1');
    const handler = createCodeSymbolsHandler()!;
    const result = await handler(
      { subcommand: 'definition', line: 1, col: 1 },
      new AbortController().signal,
      undefined,
    );
    expect(result).toMatchObject({ isError: true });
    expect((result as { content: string }).content).toContain('file_path is required');
  });
});
