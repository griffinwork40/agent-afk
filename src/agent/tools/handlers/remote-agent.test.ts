import { describe, it, expect, vi, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRemoteAgentHandler, parseRemoteAgentInput } from './remote-agent.js';
import { loadHosts, resolveHost } from '../../../remote/hosts.js';
import { PID_MARKER } from '../../../remote/remote-script.js';
import type { SshRunner } from '../../../remote/ssh-runner.js';

function okRunner(targets: string[] = []): SshRunner {
  return {
    async exec(target) {
      targets.push(target);
      return { code: 0, stdout: `${PID_MARKER} 7\n`, stderr: '' };
    },
    async stream(_t, _s, o) {
      o.onLine(JSON.stringify({ type: 'message', message: { content: 'hello from remote' } }));
      o.onLine(JSON.stringify({ type: 'done' }));
      return { code: 0, stdout: '', stderr: '' };
    },
  };
}

afterEach(() => { vi.unstubAllEnvs(); });

describe('remote_agent handler', () => {
  it('refuses inside a remote run (AFK_REMOTE_DEPTH set)', async () => {
    vi.stubEnv('AFK_REMOTE_DEPTH', '1');
    const exec = vi.fn();
    const handler = createRemoteAgentHandler({ runner: { exec, stream: vi.fn() }, loadHosts: async () => ({}) });
    const res = await handler({ host: 'box', prompt: 'x' }, new AbortController().signal);
    expect(res.isError).toBe(true);
    expect(res.content).toContain('AFK_REMOTE_DEPTH');
    expect(exec).not.toHaveBeenCalled();
  });

  it('resolves registry hosts and returns the reply with a resume footer', async () => {
    vi.stubEnv('AFK_REMOTE_DEPTH', '');
    const targets: string[] = [];
    const handler = createRemoteAgentHandler({
      runner: okRunner(targets),
      loadHosts: async () => ({ cm: { name: 'cm', ssh: 'me@griffin-cm' } }),
    });
    const res = await handler({ host: 'cm', prompt: 'hi' }, new AbortController().signal);
    expect(res.isError).toBeUndefined();
    expect(res.content).toMatch(/^hello from remote\n\n\[remote_agent: host=cm session=[0-9a-f-]{36} run=/);
    expect(res.content).toContain('pass resume="');
    expect(targets).toEqual(['me@griffin-cm']);
  });

  it('rejects an ssh-option-shaped host', async () => {
    const handler = createRemoteAgentHandler({ runner: okRunner(), loadHosts: async () => ({}) });
    const res = await handler({ host: '-oProxyCommand=touch /tmp/x', prompt: 'x' }, new AbortController().signal);
    expect(res.isError).toBe(true);
    expect(res.content).toContain('invalid ssh target');
  });

  it('validates input', () => {
    expect(parseRemoteAgentInput({ host: 'a' })).toMatchObject({ isError: true });
    expect(parseRemoteAgentInput({ host: 'a', prompt: 'p', resume: '$(x)' })).toMatchObject({ isError: true });
    expect(parseRemoteAgentInput({ host: 'a', prompt: 'p', model: '--x' })).toMatchObject({ isError: true });
    expect(parseRemoteAgentInput({ host: ' a ', prompt: 'p', cwd: '~/r' })).toEqual({ host: 'a', prompt: 'p', cwd: '~/r' });
  });
});

describe('hosts registry', () => {
  it('loads entries, treats a missing file as empty, and falls back to a literal target', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'afk-remote-hosts-'));
    const file = path.join(dir, 'hosts.json');
    expect(await loadHosts(file)).toEqual({});
    await fs.writeFile(file, JSON.stringify({ cm: { ssh: 'me@cm', cwd: '~/p', afkPath: '/x/afk' } }));
    const hosts = await loadHosts(file);
    expect(resolveHost('cm', hosts)).toEqual({ name: 'cm', ssh: 'me@cm', cwd: '~/p', afkPath: '/x/afk' });
    expect(resolveHost('mini', hosts)).toEqual({ name: 'mini', ssh: 'mini' });
    await fs.writeFile(file, '{"bad": {}}');
    await expect(loadHosts(file)).rejects.toThrow('needs a non-empty "ssh"');
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('remote_agent keychain unlock', () => {
  it('reads the stored password for unlockKeychain hosts and never returns it', async () => {
    vi.stubEnv('AFK_REMOTE_DEPTH', '');
    const reads: string[] = [];
    let launchStdin = '';
    const r = okRunner();
    const handler = createRemoteAgentHandler({
      runner: { ...r, async exec(t, s, o) { launchStdin = o?.stdin ?? ''; return r.exec(t, s, o); } },
      loadHosts: async () => ({ cm: { name: 'cm', ssh: 'me@cm', unlockKeychain: true } }),
      readUnlockPassword: async (name) => { reads.push(name); return 'topsecret'; },
    });
    const res = await handler({ host: 'cm', prompt: 'hi' }, new AbortController().signal);
    expect(reads).toEqual(['cm']);
    expect(launchStdin).toBe('topsecret\nhi');
    expect(res.content).not.toContain('topsecret');
  });

  it('fails with the setup command when no password is stored', async () => {
    vi.stubEnv('AFK_REMOTE_DEPTH', '');
    const exec = vi.fn();
    const handler = createRemoteAgentHandler({
      runner: { exec, stream: vi.fn() },
      loadHosts: async () => ({ cm: { name: 'cm', ssh: 'me@cm', unlockKeychain: true } }),
      readUnlockPassword: async () => { throw new Error('no stored keychain password for host "cm"'); },
    });
    const res = await handler({ host: 'cm', prompt: 'hi' }, new AbortController().signal);
    expect(res.isError).toBe(true);
    expect(res.content).toContain('no stored keychain password');
    expect(exec).not.toHaveBeenCalled();
  });
});
