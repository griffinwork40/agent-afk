import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadHosts } from './hosts.js';

describe('loadHosts — permissionMode validation', () => {
  let dir: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  async function writeHosts(content: object): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), 'afk-hosts-test-'));
    const p = join(dir, 'hosts.json');
    await writeFile(p, JSON.stringify(content));
    return p;
  }

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    warnSpy.mockRestore();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('accepts a valid permissionMode', async () => {
    const p = await writeHosts({ myhost: { ssh: 'user@host', permissionMode: 'bypassPermissions' } });
    const hosts = await loadHosts(p);
    expect(hosts['myhost']!.permissionMode).toBe('bypassPermissions');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('accepts plan as a valid permissionMode', async () => {
    const p = await writeHosts({ myhost: { ssh: 'user@host', permissionMode: 'plan' } });
    const hosts = await loadHosts(p);
    expect(hosts['myhost']!.permissionMode).toBe('plan');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('drops unknown permissionMode with a warning naming the value and valid modes', async () => {
    const p = await writeHosts({ myhost: { ssh: 'user@host', permissionMode: 'yolo' } });
    const hosts = await loadHosts(p);
    expect(hosts['myhost']!.permissionMode).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]![0]).toContain('"yolo"');
    expect(warnSpy.mock.calls[0]![0]).toContain('Valid modes:');
  });

  it('drops a valid-SDK-but-not-config permissionMode with a "not accepted in hosts.json" warning', async () => {
    const p = await writeHosts({ myhost: { ssh: 'user@host', permissionMode: 'acceptEdits' } });
    const hosts = await loadHosts(p);
    expect(hosts['myhost']!.permissionMode).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]![0]).toContain('"acceptEdits"');
    expect(warnSpy.mock.calls[0]![0]).toContain('not accepted in hosts.json');
    expect(warnSpy.mock.calls[0]![0]).toContain('Valid modes: plan, bypassPermissions');
  });

  it('drops removed permissionMode "autonomous" with a removal warning', async () => {
    const p = await writeHosts({ myhost: { ssh: 'user@host', permissionMode: 'autonomous' } });
    const hosts = await loadHosts(p);
    expect(hosts['myhost']!.permissionMode).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]![0]).toContain('"autonomous"');
    expect(warnSpy.mock.calls[0]![0]).toContain('was removed');
  });

  it('drops removed permissionMode "default" with a removal warning', async () => {
    const p = await writeHosts({ myhost: { ssh: 'user@host', permissionMode: 'default' } });
    const hosts = await loadHosts(p);
    expect(hosts['myhost']!.permissionMode).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]![0]).toContain('"default"');
    expect(warnSpy.mock.calls[0]![0]).toContain('was removed');
  });

  it('a stale entry does not break other hosts in the same file', async () => {
    const p = await writeHosts({
      broken: { ssh: 'user@broken', permissionMode: 'autonomous' },
      good: { ssh: 'user@good', permissionMode: 'bypassPermissions' },
    });
    const hosts = await loadHosts(p);
    expect(hosts['broken']!.permissionMode).toBeUndefined();
    expect(hosts['good']!.permissionMode).toBe('bypassPermissions');
  });

  it('allows omitting permissionMode entirely', async () => {
    const p = await writeHosts({ myhost: { ssh: 'user@host' } });
    const hosts = await loadHosts(p);
    expect(hosts['myhost']!.permissionMode).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
