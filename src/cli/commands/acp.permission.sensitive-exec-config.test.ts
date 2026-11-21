/**
 * Project files that other tools execute later, outside AFK (profile section 6,
 * sensitive targets): `.envrc`, and any `.husky`, `.vscode`, `.github` or
 * `.devcontainer` segment. Each is `(project config that runs commands)`, with
 * the same case folding and win32 handling as the existing entries, and is never
 * covered by a remembered grant.
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { grantFits } from './acp.permission.grants.js';
import { CONFIG_MARKER, sensitiveMarker } from './acp.permission.sensitive.js';

const cwd = path.posix.resolve('/work/repo');
const wcwd = 'C:\\work\\repo';

const CASES: Array<[string, string[], string[]]> = [
  // [entry, posix variants (plain, mixed case, nested), win32 variants (incl. 8.3 short name)]
  ['.envrc', ['.envrc', '.EnvRC', 'pkg/app/.envrc'], ['.ENVRC. ', 'pkg\\.envrc:stream', 'ENVRC~1']],
  ['.husky', ['.husky/pre-commit', '.Husky/_/husky.sh', 'pkg/.husky/pre-push'], ['.HUSKY.\\pre-commit', 'HUSKY~1\\pre-commit']],
  ['.vscode', ['.vscode/tasks.json', '.VSCode/settings.json', 'apps/web/.vscode/launch.json'], ['.vscode \\tasks.json', 'VSCODE~1\\tasks.json']],
  ['.github', ['.github/workflows/ci.yml', '.GitHub/Workflows/x.yml', 'pkg/.github/actions/a/action.yml'],
    ['.github\\workflows\\ci.yml', 'GITHUB~1\\workflows\\ci.yml']],
  ['.devcontainer', ['.devcontainer/devcontainer.json', '.DevContainer/Dockerfile', 'svc/.devcontainer/devcontainer.json'],
    ['.devcontainer.\\devcontainer.json', 'DEVCON~1\\devcontainer.json']],
];

describe('sensitive: project config other tools execute (A2)', () => {
  for (const [entry, posix, win] of CASES) {
    it(`${entry}: plain, mixed case and nested are project config that runs commands`, () => {
      for (const p of posix) {
        expect(sensitiveMarker(p, cwd, path.posix), p).toBe(CONFIG_MARKER);
        expect(sensitiveMarker(p, cwd, path.win32), `win32 ${p}`).toBe(CONFIG_MARKER);
        expect(grantFits('write_file', { file_path: p, content: 'x' }, cwd, undefined, path.posix), p).toBe(false);
      }
      for (const p of win) {
        expect(sensitiveMarker(p, wcwd, path.win32), p).toBe(CONFIG_MARKER);
        expect(grantFits('write_file', { file_path: p, content: 'x' }, wcwd, undefined, path.win32), p).toBe(false);
      }
    });
  }

  it('the 8.3 short names count only under the win32 flavour, and look-alikes are ordinary', () => {
    expect(sensitiveMarker('GITHUB~1/workflows/ci.yml', cwd, path.posix)).toBe('');
    for (const p of ['envrc', 'docs/envrc.md', '.envrc.example', 'husky/x', 'src/vscode/a.ts', 'github/ci.yml', '.devcontainers/x']) {
      expect(sensitiveMarker(p, cwd, path.posix), p).toBe('');
    }
    expect(grantFits('write_file', { file_path: 'docs/github.md', content: 'x' }, cwd, undefined, path.posix)).toBe(true);
  });

  it('patch_apply with one such change is not grant-covered', () => {
    expect(grantFits('patch_apply', { changes: [{ path: 'ok.txt' }, { path: '.github/workflows/ci.yml' }] }, cwd, undefined, path.posix))
      .toBe(false);
  });
});
