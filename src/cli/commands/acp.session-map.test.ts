/**
 * Tests for acp.session-map.ts — ACP id → AFK journal id mapping.
 *
 * Uses a temp AFK_HOME so reads/writes do not pollute the real state dir.
 *
 * @module cli/commands/acp.session-map.test
 */

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Temp home — override AFK_HOME via the env module mock
// ---------------------------------------------------------------------------

let tmpHome: string;

vi.mock('../../config/env.js', () => ({
  env: new Proxy({} as Record<string, string | undefined>, {
    get(_t, k: string) {
      if (k === 'AFK_HOME') return tmpHome;
      return undefined;
    },
  }),
}));

// Import AFTER mock registration so paths resolve against tmpHome.
const { readAcpSessionMap, writeAcpSessionMap, recordAcpMapping, resolveAcpId } =
  await import('./acp.session-map.js');

beforeEach(() => {
  tmpHome = join(tmpdir(), `acp-map-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('readAcpSessionMap', () => {
  it('returns {} when the file does not exist', () => {
    expect(readAcpSessionMap()).toEqual({});
  });
});

describe('writeAcpSessionMap + readAcpSessionMap', () => {
  it('round-trips a mapping', async () => {
    await writeAcpSessionMap({ 'acp-1': 'afk-1', 'acp-2': 'afk-2' });
    expect(readAcpSessionMap()).toEqual({ 'acp-1': 'afk-1', 'acp-2': 'afk-2' });
  });
});

describe('recordAcpMapping', () => {
  it('no-op when acpId === afkId', async () => {
    await recordAcpMapping('same-id', 'same-id');
    expect(readAcpSessionMap()).toEqual({});
  });

  it('writes an entry when ids differ', async () => {
    await recordAcpMapping('acp-id', 'afk-id');
    expect(readAcpSessionMap()).toEqual({ 'acp-id': 'afk-id' });
  });

  it('merges with existing entries without clobbering', async () => {
    await recordAcpMapping('acp-1', 'afk-1');
    await recordAcpMapping('acp-2', 'afk-2');
    expect(readAcpSessionMap()).toEqual({ 'acp-1': 'afk-1', 'acp-2': 'afk-2' });
  });
});

describe('resolveAcpId', () => {
  it('returns acpId itself when no mapping exists', () => {
    expect(resolveAcpId('11111111-1111-4111-8111-111111111111')).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('returns the mapped afkId when a mapping exists', async () => {
    await writeAcpSessionMap({ 'acp-id': 'afk-other-id' });
    expect(resolveAcpId('acp-id')).toBe('afk-other-id');
  });
});
