/**
 * Tests for interactive.register-helpers — focused on maybeRunStartupPicker.
 *
 * Key invariant: spinner.stop() / spinner.start() must never throw even when
 * the spinner object is a stub without those methods (non-TTY / CI environments
 * where ora may return a silent-mode shim).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { maybeRunStartupPicker } from './interactive.register-helpers.js';

// ---------------------------------------------------------------------------
// Mock runStartupSessionPicker so tests never touch the real session store
// ---------------------------------------------------------------------------
vi.mock('./interactive/startup-session-picker.js', () => ({
  runStartupSessionPicker: vi.fn(),
}));

// Also mock resolveResumeTarget (used by validateResumeOption inside the helper)
vi.mock('../resume-session.js', () => ({
  resolveResumeTarget: vi.fn(() => ({ stored: true })),
}));

import { runStartupSessionPicker } from './interactive/startup-session-picker.js';

const mockPicker = vi.mocked(runStartupSessionPicker);

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFullSpinner() {
  return { stop: vi.fn(), start: vi.fn() };
}

function makeEmptySpinner(): Record<string, never> {
  return {};
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('maybeRunStartupPicker', () => {
  it('skips picker and does not call spinner when --resume already set', async () => {
    const spinner = makeFullSpinner();
    const options = { resume: 'some-session-id' };
    await maybeRunStartupPicker({ options, spinner });
    expect(mockPicker).not.toHaveBeenCalled();
    expect(spinner.stop).not.toHaveBeenCalled();
    expect(spinner.start).not.toHaveBeenCalled();
  });

  it('skips picker and does not call spinner when --continue already set', async () => {
    const spinner = makeFullSpinner();
    const options = { continue: true };
    await maybeRunStartupPicker({ options, spinner });
    expect(mockPicker).not.toHaveBeenCalled();
    expect(spinner.stop).not.toHaveBeenCalled();
  });

  it('stops spinner, runs picker, restarts spinner when no session selected', async () => {
    mockPicker.mockResolvedValue({ selectedId: undefined });
    const spinner = makeFullSpinner();
    const options: { resume?: string; continue?: boolean } = {};
    await maybeRunStartupPicker({ options, spinner });
    expect(spinner.stop).toHaveBeenCalledOnce();
    expect(mockPicker).toHaveBeenCalledOnce();
    expect(spinner.start).toHaveBeenCalledWith('Initializing interactive session...');
    expect(options.resume).toBeUndefined();
  });

  it('sets options.resume when a session is selected', async () => {
    mockPicker.mockResolvedValue({ selectedId: 'abc-123' });
    const spinner = makeFullSpinner();
    const options: { resume?: string; continue?: boolean } = {};
    await maybeRunStartupPicker({ options, spinner });
    expect(options.resume).toBe('abc-123');
    expect(spinner.start).toHaveBeenCalledWith('Initializing interactive session...');
  });

  // -------------------------------------------------------------------------
  // CI / non-TTY robustness: spinner stub without .stop() / .start()
  // -------------------------------------------------------------------------

  it('does NOT throw when spinner has no .stop() method (non-TTY stub)', async () => {
    mockPicker.mockResolvedValue({ selectedId: undefined });
    const spinner = makeEmptySpinner();
    const options: { resume?: string; continue?: boolean } = {};
    // Must not throw TypeError: spinner.stop is not a function
    await expect(maybeRunStartupPicker({ options, spinner })).resolves.toBeUndefined();
  });

  it('does NOT throw when spinner has no .start() method (non-TTY stub)', async () => {
    mockPicker.mockResolvedValue({ selectedId: undefined });
    const spinner = { stop: vi.fn() }; // stop present, start absent
    const options: { resume?: string; continue?: boolean } = {};
    await expect(maybeRunStartupPicker({ options, spinner })).resolves.toBeUndefined();
  });

  it('does NOT throw when spinner is fully empty and a session is selected', async () => {
    mockPicker.mockResolvedValue({ selectedId: 'xyz-789' });
    const spinner = makeEmptySpinner();
    const options: { resume?: string; continue?: boolean } = {};
    await expect(maybeRunStartupPicker({ options, spinner })).resolves.toBeUndefined();
    expect(options.resume).toBe('xyz-789');
  });
});
