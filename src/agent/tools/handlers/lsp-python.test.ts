/** Exercise registry definitions all the way through initialize/didOpen on a real child. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { writeFakeLspServer, readFakeLog } from '../../lsp/__test-utils__/fake-lsp-server.js';
import { getLspPool } from '../../lsp/pool.js';
import { queryLspSymbol } from './lsp-symbols.js';
import { queryLspDiagnostics } from './lsp-diagnostics.js';

const dirs: string[] = [];
afterEach(async () => {
  await getLspPool().disposeAll();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it('Python symbols and diagnostics share nearest-marker pool root and python didOpen', async () => {
  const dir = (realpathSync.native ?? realpathSync)(mkdtempSync(path.join(os.tmpdir(), 'afk-lsp-python-')));
  dirs.push(dir);
  const project = path.join(dir, 'package');
  mkdirSync(path.join(project, 'src'), { recursive: true });
  writeFileSync(path.join(project, 'pyproject.toml'), '');
  const source = path.join(project, 'src', 'app.py');
  writeFileSync(source, 'x = 1\n');
  const script = path.join(dir, 'server.cjs');
  const logFile = path.join(dir, 'server.jsonl');
  writeFakeLspServer(script, { logFile, diagnostics: [{ message: 'python diagnostic', severity: 2 }],
    locations: [{ uri: pathToFileURL(source).href, range: { start: { line: 0, character: 0 } } }],
  });
  const cmd = [process.execPath, script];
  expect((await queryLspSymbol(source, 'definition', 1, 1, dir, cmd)).locations).toHaveLength(1);
  expect(await queryLspDiagnostics(source, cmd, dir)).toMatchObject([{ message: 'python diagnostic', severity: 2 }]);
  const rows = readFakeLog(logFile);
  expect(rows.filter(row => row.spawn)).toHaveLength(1);
  const messages = rows.flatMap(row => row.msg ? [row.msg] : []);
  expect(messages.find(msg => msg.method === 'initialize')?.params).toMatchObject({ rootUri: pathToFileURL(project).href });
  expect(messages.find(msg => msg.method === 'textDocument/didOpen')?.params).toMatchObject({
    textDocument: { languageId: 'python', uri: pathToFileURL(source).href },
  });
});
