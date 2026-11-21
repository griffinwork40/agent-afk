/**
 * Tests for src/paths.global-chat.ts — global-chat client file paths.
 *
 * Verifies the files resolve under the AFK config dir (never the state dir)
 * and that the helpers compose from getGlobalChatDir().
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import {
  getGlobalChatDir,
  getGlobalChatIdentityPath,
  getGlobalChatMutesPath,
} from './paths.global-chat.js';
import { getAfkConfigDir, getAfkStateDir, getGlobalChatDir as reexportedDir } from './paths.js';

const RELOCATED = join(tmpdir(), 'afk-home-test');

describe('paths.global-chat', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('resolves to <AFK_HOME>/config/global-chat', () => {
    vi.stubEnv('AFK_HOME', RELOCATED);
    expect(getGlobalChatDir()).toBe(join(RELOCATED, 'config', 'global-chat'));
    expect(getGlobalChatDir()).toBe(join(getAfkConfigDir(), 'global-chat'));
  });

  it('defaults to <home>/.afk/config/global-chat when AFK_HOME is unset', () => {
    vi.stubEnv('AFK_HOME', '');
    expect(getGlobalChatDir()).toBe(join(homedir(), '.afk', 'config', 'global-chat'));
  });

  it('does not follow AFK_STATE_DIR (the files are not state)', () => {
    vi.stubEnv('AFK_HOME', RELOCATED);
    vi.stubEnv('AFK_STATE_DIR', join(tmpdir(), 'afk-state-test'));
    expect(getGlobalChatDir()).toBe(join(RELOCATED, 'config', 'global-chat'));
    expect(getGlobalChatDir().startsWith(getAfkStateDir())).toBe(false);
  });

  it('identity and mutes paths live under getGlobalChatDir()', () => {
    vi.stubEnv('AFK_HOME', RELOCATED);
    expect(getGlobalChatIdentityPath()).toBe(join(RELOCATED, 'config', 'global-chat', 'identity.json'));
    expect(getGlobalChatMutesPath()).toBe(join(RELOCATED, 'config', 'global-chat', 'mutes.json'));
  });

  it('is re-exported from src/paths.ts', () => {
    vi.stubEnv('AFK_HOME', RELOCATED);
    expect(reexportedDir()).toBe(getGlobalChatDir());
  });
});
