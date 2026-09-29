/**
 * Unit tests for sandbox-manifest.ts.
 *
 * Verifies that sandboxes.json is written to the run dir (not under either
 * arm root), that its content is correct, and that the CLI message formatter
 * produces the expected output.
 */

import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  formatSandboxKeptMessage,
  writeSandboxManifest,
  type SandboxManifest,
} from './sandbox-manifest.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'afk-manifest-test-'));
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// writeSandboxManifest
// ---------------------------------------------------------------------------

describe('writeSandboxManifest', () => {
  it('writes sandboxes.json to runDir with correct content', async () => {
    const runDir = path.join(tmpDir, 'run');
    await fsp.mkdir(runDir, { recursive: true });

    const baselineRoot = path.join(tmpDir, 'arm-a');
    const candidateRoot = path.join(tmpDir, 'arm-b');
    const roots: SandboxManifest = { baseline: baselineRoot, candidate: candidateRoot };

    const manifestPath = await writeSandboxManifest(runDir, roots);

    // Manifest lives inside runDir
    expect(manifestPath).toBe(path.join(runDir, 'sandboxes.json'));

    const raw = await fsp.readFile(manifestPath, 'utf8');
    const parsed = JSON.parse(raw) as SandboxManifest;
    expect(parsed.baseline).toBe(baselineRoot);
    expect(parsed.candidate).toBe(candidateRoot);
  });

  it('mapping file is in runDir, NOT under either arm root', async () => {
    const runDir = path.join(tmpDir, 'run');
    await fsp.mkdir(runDir, { recursive: true });

    // Simulate arm roots as siblings of runDir in os.tmpdir()
    const baselineRoot = path.join(tmpDir, 'afk-baseline');
    const candidateRoot = path.join(tmpDir, 'afk-candidate');
    const roots: SandboxManifest = { baseline: baselineRoot, candidate: candidateRoot };

    const manifestPath = await writeSandboxManifest(runDir, roots);

    // Assert NOT under either arm root
    expect(manifestPath.startsWith(baselineRoot)).toBe(false);
    expect(manifestPath.startsWith(candidateRoot)).toBe(false);

    // Assert IS under runDir
    expect(manifestPath.startsWith(runDir)).toBe(true);
  });

  it('returns the absolute path of the written file', async () => {
    const runDir = path.join(tmpDir, 'run2');
    await fsp.mkdir(runDir, { recursive: true });

    const roots: SandboxManifest = { baseline: '/tmp/afk-abc', candidate: '/tmp/afk-def' };
    const result = await writeSandboxManifest(runDir, roots);

    expect(path.isAbsolute(result)).toBe(true);
    expect(result).toBe(path.join(runDir, 'sandboxes.json'));
  });
});

// ---------------------------------------------------------------------------
// formatSandboxKeptMessage
// ---------------------------------------------------------------------------

describe('formatSandboxKeptMessage', () => {
  it('includes both arm roots and the mapping path', () => {
    const roots: SandboxManifest = {
      baseline: '/tmp/afk-aaa111',
      candidate: '/tmp/afk-bbb222',
    };
    const mappingPath = '/home/.afk/state/whatif/run-20260929/sandboxes.json';

    const msg = formatSandboxKeptMessage(roots, mappingPath);

    expect(msg).toContain(roots.baseline);
    expect(msg).toContain(roots.candidate);
    expect(msg).toContain(mappingPath);
    expect(msg).toContain('baseline');
    expect(msg).toContain('candidate');
  });
});
