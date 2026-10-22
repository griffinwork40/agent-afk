/**
 * Tests for the LSP symbol lookup helper (phase 2 of #3904).
 *
 * All tests use a fake LSP server written as a tiny Node script so no real
 * typescript-language-server is required on the test machine. Mirrors the
 * structure of lsp-diagnostics.test.ts.
 */

import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { writeFile, mkdir, rm, stat } from 'fs/promises';
import { writeFileSync } from 'node:fs';
import os from 'os';
import path from 'path';
import { randomBytes } from 'crypto';
import {
  queryLspSymbol,
  formatSymbolResult,
  handleCodeSymbols,
  isLspSymbolsEnabled,
  parseLocation,
  DEFAULT_LSP_CMD,
  type LspLocation,
} from './lsp-symbols.js';
import { createCodeSymbolsHandler } from '../lsp-symbols-surface.js';

// ── scratch dir ────────────────────────────────────────────────────────────

const tempDir = path.join(
  os.tmpdir(),
  `afk-lsp-sym-test-${process.pid}-${randomBytes(4).toString('hex')}`,
);

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ── fake LSP server helpers ────────────────────────────────────────────────

/**
 * Write a fake LSP server that waits for the symbol request (id===2, sent
 * after initialize=1 and initialized notification) and replies with `locs`.
 */
function writeFakeSymbolServer(scriptPath: string, locs: unknown[]): void {
  const locsJson = JSON.stringify(locs);
  const script = `
const chunks = [];
process.stdin.on('data', (chunk) => {
  chunks.push(chunk);
  const buf = Buffer.concat(chunks);
  const str = buf.toString('utf8');
  // Wait until we see the symbol request (textDocument/definition or references)
  if (!str.includes('textDocument/definition') && !str.includes('textDocument/references')) return;

  // Parse id from the LAST request (the symbol one, id=2)
  const idMatch = str.match(/"id"\\s*:\\s*(\\d+)/g);
  const lastId = idMatch ? parseInt(idMatch[idMatch.length - 1].match(/\\d+/)[0]) : 2;

  const locs = ${locsJson};
  const body = JSON.stringify({ jsonrpc: '2.0', id: lastId, result: locs });
  const msg = 'Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body;
  process.stdout.write(msg);
  setTimeout(() => process.exit(0), 200);
});
process.stdin.resume();
`;
  writeFileSync(scriptPath, script, 'utf8');
}

/** Write a fake server that returns a JSON-RPC error for the symbol request. */
function writeFakeErrorServer(scriptPath: string): void {
  const script = `
const chunks = [];
process.stdin.on('data', (chunk) => {
  chunks.push(chunk);
  const buf = Buffer.concat(chunks);
  const str = buf.toString('utf8');
  if (!str.includes('textDocument/definition') && !str.includes('textDocument/references')) return;
  const idMatch = str.match(/"id"\\s*:\\s*(\\d+)/g);
  const lastId = idMatch ? parseInt(idMatch[idMatch.length - 1].match(/\\d+/)[0]) : 2;
  const body = JSON.stringify({ jsonrpc: '2.0', id: lastId, error: { code: -32601, message: 'Method not found' } });
  const msg = 'Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body;
  process.stdout.write(msg);
  setTimeout(() => process.exit(0), 200);
});
process.stdin.resume();
`;
  writeFileSync(scriptPath, script, 'utf8');
}

/** Write a fake server that never responds (timeout simulation). */
function writeSilentServer(scriptPath: string): void {
  writeFileSync(scriptPath, `process.stdin.resume();\n`, 'utf8');
}

/** Write a fake server that exits immediately (crash simulation). */
function writeCrashServer(scriptPath: string): void {
  writeFileSync(scriptPath, `process.exit(1);\n`, 'utf8');
}

// ── helpers ────────────────────────────────────────────────────────────────

async function makeTsFile(name: string, content = 'const x: number = 1;\n'): Promise<string> {
  await mkdir(tempDir, { recursive: true });
  const p = path.join(tempDir, name);
  await writeFile(p, content, 'utf8');
  return p;
}

function nodeCmd(scriptPath: string): readonly string[] {
  return [process.execPath, scriptPath];
}

// ── isLspSymbolsEnabled ───────────────────────────────────────────────────

describe('isLspSymbolsEnabled', () => {
  const orig = process.env['AFK_LSP_DIAGNOSTICS'];
  afterEach(() => {
    if (orig === undefined) delete process.env['AFK_LSP_DIAGNOSTICS'];
    else process.env['AFK_LSP_DIAGNOSTICS'] = orig;
  });

  it('returns false when unset', () => {
    delete process.env['AFK_LSP_DIAGNOSTICS'];
    expect(isLspSymbolsEnabled()).toBe(false);
  });
  it('returns true for "1"', () => {
    process.env['AFK_LSP_DIAGNOSTICS'] = '1';
    expect(isLspSymbolsEnabled()).toBe(true);
  });
  it('returns false for "0"', () => {
    process.env['AFK_LSP_DIAGNOSTICS'] = '0';
    expect(isLspSymbolsEnabled()).toBe(false);
  });
});

