/**
 * Tests for the `warnDeprecatedCaptureFlags` deprecation notice.
 *
 * @module config/deprecated-capture-flags.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Reset module-level _warned flag between tests by re-importing via resetModules.
// ---------------------------------------------------------------------------

/** Re-import the module with a fresh _warned latch. */
async function freshModule() {
  vi.resetModules();
  return import('./deprecated-capture-flags.js');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('warnDeprecatedCaptureFlags', () => {
  it('emits no warning when neither flag is set', async () => {
    vi.stubEnv('AFK_CAPTURE_SUBAGENT_PROMPTS', undefined);
    vi.stubEnv('AFK_CAPTURE_SUBAGENT_OUTPUT', undefined);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { warnDeprecatedCaptureFlags } = await freshModule();
    warnDeprecatedCaptureFlags();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('emits a deprecation warning when AFK_CAPTURE_SUBAGENT_PROMPTS=1', async () => {
    vi.stubEnv('AFK_CAPTURE_SUBAGENT_PROMPTS', '1');
    vi.stubEnv('AFK_CAPTURE_SUBAGENT_OUTPUT', undefined);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { warnDeprecatedCaptureFlags } = await freshModule();
    warnDeprecatedCaptureFlags();
    expect(stderrSpy).toHaveBeenCalledOnce();
    const message = String(stderrSpy.mock.calls[0]![0]);
    expect(message).toContain('AFK_CAPTURE_SUBAGENT_PROMPTS');
    expect(message).toContain('DEPRECATED');
    expect(message).toContain('subagents/');
  });

  it('emits a deprecation warning when AFK_CAPTURE_SUBAGENT_OUTPUT=1', async () => {
    vi.stubEnv('AFK_CAPTURE_SUBAGENT_PROMPTS', undefined);
    vi.stubEnv('AFK_CAPTURE_SUBAGENT_OUTPUT', '1');
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { warnDeprecatedCaptureFlags } = await freshModule();
    warnDeprecatedCaptureFlags();
    expect(stderrSpy).toHaveBeenCalledOnce();
    const message = String(stderrSpy.mock.calls[0]![0]);
    expect(message).toContain('AFK_CAPTURE_SUBAGENT_OUTPUT');
    expect(message).toContain('DEPRECATED');
  });

  it('names both flags when both are set', async () => {
    vi.stubEnv('AFK_CAPTURE_SUBAGENT_PROMPTS', '1');
    vi.stubEnv('AFK_CAPTURE_SUBAGENT_OUTPUT', '1');
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { warnDeprecatedCaptureFlags } = await freshModule();
    warnDeprecatedCaptureFlags();
    expect(stderrSpy).toHaveBeenCalledOnce();
    const message = String(stderrSpy.mock.calls[0]![0]);
    expect(message).toContain('AFK_CAPTURE_SUBAGENT_PROMPTS');
    expect(message).toContain('AFK_CAPTURE_SUBAGENT_OUTPUT');
  });

  it('warns only once per process (idempotent)', async () => {
    vi.stubEnv('AFK_CAPTURE_SUBAGENT_PROMPTS', '1');
    vi.stubEnv('AFK_CAPTURE_SUBAGENT_OUTPUT', undefined);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { warnDeprecatedCaptureFlags } = await freshModule();
    warnDeprecatedCaptureFlags();
    warnDeprecatedCaptureFlags();
    warnDeprecatedCaptureFlags();
    expect(stderrSpy).toHaveBeenCalledOnce();
  });
});
