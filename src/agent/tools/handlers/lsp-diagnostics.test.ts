/**
 * Tests for the post-edit LSP diagnostics helper (phase 1 of #3904).
 *
 * All tests use a fake LSP server written as a tiny Node script so no real
 * typescript-language-server is required on the test machine.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { writeFile, mkdir, rm } from 'fs/promises';
import { writeFileSync } from 'node:fs';
import os from 'os';
import path from 'path';
import { randomBytes } from 'crypto';
import {
  queryLspDiagnostics,
  formatDiagnostics,
  appendLspDiagnostics,
  isLspDiagnosticsEnabled,
  type LspDiagnostic,
} from './lsp-diagnostics.js';

// ── scratch dir ────────────────────────────────────────────────────────────

const tempDir = path.join(
  os.tmpdir(),
  `afk-lsp-diag-test-${process.pid}-${randomBytes(4).toString('hex')}`,
);

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ── fake LSP server scripts ────────────────────────────────────────────────

/**
 * Write a tiny Node script that acts as a fake LSP server.
 * It reads stdin, waits for a textDocument/didOpen, then emits a
 * publishDiagnostics notification for the opened URI with `diags`.
 */
function writeFakeServer(scriptPath: string, diags: unknown[]): void {
  const diagsJson = JSON.stringify(diags);
  const script = `
const chunks = [];
process.stdin.on('data', (chunk) => {
  chunks.push(chunk);
  const buf = Buffer.concat(chunks);
  const str = buf.toString('utf8');
  // Wait until we see didOpen
  if (!str.includes('textDocument/didOpen')) return;

  // Parse the URI from the buffer
  const m = str.match(/"uri"\\s*:\\s*"([^"]+)"/);
  const uri = m ? m[1] : 'file:///unknown';

  const diags = ${diagsJson};
  const body = JSON.stringify({
    jsonrpc: '2.0',
    method: 'textDocument/publishDiagnostics',
    params: { uri, diagnostics: diags },
  });
  const msg = 'Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body;
  process.stdout.write(msg);
  // Keep stdin open briefly so the parent can send shutdown/exit
  setTimeout(() => process.exit(0), 200);
});
process.stdin.resume();
`;
  writeFileSync(scriptPath, script, 'utf8');
}

/**
 * Write a fake server that never responds (simulates a slow/absent server).
 */
function writeSilentServer(scriptPath: string): void {
  writeFileSync(scriptPath, `process.stdin.resume();\n`, 'utf8');
}

/**
 * Write a fake server that exits immediately (simulates server crash).
 */
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

/** Build the server command: node <script>. */
function nodeCmd(scriptPath: string): readonly string[] {
  return [process.execPath, scriptPath];
}

// ── isLspDiagnosticsEnabled ───────────────────────────────────────────────

describe('isLspDiagnosticsEnabled', () => {
  const orig = process.env['AFK_LSP_DIAGNOSTICS'];

  afterEach(() => {
    if (orig === undefined) delete process.env['AFK_LSP_DIAGNOSTICS'];
    else process.env['AFK_LSP_DIAGNOSTICS'] = orig;
  });

  it('returns false when unset', () => {
    delete process.env['AFK_LSP_DIAGNOSTICS'];
    expect(isLspDiagnosticsEnabled()).toBe(false);
  });

  it('returns true for "1"', () => {
    process.env['AFK_LSP_DIAGNOSTICS'] = '1';
    expect(isLspDiagnosticsEnabled()).toBe(true);
  });

  it('returns true for "true"', () => {
    process.env['AFK_LSP_DIAGNOSTICS'] = 'true';
    expect(isLspDiagnosticsEnabled()).toBe(true);
  });

  it('returns false for "0"', () => {
    process.env['AFK_LSP_DIAGNOSTICS'] = '0';
    expect(isLspDiagnosticsEnabled()).toBe(false);
  });
});

// ── formatDiagnostics ─────────────────────────────────────────────────────

