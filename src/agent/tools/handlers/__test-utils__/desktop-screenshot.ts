import { mkdir } from 'node:fs/promises';
import { ensurePrivateScreenshotDirectory } from '../../../../desktop/private-directory.js';

// Unit tests exercise real POSIX modes, but Windows ACLs belong to the integration suite.
export const hardenScreenshotDirectoryForTest: typeof ensurePrivateScreenshotDirectory =
  process.platform === 'win32'
    ? async (dir) => { await mkdir(dir, { recursive: true }); }
    : ensurePrivateScreenshotDirectory;
