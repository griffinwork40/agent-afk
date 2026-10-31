import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, symlinkSync, realpathSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

const fixtures = vi.hoisted(() => ({ floor: [] as string[] }));
// Only synthetic fixture paths are protected/probed; never touch real credentials.
vi.mock('./write-denylist.js', () => ({ getUnresolvedWriteDenylist: () => fixtures.floor }));
import { buildSandboxedCommand } from './bash-sandbox.js';

const platform = process.platform;
// Capability probes, not platform skips: Windows refusal is covered by builders.
const sandboxExecReady = spawnSync(path.posix.join('/', 'usr', 'bin', 'sandbox-exec'), ['-p', '(version 1) (allow default)', path.posix.join('/', 'usr', 'bin', 'true')], { encoding: 'utf8' }).status === 0;
const bwrapReady = spawnSync('bwrap', ['--ro-bind', '/', '/', '--cap-drop', 'ALL', '--unshare-pid', '--proc', '/proc', '--remount-ro', '/proc', '--', '/bin/true'], { encoding: 'utf8' }).status === 0;
const available = sandboxExecReady || bwrapReady;
const runFile = promisify(execFile);
const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
let root: string;
let cwd: string;
let temp: string;
let protectedDir: string;
let sentinel: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'afk-sandbox-runtime-')));
  cwd = path.join(root, 'workspace');
  temp = path.join(root, 'temp');
  protectedDir = path.join(cwd, 'synthetic-protected');
  mkdirSync(cwd);
  mkdirSync(temp);
  mkdirSync(protectedDir);
  sentinel = path.join(protectedDir, 'sentinel');
  writeFileSync(sentinel, 'unchanged');
  fixtures.floor = [protectedDir];
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

async function run(command: string, policy: 'workspace-write' | 'read-only' = 'workspace-write', workingDir = cwd): Promise<string> {
  const wrapped = buildSandboxedCommand(command, policy, workingDir, temp);
  const result = await runFile(wrapped.shell, [...wrapped.args, wrapped.command], {
    cwd: workingDir, timeout: 10_000,
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: root, TMPDIR: temp, TMP: temp, TEMP: temp, GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' },
  });
  return result.stdout;
}

// Skip only unavailable backend/kernel prerequisites, never silently pass a failed probe.
describe.skipIf(!available)(`runtime sandbox regressions (${platform}; sandbox-exec/bwrap required)`, () => {
  it('allows cwd/temp writes, blocks outside writes and symlink escape', async () => {
    // Disjoint Linux grants: its deliberate overlap refusal is tested separately.
    if (platform === 'linux') fixtures.floor = [path.join(root, 'outside-protected')];
    const outside = path.join(root, 'outside');
    const escape = path.join(cwd, 'escape');
    symlinkSync(root, escape, 'dir');
    await run('printf ok > workspace-file; printf ok > "$TMPDIR/temp-file"');
    await expect(run(`printf bad > ${quote(outside)}`)).rejects.toThrow();
    await expect(run('printf bad > escape/outside')).rejects.toThrow();
    expect(readFileSync(path.join(cwd, 'workspace-file'), 'utf8')).toBe('ok');
    expect(readFileSync(path.join(temp, 'temp-file'), 'utf8')).toBe('ok');
    expect(existsSync(outside)).toBe(false);
  });

  it('protects existing and absent floor entries, aliases and ancestor rename', async () => {
    if (platform === 'linux') {
      expect(() => buildSandboxedCommand('true', 'workspace-write', cwd, temp)).toThrow(/overlaps/);
      return;
    }
    const alias = path.join(cwd, 'alias');
    symlinkSync(protectedDir, alias, 'dir');
    for (const command of [
      `printf bad > ${quote(sentinel)}`,
      'printf bad > alias/sentinel',
      'printf bad > synthetic-protected/absent-token',
      'mv synthetic-protected moved-protected',
      `ln ${quote(sentinel)} hardlink-token && printf bad > hardlink-token`,
      `mv ${quote(cwd)} ${quote(path.join(root, 'moved-workspace'))}`,
    ]) await expect(run(command)).rejects.toThrow();
    expect(readFileSync(sentinel, 'utf8')).toBe('unchanged');
    expect(existsSync(path.join(protectedDir, 'absent-token'))).toBe(false);
  });

  it('Linux protects disjoint floor leaves and hides host proc/device interfaces', async () => {
    if (platform === 'linux') {
      const outside = path.join(root, 'outside-protected');
      mkdirSync(outside);
      const existing = path.join(outside, 'existing');
      const absent = path.join(outside, 'absent');
      writeFileSync(existing, 'unchanged');
      fixtures.floor = [existing, absent];
      symlinkSync(outside, path.join(cwd, 'outside-alias'), 'dir');
      for (const target of [existing, absent, path.join(cwd, 'outside-alias', 'absent')]) {
        await expect(run(`printf bad > ${quote(target)}`)).rejects.toThrow();
      }
      expect(readFileSync(existing, 'utf8')).toBe('unchanged');
      expect(existsSync(absent)).toBe(false);
      // The parent test process cannot be reached through the private PID view.
      expect(await run(`test ! -e /proc/${process.pid}/root && test ! -e /dev/mem && test ! -e /dev/sda && printf isolated`)).toBe('isolated');
      await expect(run('printf bad > /dev/new-file', 'read-only')).rejects.toThrow();
      await expect(run(`printf bad > /proc/${process.pid}/root${quote(existing)}`)).rejects.toThrow();
    } else {
      // Darwin has no mount namespace backend; its deny-over-grant path is tested above.
      expect(platform).toBe('darwin');
    }
  });

  it('read-only blocks cwd, temp and generic /tmp writes and still reads', async () => {
    for (const target of [path.join(cwd, 'no'), path.join(temp, 'no'), path.join(tmpdir(), `afk-no-write-${path.basename(root)}`)]) {
      await expect(run(`printf bad > ${quote(target)}`, 'read-only')).rejects.toThrow();
      expect(existsSync(target)).toBe(false);
    }
    expect(await run(`cat ${quote(sentinel)}`, 'read-only')).toBe('unchanged');
  });

  it('Scheme quote/backslash payload cannot broaden the profile', async () => {
    const unusual = path.join(root, 'workspace")) (allow file-write*) ;\\tail');
    mkdirSync(unusual);
    const outside = path.join(root, 'injected-write');
    await run('printf ok > allowed', 'workspace-write', unusual);
    await expect(run(`printf bad > ${quote(outside)}`, 'workspace-write', unusual)).rejects.toThrow();
    expect(existsSync(outside)).toBe(false);
  });

  it('preserves git and unrestricted network operations', async () => {
    if (platform === 'linux') fixtures.floor = [path.join(root, 'outside-protected')];
    await run('git init -q . && git -c user.name=Sandbox -c user.email=synthetic@example.invalid commit -q --allow-empty -m fixture');
    expect((await run('git log -1 --format=%s', 'read-only')).trim()).toBe('fixture');
    const server = createServer((_req, res) => { res.end('network-ok'); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('Missing server port');
      const script = `require('http').get('http://127.0.0.1:${address.port}',r=>r.pipe(process.stdout)).on('error',()=>process.exit(1))`;
      expect(await run(`${quote(process.execPath)} -e ${quote(script)}`)).toBe('network-ok');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
