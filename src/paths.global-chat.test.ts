/**
 * Tests for src/paths.global-chat.ts — global-chat client state paths.
 *
 * Verifies default derivation from AFK_HOME / AFK_STATE_DIR and that the
 * helpers compose from getGlobalChatDir().
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { join } from 'path';
import { homedir } from 'os';
import {
  getGlobalChatDir,
  getGlobalChatIdentityPath,
  getGlobalChatMutesPath,
} from './paths.global-chat.js';
import { getGlobalChatDir as reexportedDir } from './paths.js';

describe('paths.global-chat', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to <AFK_HOME>/state/global-chat when AFK_STATE_DIR is unset', () => {
    vi.stubEnv('AFK_HOME', '/tmp/afk-home-test');
    vi.stubEnv('AFK_STATE_DIR', '');
    expect(getGlobalChatDir()).toBe(join('/tmp/afk-home-test', 'state', 'global-chat'));
  });

  it('defaults to ~/.afk/state/global-chat when AFK_HOME is unset', () => {
    vi.stubEnv('AFK_HOME', '');
    vi.stubEnv('AFK_STATE_DIR', '');
    expect(getGlobalChatDir()).toBe(join(homedir(), '.afk', 'state', 'global-chat'));
  });

  it('AFK_STATE_DIR overrides the state tier', () => {
    vi.stubEnv('AFK_HOME', '/tmp/afk-home-test');
    vi.stubEnv('AFK_STATE_DIR', '/tmp/afk-state-test');
    expect(getGlobalChatDir()).toBe(join('/tmp/afk-state-test', 'global-chat'));
  });

  it('identity and mutes paths live under getGlobalChatDir()', () => {
    vi.stubEnv('AFK_STATE_DIR', '/tmp/afk-state-test');
    expect(getGlobalChatIdentityPath()).toBe(join('/tmp/afk-state-test', 'global-chat', 'identity.json'));
    expect(getGlobalChatMutesPath()).toBe(join('/tmp/afk-state-test', 'global-chat', 'mutes.json'));
  });

  it('is re-exported from src/paths.ts', () => {
    vi.stubEnv('AFK_STATE_DIR', '/tmp/afk-state-test');
    expect(reexportedDir()).toBe(getGlobalChatDir());
  });
});
