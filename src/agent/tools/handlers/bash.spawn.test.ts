import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(() => ({ unref: vi.fn() })),
  build: vi.fn(() => ({ shell: 'sandbox-backend', args: ['-c'], command: 'true', sandboxed: true })),
  childEnv: { TMPDIR: '/synthetic/private-child-tmp', TMP: '/synthetic/secondary', TEMP: '/synthetic/last' } as Record<string, string | undefined>,
}));
vi.mock('child_process', () => ({ spawn: mocks.spawn }));
vi.mock('./bash-env-scrub.js', () => ({ buildChildEnv: () => mocks.childEnv }));
vi.mock('./bash-sandbox.js', () => ({ parseSandboxPolicy: () => 'workspace-write', buildSandboxedCommand: mocks.build }));
import { spawnBashProcess } from './bash.spawn.js';

afterEach(() => { vi.clearAllMocks(); });
describe('foreground spawn sandbox wiring', () => {
  it('uses actual built child TMPDIR and implicit process cwd', () => {
    spawnBashProcess('true', undefined, undefined);
    expect(mocks.build).toHaveBeenCalledWith('true', 'workspace-write', process.cwd(), mocks.childEnv['TMPDIR']);
    expect(mocks.spawn).toHaveBeenCalledWith('sandbox-backend', ['-c', 'true'], expect.objectContaining({ cwd: process.cwd(), env: mocks.childEnv }));
  });
  it('uses resolveBase before the factory cwd', () => {
    spawnBashProcess('true', { resolveBase: '/synthetic/context' }, '/synthetic/factory');
    expect(mocks.build).toHaveBeenCalledWith('true', 'workspace-write', '/synthetic/context', mocks.childEnv['TMPDIR']);
  });
  it('uses child TMP/TEMP and POSIX /tmp fallback, never the parent TMPDIR', () => {
    const original = { ...mocks.childEnv };
    try {
      delete mocks.childEnv['TMPDIR'];
      spawnBashProcess('true', undefined, undefined);
      expect(mocks.build).toHaveBeenLastCalledWith('true', 'workspace-write', process.cwd(), original['TMP']);
      delete mocks.childEnv['TMP'];
      spawnBashProcess('true', undefined, undefined);
      expect(mocks.build).toHaveBeenLastCalledWith('true', 'workspace-write', process.cwd(), original['TEMP']);
      delete mocks.childEnv['TEMP'];
      spawnBashProcess('true', undefined, undefined);
      expect(mocks.build).toHaveBeenLastCalledWith('true', 'workspace-write', process.cwd(), '/tmp');
    } finally {
      Object.assign(mocks.childEnv, original);
    }
  });
  it('propagates builder refusal without ever spawning unsandboxed', () => {
    mocks.build.mockImplementationOnce(() => { throw new Error('Sandbox refused'); });
    expect(() => spawnBashProcess('true', undefined, undefined)).toThrow('Sandbox refused');
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});