// ── formatSymbolResult ────────────────────────────────────────────────────

describe('formatSymbolResult', () => {
  it('formats locations for definition', () => {
    const locs: LspLocation[] = [{ filePath: '/src/bar.ts', line: 12, col: 1 }];
    const out = formatSymbolResult('/src/foo.ts', 'definition', 5, 3, { locations: locs });
    expect(out).toContain('[LSP] definition for symbol at /src/foo.ts:5:3');
    expect(out).toContain('/src/bar.ts:12:1');
  });

  it('formats multiple reference locations', () => {
    const locs: LspLocation[] = [
      { filePath: '/a.ts', line: 1, col: 1 },
      { filePath: '/b.ts', line: 7, col: 3 },
    ];
    const out = formatSymbolResult('/src/foo.ts', 'references', 2, 5, { locations: locs });
    expect(out).toContain('2 location(s)');
    expect(out).toContain('/a.ts:1:1');
    expect(out).toContain('/b.ts:7:3');
  });

  it('reports no-location case', () => {
    const out = formatSymbolResult('/f.ts', 'definition', 1, 1, { locations: [] });
    expect(out).toContain('no locations found');
  });

  it('reports error case', () => {
    const out = formatSymbolResult('/f.ts', 'definition', 1, 1, {
      locations: [],
      error: 'LSP server timed out',
    });
    expect(out).toContain('definition unavailable');
    expect(out).toContain('LSP server timed out');
  });
});

// ── parseLocation edge cases ──────────────────────────────────────────────

describe('parseLocation', () => {
  it('returns null for null input', () => {
    expect(parseLocation(null)).toBeNull();
  });

  it('returns null for non-object input', () => {
    expect(parseLocation('string')).toBeNull();
    expect(parseLocation(42)).toBeNull();
    expect(parseLocation(undefined)).toBeNull();
  });

  it('returns null when uri is missing', () => {
    expect(parseLocation({ range: { start: { line: 0, character: 0 } } })).toBeNull();
  });

  it('returns null when range is missing entirely', () => {
    expect(parseLocation({ uri: 'file:///tmp/x.ts' })).toBeNull();
  });

  it('returns null when range.start is missing', () => {
    expect(parseLocation({ uri: 'file:///tmp/x.ts', range: {} })).toBeNull();
  });

  it('returns null when range.start.line is missing', () => {
    expect(parseLocation({ uri: 'file:///tmp/x.ts', range: { start: { character: 0 } } })).toBeNull();
  });

  it('returns null when range.start.character is missing', () => {
    expect(parseLocation({ uri: 'file:///tmp/x.ts', range: { start: { line: 0 } } })).toBeNull();
  });

  it('returns null for a malformed URI', () => {
    expect(parseLocation({ uri: 'not-a-file-uri://bad', range: { start: { line: 0, character: 0 } } })).toBeNull();
  });

  it('converts 0-based LSP position to 1-based for a valid location', () => {
    const tempFile = path.join(os.tmpdir(), `afk-pl-test-${process.pid}.ts`);
    // Use a file we know exists so realpathSafe succeeds (os.tmpdir() itself).
    const loc = parseLocation({
      uri: `file://${os.tmpdir().replace(/\\/g, '/')}`,
      range: { start: { line: 4, character: 2 } },
    });
    // os.tmpdir() exists but is a directory — parseLocation only cares that
    // realpathSafe resolves it and decidePathAccess allows it.
    expect(loc).not.toBeNull();
    expect(loc!.line).toBe(5);
    expect(loc!.col).toBe(3);
    void tempFile; // suppress unused warning
  });

  it('prefers targetUri/targetRange (LocationLink) over uri/range', () => {
    const loc = parseLocation({
      uri: 'file:///should-not-use.ts',
      range: { start: { line: 99, character: 99 } },
      targetUri: `file://${os.tmpdir().replace(/\\/g, '/')}`,
      targetRange: { start: { line: 1, character: 0 } },
    });
    expect(loc).not.toBeNull();
    expect(loc!.line).toBe(2);
    expect(loc!.col).toBe(1);
  });
});

// ── queryLspSymbol ────────────────────────────────────────────────────────

