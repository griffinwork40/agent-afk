/**
 * Regression tests for S1 (auth wizard no-echo).
 *
 * Asserts that promptToken() calls process.stdin.setRawMode(true) before
 * reading input so the API key is never echoed to the terminal.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('promptToken — S1 no-echo regression', () => {
  // Capture calls in the order they happen so we can assert setRawMode(true)
  // fires before the data listener (which would receive input).
  const callOrder: string[] = [];

  // Minimal stdin mock that satisfies the promptSecret() contract:
  //   isTTY = true, setRawMode(), resume(), setEncoding(), on(), removeListener()
  const mockStdin = {
    isTTY: true as boolean,
    setRawMode: vi.fn((mode: boolean) => {
      callOrder.push(`setRawMode(${mode})`);
    }),
    resume: vi.fn(() => { callOrder.push('resume'); }),
    setEncoding: vi.fn(),
    on: vi.fn((event: string, listener: (ch: string) => void) => {
      callOrder.push(`on(${event})`);
      // Immediately deliver Enter so the promise resolves without hanging.
      if (event === 'data') {
        // Use setImmediate to fire after the call stack unwinds (simulates
        // async I/O) but before the test awaits the resolved promise.
        setImmediate(() => listener('\r'));
      }
    }),
    removeListener: vi.fn(),
    pause: vi.fn(),
  };

  const mockStdout = {
    write: vi.fn(),
  };

  let originalStdin: NodeJS.ReadStream & { fd: 0 };
  let originalStdout: NodeJS.WriteStream & { fd: 1 };

  beforeEach(() => {
    callOrder.length = 0;
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    originalStdin = process.stdin as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    originalStdout = process.stdout as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Object.defineProperty(process, 'stdin', { value: mockStdin as any, configurable: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Object.defineProperty(process, 'stdout', { value: mockStdout as any, configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true });
    Object.defineProperty(process, 'stdout', { value: originalStdout, configurable: true });
  });

  it('calls setRawMode(true) before registering data listener', async () => {
    // Import dynamically inside the test so property overrides are in place.
    const { promptToken } = await import('./auth-wizard.js');
    await promptToken();

    // setRawMode(true) must appear in callOrder before on(data).
    const setRawModeIdx = callOrder.indexOf('setRawMode(true)');
    const onDataIdx = callOrder.indexOf('on(data)');

    expect(setRawModeIdx).toBeGreaterThanOrEqual(0);
    expect(onDataIdx).toBeGreaterThanOrEqual(0);
    expect(setRawModeIdx).toBeLessThan(onDataIdx);
  });

  it('setRawMode(true) is called at least once', async () => {
    const { promptToken } = await import('./auth-wizard.js');
    await promptToken();
    expect(mockStdin.setRawMode).toHaveBeenCalledWith(true);
  });
});