describe('formatDiagnostics', () => {
  it('returns empty string for no diagnostics', () => {
    expect(formatDiagnostics('/f.ts', [])).toBe('');
  });

  it('formats a single error', () => {
    const diags: LspDiagnostic[] = [
      { severity: 1, message: "Type 'string' is not assignable to type 'number'.", line: 3, col: 7 },
    ];
    const out = formatDiagnostics('/f.ts', diags);
    expect(out).toContain('[LSP] 1 diagnostic(s) in /f.ts');
    expect(out).toContain('error L3:7');
    expect(out).toContain("Type 'string' is not assignable to type 'number'.");
  });

  it('formats multiple diagnostics', () => {
    const diags: LspDiagnostic[] = [
      { severity: 1, message: 'err1', line: 1, col: 1 },
      { severity: 2, message: 'warn1', line: 5, col: 3 },
    ];
    const out = formatDiagnostics('/f.ts', diags);
    expect(out).toContain('[LSP] 2 diagnostic(s)');
    expect(out).toContain('error L1:1');
    expect(out).toContain('warning L5:3');
  });

  it('labels severity 3 as info and 4 as hint', () => {
    const diags: LspDiagnostic[] = [
      { severity: 3, message: 'info msg', line: 1, col: 1 },
      { severity: 4, message: 'hint msg', line: 2, col: 1 },
    ];
    const out = formatDiagnostics('/f.ts', diags);
    expect(out).toContain('info L1:1');
    expect(out).toContain('hint L2:1');
  });
});

// ── queryLspDiagnostics ───────────────────────────────────────────────────

