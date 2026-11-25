import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, unlink } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { downscaleWithSips, buildAttachedImage } from './desktop-screenshot.downscale.js';

const { execAsync } = vi.hoisted(() => ({ execAsync: vi.fn() }));
vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util');
  return { execFile: Object.assign(vi.fn(), { [promisify.custom]: execAsync }) };
});
vi.mock('node:fs/promises', () => ({ readFile: vi.fn(), unlink: vi.fn() }));

const source = path.join(os.tmpdir(), 'private-screenshot.png');
const out = path.join(os.tmpdir(), 'private-attachment.png');
beforeEach(() => {
  execAsync.mockResolvedValue({ stdout: '', stderr: '' });
  vi.mocked(readFile).mockResolvedValue(Buffer.alloc(33));
  vi.mocked(unlink).mockResolvedValue(undefined);
});
afterEach(() => vi.resetAllMocks());

describe('sips downscale', () => {
  it('passes the abort signal to the child and always removes the temporary output', async () => {
    const signal = new AbortController().signal;
    const result = await downscaleWithSips(source, out, 1092, signal);
    expect(result).toEqual(Buffer.alloc(33));
    expect(execAsync).toHaveBeenCalledWith('sips', ['--resampleHeightWidthMax', '1092', source, '--out', out], {
      timeout: 15_000, signal,
    });
    expect(unlink).toHaveBeenCalledWith(out);
  });

  it('cleans the temporary output when the resize child aborts', async () => {
    const controller = new AbortController();
    execAsync.mockImplementation(async (_cmd, _args, options: { signal: AbortSignal }) => {
      expect(options.signal).toBe(controller.signal);
      controller.abort('cancelled');
      throw new Error('AbortError');
    });
    expect(await downscaleWithSips(source, out, 1092, controller.signal)).toBeNull();
    expect(readFile).not.toHaveBeenCalled();
    expect(unlink).toHaveBeenCalledWith(out);
  });

  it('keeps valid original images without launching a resize', async () => {
    const downscale = vi.fn();
    expect(await buildAttachedImage('small', 100, 50, source, new AbortController().signal, downscale)).toEqual({
      dataBase64: 'small', attachedWidth: 100, attachedHeight: 50,
    });
    expect(downscale).not.toHaveBeenCalled();
  });
});
