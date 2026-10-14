import { describe, expect, expectTypeOf, it } from 'vitest';
import { execFileAsync, type ExecFileAsync } from './exec-file.js';

describe('execFileAsync', () => {
  it('exports its executor type', () => {
    expectTypeOf<ExecFileAsync>().toEqualTypeOf<typeof execFileAsync>();
  });

  it('returns stdout and stderr while preserving caller options', async () => {
    const execute: ExecFileAsync = execFileAsync;
    const result = await execute(process.execPath, [
      '-e',
      'process.stdout.write(process.argv[1]); process.stderr.write("warning");',
      'hello',
    ], { timeout: 5_000, maxBuffer: 1024, encoding: 'utf8' });

    expect(result).toEqual({ stdout: 'hello', stderr: 'warning' });
  });

  it('rejects when the child exits unsuccessfully', async () => {
    await expect(execFileAsync(process.execPath, ['-e', 'process.exit(7)'], {
      timeout: 5_000,
    })).rejects.toMatchObject({ code: 7 });
  });
});
