import { Console } from 'node:console';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installAcpConsoleRedirect } from './acp.server.console.js';

afterEach(() => { vi.restoreAllMocks(); });

describe('ACP console redirect', () => {
  it.each([false, true])('keeps all stdout console methods on stderr and restores them (throws=%s)', (throws) => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const ordinary = new Console({ stdout, stderr });
    let out = '';
    let err = '';
    stdout.on('data', (data: Buffer) => { out += data.toString(); });
    stderr.on('data', (data: Buffer) => { err += data.toString(); });
    for (const method of ['log', 'info', 'debug'] as const) vi.spyOn(console, method).mockImplementation(ordinary[method].bind(ordinary));
    const originals = { log: console.log, info: console.info, debug: console.debug };
    const body = (): void => {
      const restore = installAcpConsoleRedirect(stderr);
      try {
        console.log('x'); console.info('info %s', 'x'); console.debug({ x: 1 });
        expect(out).toBe('');
        expect(err).toContain('x\n');
        expect(err).toContain('info x\n');
        expect(err).toContain('{ x: 1 }');
        if (throws) throw new Error('body failed');
      } finally { restore(); }
    };
    if (throws) expect(body).toThrow('body failed');
    else body();
    expect(console.log).toBe(originals.log);
    expect(console.info).toBe(originals.info);
    expect(console.debug).toBe(originals.debug);
    console.log('restored');
    expect(out).toBe('restored\n');
  });

  it('defaults to real process.stderr, not the injected protocol output', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const restore = installAcpConsoleRedirect();
    try {
      console.log('diagnostic');
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).toHaveBeenCalledWith('diagnostic\n', expect.anything());
    } finally { restore(); }
  });
});
