/**
 * Tests for the shared slash-registry initialization memo.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';

/** Untyped call-through mock; the precise signature is irrelevant to these tests. */
type AnyMock = Mock<(...args: unknown[]) => unknown>;

let mockRegisterAll: AnyMock;
let mockRegisterPluginSkillsForWeb: AnyMock;

vi.mock('../cli/slash/index.js', () => ({
  registerAll: (...args: unknown[]) => mockRegisterAll(...args),
}));

vi.mock('./register-plugin-skills.js', () => ({
  registerPluginSkillsForWeb: (...args: unknown[]) => mockRegisterPluginSkillsForWeb(...args),
}));

import { ensureSlashRegistry, resetSlashRegistry } from './slash-registry.js';

beforeEach(() => {
  resetSlashRegistry();
  mockRegisterAll = vi.fn();
  mockRegisterPluginSkillsForWeb = vi.fn().mockResolvedValue(undefined);
});

describe('ensureSlashRegistry', () => {
  it('calls registerAll and registerPluginSkillsForWeb on first call', async () => {
    await ensureSlashRegistry();
    expect(mockRegisterAll).toHaveBeenCalledOnce();
    expect(mockRegisterPluginSkillsForWeb).toHaveBeenCalledOnce();
  });

  it('does not call registerAll again on subsequent calls', async () => {
    await ensureSlashRegistry();
    await ensureSlashRegistry();
    await ensureSlashRegistry();
    expect(mockRegisterAll).toHaveBeenCalledOnce();
  });

  it('concurrent calls share one registerAll invocation', async () => {
    await Promise.all([
      ensureSlashRegistry(),
      ensureSlashRegistry(),
      ensureSlashRegistry(),
    ]);
    expect(mockRegisterAll).toHaveBeenCalledOnce();
  });

  it('retries after failure (clears promise, not done flag)', async () => {
    mockRegisterPluginSkillsForWeb.mockRejectedValueOnce(new Error('transient'));
    await expect(ensureSlashRegistry()).rejects.toThrow('transient');

    // Second call should retry
    mockRegisterPluginSkillsForWeb.mockResolvedValue(undefined);
    await ensureSlashRegistry();
    expect(mockRegisterAll).toHaveBeenCalledTimes(2);
  });

  it('resetSlashRegistry allows re-observation of registration', async () => {
    await ensureSlashRegistry();
    expect(mockRegisterAll).toHaveBeenCalledOnce();

    resetSlashRegistry();
    await ensureSlashRegistry();
    expect(mockRegisterAll).toHaveBeenCalledTimes(2);
  });
});