describe('queryLspSymbol', () => {
  it('returns locations from a fake server (definition)', async () => {
    await mkdir(tempDir, { recursive: true });
    const filePath = await makeTsFile('sym-def.ts');
    const scriptPath = path.join(tempDir, 'fake-def-server.js');
    const targetUri = `file://${filePath.replace(/\\/g, '/')}`;
    writeFakeSymbolServer(scriptPath, [
      { uri: targetUri, range: { start: { line: 11, character: 0 } } },
    ]);

    const result = await queryLspSymbol(filePath, 'definition', 5, 3, undefined, nodeCmd(scriptPath));
    expect(result.error).toBeUndefined();
    expect(result.locations).toHaveLength(1);
    const loc = result.locations[0]!;
    expect(loc.line).toBe(12); // 0-based → 1-based
    expect(loc.col).toBe(1);
  }, 10_000);

  it('returns multiple locations for references', async () => {
    await mkdir(tempDir, { recursive: true });
    const filePath = await makeTsFile('sym-refs.ts');
    const scriptPath = path.join(tempDir, 'fake-refs-server.js');
    const targetUri = `file://${filePath.replace(/\\/g, '/')}`;
    writeFakeSymbolServer(scriptPath, [
      { uri: targetUri, range: { start: { line: 0, character: 0 } } },
      { uri: targetUri, range: { start: { line: 4, character: 2 } } },
    ]);

    const result = await queryLspSymbol(filePath, 'references', 1, 1, undefined, nodeCmd(scriptPath));
    expect(result.error).toBeUndefined();
    expect(result.locations).toHaveLength(2);
    expect(result.locations[1]!.line).toBe(5);
    expect(result.locations[1]!.col).toBe(3);
  }, 10_000);

  it('returns empty locations and error when server returns JSON-RPC error', async () => {
    await mkdir(tempDir, { recursive: true });
    const filePath = await makeTsFile('sym-err.ts');
    const scriptPath = path.join(tempDir, 'fake-err-server.js');
    writeFakeErrorServer(scriptPath);

    const result = await queryLspSymbol(filePath, 'definition', 1, 1, undefined, nodeCmd(scriptPath));
    expect(result.locations).toEqual([]);
    expect(result.error).toBeDefined();
  }, 10_000);

  it('returns error when server never responds (timeout)', async () => {
    // queryLspSymbol now reads AFK_LSP_SYMBOLS_TIMEOUT_MS (not the diagnostics one).
    vi.stubEnv('AFK_LSP_SYMBOLS_TIMEOUT_MS', '300');
    try {
      await mkdir(tempDir, { recursive: true });
      const filePath = await makeTsFile('sym-slow.ts');
      const scriptPath = path.join(tempDir, 'fake-silent-sym-server.js');
      writeSilentServer(scriptPath);

      const result = await queryLspSymbol(filePath, 'definition', 1, 1, undefined, nodeCmd(scriptPath));
      expect(result.locations).toEqual([]);
      expect(result.error).toContain('timed out');
    } finally {
      vi.unstubAllEnvs();
    }
  }, 5_000);

  it('returns error when server crashes immediately', async () => {
    await mkdir(tempDir, { recursive: true });
    const filePath = await makeTsFile('sym-crash.ts');
    const scriptPath = path.join(tempDir, 'fake-crash-sym-server.js');
    writeCrashServer(scriptPath);

    const result = await queryLspSymbol(filePath, 'definition', 1, 1, undefined, nodeCmd(scriptPath));
    expect(result.locations).toEqual([]);
    expect(result.error).toBeDefined();
  }, 10_000);

  it('returns error when binary does not exist', async () => {
    const filePath = await makeTsFile('sym-nobin.ts');
    const result = await queryLspSymbol(filePath, 'definition', 1, 1, undefined, [
      '/nonexistent-binary-afk-lsp-sym-test',
    ]);
    expect(result.locations).toEqual([]);
    expect(result.error).toBeDefined();
  }, 10_000);

  it('returns error when file does not exist', async () => {
    await mkdir(tempDir, { recursive: true });
    const scriptPath = path.join(tempDir, 'fake-def-server2.js');
    writeFakeSymbolServer(scriptPath, []);
    const result = await queryLspSymbol(
      path.join(tempDir, 'no-such-file.ts'),
      'definition', 1, 1,
      undefined,
      nodeCmd(scriptPath),
    );
    expect(result.locations).toEqual([]);
    expect(result.error).toBeDefined();
  }, 10_000);

  it('returns error for unsupported extension', async () => {
    const result = await queryLspSymbol('/some/file.py', 'definition', 1, 1);
    expect(result.locations).toEqual([]);
    expect(result.error).toContain('Unsupported file type');
  }, 5_000);
});

// ── handleCodeSymbols ─────────────────────────────────────────────────────

