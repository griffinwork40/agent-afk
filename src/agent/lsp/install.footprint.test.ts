import { mkdtemp, mkdir, writeFile, symlink, lstat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { getLspInstallFootprint } from './install.footprint.js';

it('counts link metadata without following cycles or external directory targets', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'afk-footprint-'));
  try {
    const servers = path.join(root, 'servers');
    const language = path.join(servers, 'typescript');
    const external = path.join(root, 'external');
    await mkdir(language, { recursive: true });
    await mkdir(external);
    await writeFile(path.join(language, 'server.js'), 'abc');
    await writeFile(path.join(external, 'large'), 'x'.repeat(10000));
    const cycle = path.join(language, 'cycle');
    const outside = path.join(language, 'outside');
    await symlink(language, cycle, 'junction');
    await symlink(external, outside, 'junction');
    await symlink(external, path.join(servers, 'linked-language'), 'junction');
    const bytes = 3 + (await lstat(cycle)).size + (await lstat(outside)).size;
    expect(await getLspInstallFootprint(servers)).toEqual([
      { language: 'linked-language', bytes: 0 },
      { language: 'typescript', bytes },
    ]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
