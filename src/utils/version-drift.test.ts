import { describe, expect, it } from 'vitest';
import { join, resolve } from 'path';
import { checkVersionDrift, readDiskVersion } from './version-drift.js';

describe('shared version drift', () => {
  it.each([['unknown', '2'], ['1', 'unknown'], ['', '2'], ['1', ''], ['1', '1']])(
    'ignores unavailable or identical versions (%s, %s)', (running, disk) => {
      expect(checkVersionDrift(running, disk)).toEqual({ drift: false });
    },
  );
  it('detects any different installed version including rollback', () => {
    expect(checkVersionDrift('2', '1').drift).toBe(true);
  });
  it.each(['dist', join('src', 'utils'), join('dist', 'utils')])(
    'resolves package version for layout %s', (layout) => {
      const root = resolve('fixture-package');
      const read = (path: string) => {
        if (path !== join(root, 'package.json')) throw new Error('ENOENT');
        return JSON.stringify({ version: '5.284.0' });
      };
      expect(readDiskVersion(join(root, layout), read)).toBe('5.284.0');
    },
  );
  it.each(['not json', '{}', '{"version":42}', '{"version":""}', 'null'])(
    'returns unknown for invalid package content %s', (content) => {
      expect(readDiskVersion(resolve('fixture-package', 'dist'), () => content)).toBe('unknown');
    },
  );
  it('rereads package contents every call and tolerates missing packages', () => {
    let version = '5.283.0';
    const read = () => JSON.stringify({ version });
    expect(readDiskVersion(undefined, read)).toBe('5.283.0');
    version = '5.284.0';
    expect(readDiskVersion(undefined, read)).toBe('5.284.0');
    expect(readDiskVersion(undefined, () => { throw new Error('ENOENT'); })).toBe('unknown');
  });
});