describe('handleCodeSymbols', () => {
  const origFlag = process.env['AFK_LSP_DIAGNOSTICS'];
  afterEach(() => {
    if (origFlag === undefined) delete process.env['AFK_LSP_DIAGNOSTICS'];
    else process.env['AFK_LSP_DIAGNOSTICS'] = origFlag;
  });

  it('returns feature-disabled message when flag is off', async () => {
    delete process.env['AFK_LSP_DIAGNOSTICS'];
    const result = await handleCodeSymbols({
      file_path: '/any/file.ts',
      subcommand: 'definition',
      line: 1,
      col: 1,
    });
    expect(result).toContain('AFK_LSP_DIAGNOSTICS=1');
  });

  it('returns formatted locations when flag is on', async () => {
    process.env['AFK_LSP_DIAGNOSTICS'] = '1';
    await mkdir(tempDir, { recursive: true });
    const filePath = await makeTsFile('handle-test.ts');
    const scriptPath = path.join(tempDir, 'fake-handle-server.js');
    const targetUri = `file://${filePath.replace(/\\/g, '/')}`;
    writeFakeSymbolServer(scriptPath, [
      { uri: targetUri, range: { start: { line: 9, character: 4 } } },
    ]);

    const result = await handleCodeSymbols(
      { file_path: filePath, subcommand: 'definition', line: 3, col: 7 },
      undefined, undefined, nodeCmd(scriptPath),
    );
    expect(result).toContain('[LSP] definition');
    expect(result).toContain(':10:5');
  }, 10_000);

  it('returns error-formatted string when feature is on but server is absent', async () => {
    vi.stubEnv('AFK_LSP_DIAGNOSTICS', '1');
    try {
      const filePath = await makeTsFile('handle-absent.ts');
      const result = await handleCodeSymbols(
        { file_path: filePath, subcommand: 'definition', line: 1, col: 1 },
        undefined, undefined, ['/nonexistent-binary-afk-lsp-sym-test2'],
      );
      // Should return a formatted error string, not throw
      expect(typeof result).toBe('string');
      expect(result).toContain('[LSP]');
    } finally {
      vi.unstubAllEnvs();
    }
  }, 5_000);
});

// ── AbortSignal ───────────────────────────────────────────────────────────

describe('queryLspSymbol — AbortSignal', () => {
  it('returns Aborted immediately when signal is pre-aborted', async () => {
    const filePath = await makeTsFile('abort-pre.ts');
    const controller = new AbortController();
    controller.abort();

    const result = await queryLspSymbol(
      filePath, 'definition', 1, 1, undefined,
      ['/nonexistent-binary-afk-lsp-sym-test-abort'],
      controller.signal,
    );
    expect(result.locations).toEqual([]);
    expect(result.error).toBe('Aborted');
  }, 5_000);

  it('returns Aborted when signal fires mid-flight (slow server)', async () => {
    vi.stubEnv('AFK_LSP_SYMBOLS_TIMEOUT_MS', '3000');
    try {
      await mkdir(tempDir, { recursive: true });
      const filePath = await makeTsFile('abort-mid.ts');
      const sentinelPath = path.join(tempDir, 'abort-mid-spawned.flag');
      const scriptPath = path.join(tempDir, 'fake-silent-abort-server.js');

      // Fake server writes a sentinel file the moment it is spawned, then
      // parks on stdin.  The test aborts as soon as it sees the sentinel,
      // eliminating any dependency on wall-clock delays.
      writeFileSync(
        scriptPath,
        `const fs = require('fs');
fs.writeFileSync(${JSON.stringify(sentinelPath)}, '1');
process.stdin.resume();
`,
        'utf8',
      );

      const controller = new AbortController();

      // Poll for the sentinel file (written by the fake server on spawn),
      // then abort immediately — no fixed wall-clock delay needed.
      const abortOnSpawn = (async () => {
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          try {
            await stat(sentinelPath);
            controller.abort();
            return;
          } catch {
            await new Promise((r) => setTimeout(r, 10));
          }
        }
        // Safety valve: abort anyway so the test does not hang.
        controller.abort();
      })();

      const result = await queryLspSymbol(
        filePath, 'definition', 1, 1, undefined,
        nodeCmd(scriptPath),
        controller.signal,
      );
      await abortOnSpawn; // ensure the polling loop is settled
      expect(result.locations).toEqual([]);
      expect(result.error).toBe('Aborted');
    } finally {
      vi.unstubAllEnvs();
    }
  }, 5_000);
});

// ── DEFAULT_LSP_CMD ───────────────────────────────────────────────────────

describe('DEFAULT_LSP_CMD', () => {
  it('is a frozen array with typescript-language-server as the binary', () => {
    expect(Array.isArray(DEFAULT_LSP_CMD)).toBe(true);
    expect(Object.isFrozen(DEFAULT_LSP_CMD)).toBe(true);
    expect(DEFAULT_LSP_CMD[0]).toBe('typescript-language-server');
    expect(DEFAULT_LSP_CMD[1]).toBe('--stdio');
  });
});
