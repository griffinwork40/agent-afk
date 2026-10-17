import { describe, it, expect } from 'vitest';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadHosts } from './hosts.js';

describe('loadHosts — permissionMode validation', () => {
  let dir: string;

  async function writeHosts(content: object): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), 'afk-hosts-test-'));
    const p = join(dir, 'hosts.json');
    await writeFile(p, JSON.stringify(content));
    return p;
  }

  it('accepts a valid permissionMode', async () => {
    const p = await writeHosts({ myhost: { ssh: 'user@host', permissionMode: 'default' } });
    const hosts = await loadHosts(p);
    expect(hosts['myhost']!.permissionMode).toBe('default');
    await rm(dir, { recursive: true });
  });

  it('accepts autonomous as a valid permissionMode', async () => {
    const p = await writeHosts({ myhost: { ssh: 'user@host', permissionMode: 'autonomous' } });
    const hosts = await loadHosts(p);
    expect(hosts['myhost']!.permissionMode).toBe('autonomous');
    await rm(dir, { recursive: true });
  });

  it('throws on an invalid permissionMode naming the value and valid set', async () => {
    const p = await writeHosts({ myhost: { ssh: 'user@host', permissionMode: 'yolo' } });
    await expect(loadHosts(p)).rejects.toThrow(/invalid permissionMode "yolo"/);
    await expect(loadHosts(p)).rejects.toThrow(/Valid modes:/);
    await rm(dir, { recursive: true });
  });

  it('allows omitting permissionMode entirely', async () => {
    const p = await writeHosts({ myhost: { ssh: 'user@host' } });
    const hosts = await loadHosts(p);
    expect(hosts['myhost']!.permissionMode).toBeUndefined();
    await rm(dir, { recursive: true });
  });
});
