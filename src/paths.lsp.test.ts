/**
 * Path-safety of the LSP install path helpers (#4293 review S-2).
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { getLspInstalledBinPath, getLspLanguageInstallDir } from './paths.lsp.js';

describe('getLspInstalledBinPath', () => {
  it('builds a path under the language install dir for a safe bin name', () => {
    const p = getLspInstalledBinPath('typescript', 'typescript-language-server');
    expect(p.startsWith(getLspLanguageInstallDir('typescript') + path.sep)).toBe(true);
    expect(path.basename(p)).toMatch(/^typescript-language-server(\.cmd)?$/);
  });

  it.each(['../evil', '..', 'a/b', 'a\\b', '', '.hidden', '-flag', 'x..y', 'bin name'])(
    'rejects unsafe binName %j',
    (bin) => {
      expect(() => getLspInstalledBinPath('typescript', bin)).toThrow(/Invalid LSP binary name/);
    },
  );

  it('still rejects an unsafe language key', () => {
    expect(() => getLspInstalledBinPath('../x', 'ok')).toThrow(/Invalid LSP language key/);
  });
});
