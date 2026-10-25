import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { validateRootPath, type RootField, type RootValidationCaller } from './root-validation.js';
import { parseAgentInput } from './input-parse.js';
import { parseComposeInput } from '../compose-input-parse.js';

const scratch = mkdtempSync(path.join(tmpdir(), 'afk-root-paths-'));
const directory = path.join(scratch, 'directory');
const file = path.join(scratch, 'file');
mkdirSync(directory);
writeFileSync(file, 'ok');
const homeLink = path.join(scratch, 'home-link');
symlinkSync(homedir(), homeLink, 'junction');
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const callers: RootValidationCaller[] = [{ kind: 'agent' }, { kind: 'compose', nodeId: 'A' }];
const fields: RootField[] = ['cwd', 'readRoots', 'writeRoots'];

describe('validateRootPath shared entry contract', () => {
  for (const caller of callers) {
    for (const field of fields) {
      describe(`${caller.kind} ${field}`, () => {
        it('accepts files, directories, missing paths, and preserves spelling', () => {
          for (const value of [file, directory, path.join(scratch, 'missing', 'child'), `${directory}${path.sep}.`]) {
            expect(validateRootPath(value, field, caller)).toBe(value);
          }
        });
        it('rejects relative paths, parent segments, filesystem root, home and home symlinks', () => {
          for (const value of ['relative/path', `${scratch}/../escape`, `${scratch}\\..\\escape`, path.parse(scratch).root, homedir(), path.dirname(homedir()), homeLink]) {
            expect(() => validateRootPath(value, field, caller)).toThrow();
          }
        });
        it('retains the absolute-before-parent-segments precedence', () => {
          const message = caller.kind === 'agent'
            ? `Agent tool ${field}${field === 'cwd' ? ' must be an absolute path' : ' entries must be absolute paths'}, got: "../relative"`
            : `Node "A" ${field}${field === 'cwd' ? '' : ' entry'} must be an absolute path (got "../relative")`;
          expect(() => validateRootPath('../relative', field, caller)).toThrow(message);
        });
        it('does not silently trim supplied paths', () => {
          const padded = `${directory} `;
          expect(validateRootPath(padded, field, caller)).toBe(padded);
        });
      });
    }
  }

  it('keeps blank and null normalization caller-owned', () => {
    for (const field of fields) {
      for (const value of ['', '  ', null, undefined]) {
        expect(parseAgentInput({ prompt: 'p', [field]: value })[field]).toBeUndefined();
        if (value === undefined) continue;
        expect(() => parseComposeInput({ nodes: [{ id: 'A', prompt: 'p', [field]: value }] })).toThrow();
      }
    }
  });

  it('preserves distinct whitespace entry errors and does not skip sparse entries', () => {
    for (const field of ['readRoots', 'writeRoots'] as const) {
      expect(() => validateRootPath('  ', field, { kind: 'agent' }))
        .toThrow(`Agent tool ${field} entries must be absolute paths, got: "  "`);
      expect(() => validateRootPath('  ', field, { kind: 'compose', nodeId: 'A' }))
        .toThrow(`Node "A" ${field} entries must be non-empty strings`);
      for (const value of ['', null, 2, undefined]) {
        expect(() => validateRootPath(value, field, { kind: 'agent' }))
          .toThrow(`Agent tool ${field} entries must be non-empty strings, got: ${JSON.stringify(value)}`);
      }
      expect(() => parseAgentInput({ prompt: 'p', [field]: Array(1) })).toThrow('non-empty strings');
      expect(() => parseComposeInput({ nodes: [{ id: 'A', prompt: 'p', [field]: Array(1) }] })).toThrow('non-empty strings');
    }
  });

  it('keeps cwd free of the read-denylist check, but protects array entries', () => {
    // Below (not at/above) the bash credential root, so only the denylist rejects it.
    const secretFile = path.join(homedir(), '.ssh', 'afk4042-private-key');
    for (const caller of callers) {
      expect(validateRootPath(secretFile, 'cwd', caller)).toBe(secretFile);
      for (const field of ['readRoots', 'writeRoots'] as const) {
        expect(() => validateRootPath(secretFile, field, caller)).toThrow('protected/credential path');
      }
    }
  });

  it('retains agent denylist-before-sensitive and compose sensitive-before-denylist', () => {
    const credentialRoot = path.join(homedir(), '.ssh');
    for (const field of ['readRoots', 'writeRoots'] as const) {
      expect(() => validateRootPath(credentialRoot, field, { kind: 'agent' })).toThrow('protected/credential path');
      expect(() => validateRootPath(credentialRoot, field, { kind: 'compose', nodeId: 'A' })).toThrow('would un-gate credential root');
    }
  });
});
