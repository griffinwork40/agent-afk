/**
 * Pins the property the identity file's location exists for: the REAL path
 * returned by the path helper (which holds an Ed25519 private key) is refused
 * by the agent's file tools, for the default AFK home and a relocated one.
 *
 * No denylist entry names global-chat. The protection comes from the files
 * living under the AFK config dir, which the read floor, write floor, and
 * shell guard already deny wholesale. If someone moves the files back under
 * the state dir (which is grantable to subagents), these tests fail.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FileIdentityStore } from './identity.js';
import { FileMuteStore } from './mute-store.js';
import { getGlobalChatIdentityPath, getGlobalChatMutesPath } from '../paths.global-chat.js';
import { getAfkHome, getAfkStateDir } from '../paths.js';
import { readFileHandler } from '../agent/tools/handlers/read-file.js';
import { grepHandler } from '../agent/tools/handlers/grep.js';
import { globHandler } from '../agent/tools/handlers/glob.js';
import { listDirectoryHandler } from '../agent/tools/handlers/list-directory.js';
import { writeFileHandler } from '../agent/tools/handlers/write-file.js';
import { editFileHandler } from '../agent/tools/handlers/edit-file.js';
import {
  READ_ALLOWLIST_REL,
  _resetReadDenylistCacheForTests,
  isReadDenied,
} from '../agent/tools/handlers/read-denylist.js';
import { SENSITIVE_PATH_SIGNAL } from '../agent/tools/hooks/bash-restriction-hook.js';

const signal = (): AbortSignal => new AbortController().signal;
const NEEDLE = 'floor-needle-identity';

async function seedRealFiles(): Promise<string> {
  const identityPath = getGlobalChatIdentityPath();
  const res = await new FileIdentityStore().create('alice');
  expect(res.ok).toBe(true);
  await new FileMuteStore().add('a'.repeat(64), NEEDLE);
  expect(existsSync(identityPath)).toBe(true);
  expect(existsSync(getGlobalChatMutesPath())).toBe(true);
  return identityPath;
}

/** A handler refuses by returning isError or by throwing; either way no content leaks. */
async function expectRefused(p: Promise<{ content: unknown; isError?: boolean }>): Promise<void> {
  let text: string;
  try {
    const r = await p;
    expect(r.isError).toBe(true);
    text = String(r.content);
  } catch (err) {
    text = String(err);
  }
  expect(text).toMatch(/protected/i);
  expect(text).not.toMatch(/privateKey|pubkey"/);
}

async function expectToolsRefuse(identityPath: string): Promise<void> {
  const chatDir = dirname(identityPath);
  const afkHome = getAfkHome();
  expect(isReadDenied(identityPath).denied).toBe(true);
  expect(isReadDenied(getGlobalChatMutesPath()).denied).toBe(true);

  await expectRefused(readFileHandler({ file_path: identityPath }, signal()));

  await expectRefused(listDirectoryHandler({ path: chatDir }, signal()));

  // grep/glob from the AFK home must not descend into the config subtree.
  // (The "no matches" reply echoes the pattern, so assert on file names.)
  for (const pattern of [NEEDLE, 'privateKey']) {
    const grep = await grepHandler({ pattern, path: afkHome }, signal());
    expect(String(grep.content)).not.toMatch(/identity\.json|mutes\.json/);
  }
  await expectRefused(grepHandler({ pattern: 'pubkey', path: chatDir }, signal()));
  const glob = await globHandler({ pattern: '**/*.json', path: afkHome }, signal());
  expect(String(glob.content)).not.toContain('identity.json');
  expect(String(glob.content)).not.toContain('mutes.json');

  const before = await readFile(identityPath, 'utf8');
  await expectRefused(writeFileHandler({ file_path: identityPath, content: '{}' }, signal()));
  await expectRefused(
    editFileHandler({ file_path: identityPath, old_string: 'pubkey', new_string: 'x' }, signal()),
  );
  expect(await readFile(identityPath, 'utf8')).toBe(before);
}

describe('global-chat identity file is outside agent reach', () => {
  let relocated: string | undefined;

  beforeEach(() => { _resetReadDenylistCacheForTests(); });
  afterEach(async () => {
    vi.unstubAllEnvs();
    _resetReadDenylistCacheForTests();
    if (relocated !== undefined) await rm(relocated, { recursive: true, force: true });
    relocated = undefined;
  });

  it('is refused at the default AFK home (AFK_HOME unset)', async () => {
    vi.stubEnv('AFK_HOME', '');
    vi.stubEnv('AFK_STATE_DIR', '');
    const identityPath = await seedRealFiles();
    await expectToolsRefuse(identityPath);
  });

  it('is refused under a relocated AFK_HOME', async () => {
    relocated = await mkdtemp(join(tmpdir(), 'afk-home-chat-floor-'));
    vi.stubEnv('AFK_HOME', relocated);
    vi.stubEnv('AFK_STATE_DIR', '');
    const identityPath = await seedRealFiles();
    expect(identityPath.startsWith(relocated)).toBe(true);
    await expectToolsRefuse(identityPath);
  });

  it('is not inside the grantable state dir and has no allowlist carve-out', () => {
    vi.stubEnv('AFK_HOME', '');
    vi.stubEnv('AFK_STATE_DIR', '');
    const identityPath = getGlobalChatIdentityPath();
    expect(identityPath.startsWith(getAfkStateDir())).toBe(false);
    expect(READ_ALLOWLIST_REL.some((rel) => rel.includes('global-chat'))).toBe(false);
  });

  it('is caught by the shell guard sensitive-path signal', () => {
    vi.stubEnv('AFK_HOME', '');
    expect(SENSITIVE_PATH_SIGNAL.test(`cat ${getGlobalChatIdentityPath()}`)).toBe(true);
    expect(SENSITIVE_PATH_SIGNAL.test('cat ~/.afk/config/global-chat/identity.json')).toBe(true);
  });
});
