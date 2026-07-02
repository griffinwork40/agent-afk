/**
 * Unit tests for the browser opener.
 *
 * Security-critical property (regression guard): the file path is passed as a
 * discrete argv element via execFile — never interpolated into a shell command
 * string. A shell would re-parse metacharacters, so a path containing
 * `$(...)`, backticks, `;`, `|`, or `&` must NOT be able to execute commands.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

import { execFile } from 'node:child_process';
import { openInBrowser } from './open.js';

const mockExecFile = vi.mocked(execFile);

describe('openInBrowser', () => {
  beforeEach(() => {
    mockExecFile.mockReset();
    mockExecFile.mockReturnValue({
      unref: vi.fn(),
    } as unknown as ReturnType<typeof execFile>);
  });

  it('passes the file path as a discrete argv element, not a shell string', () => {
    const payload = '/tmp/x$(touch /tmp/pwn)`whoami`;rm -rf ~/y.html';
    openInBrowser(payload);

    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const call = mockExecFile.mock.calls[0]!;
    const bin = call[0] as string;
    const args = call[1] as string[];

    // The binary is a fixed opener — never a command string built from the path.
    expect(['open', 'xdg-open', 'cmd']).toContain(bin);
    expect(bin).not.toContain('$(');
    expect(bin).not.toContain(payload);

    // The path appears verbatim as its own argv element; the shell never
    // re-parses it, so `$(...)` / backticks / `;` cannot execute.
    expect(args).toContain(payload);
    // No single arg smuggles the path inside a larger interpolated string.
    expect(args.some((a) => a !== payload && a.includes(payload))).toBe(false);
  });

  it("unref's the spawned child so the CLI can exit immediately", () => {
    const unref = vi.fn();
    mockExecFile.mockReturnValue({
      unref,
    } as unknown as ReturnType<typeof execFile>);

    openInBrowser('/tmp/report.html');
    expect(unref).toHaveBeenCalledTimes(1);
  });

  it('swallows synchronous spawn failures — best-effort, never crashes the CLI', () => {
    mockExecFile.mockImplementation(() => {
      throw new Error('spawn ENOENT');
    });
    expect(() => openInBrowser('/tmp/report.html')).not.toThrow();
  });
});