describe('queryLspDiagnostics', () => {
  beforeEach(async () => {
    await mkdir(tempDir, { recursive: true });
  });

  it('returns diagnostics from a fake server', async () => {
    const filePath = await makeTsFile('query-test.ts');
    const scriptPath = path.join(tempDir, 'fake-server.js');
    writeFakeServer(scriptPath, [
      {
        severity: 1,
        message: "Type 'string' is not assignable to type 'number'.",
        range: { start: { line: 2, character: 6 } },
      },
    ]);

    const diags = await queryLspDiagnostics(filePath, nodeCmd(scriptPath));
    expect(diags).toHaveLength(1);
    const d0 = diags[0]!;
    expect(d0.severity).toBe(1);
    expect(d0.message).toContain("Type 'string'");
    expect(d0.line).toBe(3); // 0-based → 1-based
    expect(d0.col).toBe(7);
  }, 10_000);

  it('returns empty array when server emits no diagnostics', async () => {
    const filePath = await makeTsFile('clean.ts');
    const scriptPath = path.join(tempDir, 'fake-clean-server.js');
    writeFakeServer(scriptPath, []);

    const diags = await queryLspDiagnostics(filePath, nodeCmd(scriptPath));
    expect(diags).toEqual([]);
  }, 10_000);

  it('returns empty array when server never responds (timeout)', async () => {
    const origTimeout = process.env['AFK_LSP_DIAGNOSTICS_TIMEOUT_MS'];
    process.env['AFK_LSP_DIAGNOSTICS_TIMEOUT_MS'] = '300'; // fast timeout for test
    try {
      const filePath = await makeTsFile('slow.ts');
      const scriptPath = path.join(tempDir, 'fake-silent-server.js');
      writeSilentServer(scriptPath);

      const diags = await queryLspDiagnostics(filePath, nodeCmd(scriptPath));
      expect(diags).toEqual([]);
    } finally {
      if (origTimeout === undefined) delete process.env['AFK_LSP_DIAGNOSTICS_TIMEOUT_MS'];
      else process.env['AFK_LSP_DIAGNOSTICS_TIMEOUT_MS'] = origTimeout;
    }
  }, 5_000);

  it('kills the child process on timeout', async () => {
    const origTimeout = process.env['AFK_LSP_DIAGNOSTICS_TIMEOUT_MS'];
    process.env['AFK_LSP_DIAGNOSTICS_TIMEOUT_MS'] = '300';
    try {
      const filePath = await makeTsFile('kill-test.ts');
      const scriptPath = path.join(tempDir, 'fake-pid-server.js');
      // Server that writes its PID to a file then hangs
      const pidFile = path.join(tempDir, 'server.pid');
      writeFileSync(
        scriptPath,
        `require('fs').writeFileSync(${JSON.stringify(pidFile)}, '' + process.pid);\nprocess.stdin.resume();\n`,
        'utf8',
      );

      await queryLspDiagnostics(filePath, nodeCmd(scriptPath));

      // Invariant: Windows process reaping is slower on CI — TerminateProcess
      // is async and the PID may linger for several hundred ms.  Poll with
      // back-off instead of a fixed sleep so the test is reliable on both
      // fast dev machines and slow CI runners.
      const pid = parseInt(await import('fs').then(fs => fs.promises.readFile(pidFile, 'utf8')), 10);
      const deadline = Date.now() + 3_000;
      let alive = true;
      while (alive && Date.now() < deadline) {
        try { process.kill(pid, 0); } catch { alive = false; break; }
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(alive).toBe(false);
    } finally {
      if (origTimeout === undefined) delete process.env['AFK_LSP_DIAGNOSTICS_TIMEOUT_MS'];
      else process.env['AFK_LSP_DIAGNOSTICS_TIMEOUT_MS'] = origTimeout;
    }
  }, 5_000);

  it('returns empty array when server crashes immediately', async () => {
    const filePath = await makeTsFile('crash.ts');
    const scriptPath = path.join(tempDir, 'fake-crash-server.js');
    writeCrashServer(scriptPath);

    const diags = await queryLspDiagnostics(filePath, nodeCmd(scriptPath));
    expect(diags).toEqual([]);
  }, 10_000);

  it('returns empty array when binary does not exist', async () => {
    const filePath = await makeTsFile('nobin.ts');
    const diags = await queryLspDiagnostics(filePath, [
      '/nonexistent-binary-that-does-not-exist-afk-test',
    ]);
    expect(diags).toEqual([]);
  }, 10_000);

  it('returns empty array when file does not exist', async () => {
    const scriptPath = path.join(tempDir, 'fake-server2.js');
    writeFakeServer(scriptPath, []);
    const diags = await queryLspDiagnostics(
      path.join(tempDir, 'no-such-file.ts'),
      nodeCmd(scriptPath),
    );
    expect(diags).toEqual([]);
  }, 10_000);
});

// ── appendLspDiagnostics ──────────────────────────────────────────────────

describe('appendLspDiagnostics', () => {
  const origFlag = process.env['AFK_LSP_DIAGNOSTICS'];

  afterEach(() => {
    if (origFlag === undefined) delete process.env['AFK_LSP_DIAGNOSTICS'];
    else process.env['AFK_LSP_DIAGNOSTICS'] = origFlag;
  });

  it('returns empty string when feature is disabled', async () => {
    delete process.env['AFK_LSP_DIAGNOSTICS'];
    const result = await appendLspDiagnostics('/any/file.ts');
    expect(result).toBe('');
  });

  it('returns formatted diagnostics when feature is enabled', async () => {
    process.env['AFK_LSP_DIAGNOSTICS'] = '1';
    const filePath = await makeTsFile('append-test.ts');
    const scriptPath = path.join(tempDir, 'fake-server-append.js');
    writeFakeServer(scriptPath, [
      {
        severity: 1,
        message: 'Cannot find name "foo".',
        range: { start: { line: 0, character: 0 } },
      },
    ]);

    const result = await appendLspDiagnostics(filePath, nodeCmd(scriptPath));
    expect(result).toContain('[LSP]');
    expect(result).toContain('Cannot find name');
  }, 10_000);

  it('returns empty string when feature is enabled but server is absent', async () => {
    process.env['AFK_LSP_DIAGNOSTICS'] = '1';
    process.env['AFK_LSP_DIAGNOSTICS_TIMEOUT_MS'] = '300';
    try {
      const filePath = await makeTsFile('absent-server.ts');
      const result = await appendLspDiagnostics(filePath, [
        '/nonexistent-binary-afk-lsp-test',
      ]);
      expect(result).toBe('');
    } finally {
      delete process.env['AFK_LSP_DIAGNOSTICS_TIMEOUT_MS'];
    }
  }, 5_000);
});
