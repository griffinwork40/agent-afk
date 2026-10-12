import { beforeEach, describe, expect, it, vi } from 'vitest';
import { delimiter, dirname } from 'path';

const { exists, realpath } = vi.hoisted(() => ({ exists: vi.fn(), realpath: vi.fn() }));
vi.mock('fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('fs')>(),
  existsSync: exists,
  realpathSync: realpath,
}));

import { resolveServicePath } from './plist.js';

// Real normalization wiring, independent of the host's Homebrew installation.
describe('resolveServicePath Cellar normalization', () => {
  const cellar = '/opt/homebrew/Cellar/node/26.11.0/bin/node';
  const opt = '/opt/homebrew/opt/node/bin/node';

  beforeEach(() => {
    vi.resetAllMocks();
    exists.mockImplementation((p: string) => p === opt);
    realpath.mockImplementation((p: string) => p === opt ? cellar : p);
  });

  it('converts an actual Cellar input to the stable opt directory', () => {
    expect(resolveServicePath(cellar).split(delimiter)[0]).toBe(dirname(opt));
    expect(exists).toHaveBeenCalledWith(opt);
    expect(realpath).toHaveBeenCalledWith(opt);
    expect(realpath).toHaveBeenCalledWith(cellar);
  });

  it('preserves the Cellar directory if the opt link points to another binary', () => {
    realpath.mockImplementation((p: string) => p === opt ? '/different/node' : p);
    expect(resolveServicePath(cellar).split(delimiter)[0]).toBe(dirname(cellar));
  });
});
