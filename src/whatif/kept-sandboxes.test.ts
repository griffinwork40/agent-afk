/**
 * Unit tests for src/whatif/kept-sandboxes.ts
 */

import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupOrRecord } from './kept-sandboxes.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kept-sandboxes-test-'));
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe('cleanupOrRecord', () => {
  it('calls cleanup and returns undefined when keepSandboxes is false', async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const roots = { baseline: '/tmp/afk-baseline', candidate: '/tmp/afk-candidate' };

    const result = await cleanupOrRecord(tmpDir, roots, cleanup, false);

    expect(cleanup).toHaveBeenCalledOnce();
    expect(result).toBeUndefined();

    // sandboxes.json should NOT exist
    const mappingPath = path.join(tmpDir, 'sandboxes.json');
    await expect(fsp.access(mappingPath)).rejects.toThrow();
  });

  it('writes sandboxes.json and returns roots when keepSandboxes is true', async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const baselineRoot = path.join(tmpDir, 'arm-baseline');
    const candidateRoot = path.join(tmpDir, 'arm-candidate');
    await fsp.mkdir(baselineRoot);
    await fsp.mkdir(candidateRoot);
    const roots = { baseline: baselineRoot, candidate: candidateRoot };

    const result = await cleanupOrRecord(tmpDir, roots, cleanup, true);

    // cleanup should NOT have been called
    expect(cleanup).not.toHaveBeenCalled();

    // result should match roots
    expect(result).toEqual(roots);

    // sandboxes.json must exist in tmpDir (the run dir)
    const mappingPath = path.join(tmpDir, 'sandboxes.json');
    const raw = await fsp.readFile(mappingPath, 'utf8');
    const mapping = JSON.parse(raw) as { baseline: string; candidate: string };
    expect(mapping.baseline).toBe(baselineRoot);
    expect(mapping.candidate).toBe(candidateRoot);
  });

  it('sandboxes.json is written to runDir, not inside either arm root', async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const baselineRoot = path.join(tmpDir, 'arm-a');
    const candidateRoot = path.join(tmpDir, 'arm-b');
    await fsp.mkdir(baselineRoot);
    await fsp.mkdir(candidateRoot);
    const roots = { baseline: baselineRoot, candidate: candidateRoot };

    await cleanupOrRecord(tmpDir, roots, cleanup, true);

    const mappingPath = path.join(tmpDir, 'sandboxes.json');

    // mapping file path does not start with either arm root
    expect(mappingPath.startsWith(baselineRoot)).toBe(false);
    expect(mappingPath.startsWith(candidateRoot)).toBe(false);
  });

  it('best-effort: does not throw when cleanup rejects and keepSandboxes is false', async () => {
    const cleanup = vi.fn().mockRejectedValue(new Error('rm failed'));
    const roots = { baseline: '/tmp/afk-x', candidate: '/tmp/afk-y' };

    // Should not throw
    await expect(cleanupOrRecord(tmpDir, roots, cleanup, false)).resolves.toBeUndefined();
  });
});
