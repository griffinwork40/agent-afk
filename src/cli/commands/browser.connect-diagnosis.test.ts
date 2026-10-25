import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockExec, mockProbe } = vi.hoisted(() => ({ mockExec: vi.fn(), mockProbe: vi.fn() }));

vi.mock('node:child_process', () => ({ execFileSync: mockExec }));
vi.mock('../../browser/real-chrome-probe.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../browser/real-chrome-probe.js')>()),
  probeRealChrome: mockProbe,
}));
vi.mock('../palette.js', () => ({
  palette: {
    heading: (s: string) => s,
    meta: (s: string) => s,
    success: (s: string) => s,
    warning: (s: string) => s,
  },
}));

import {
  CHROME_DEVTOOLS_MCP_FALLBACK_VERSION,
  printConnectDiagnosis,
  resolveChromeDevtoolsMcpVersion,
} from './browser.connect-diagnosis.js';
import { MAC_FILES_AND_FOLDERS_URL } from '../../browser/real-chrome-advice.js';

const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
const logged = (): string => log.mock.calls.map((c) => String(c[0])).join('\n');

beforeEach(() => {
  mockExec.mockReset();
  mockProbe.mockReset();
  log.mockClear();
});

describe('resolveChromeDevtoolsMcpVersion', () => {
  it('returns the registry version when it is an exact semver', () => {
    mockExec.mockReturnValueOnce('1.12.3\n');
    expect(resolveChromeDevtoolsMcpVersion()).toBe('1.12.3');
    expect(mockExec.mock.calls[0]?.[1]).toEqual(['view', 'chrome-devtools-mcp', 'version']);
  });

  it('falls back when npm fails or prints junk', () => {
    mockExec.mockImplementationOnce(() => { throw new Error('ENOTFOUND'); });
    expect(resolveChromeDevtoolsMcpVersion()).toBe(CHROME_DEVTOOLS_MCP_FALLBACK_VERSION);
    mockExec.mockReturnValueOnce('npm warn something\n1.0.0');
    expect(resolveChromeDevtoolsMcpVersion()).toBe(CHROME_DEVTOOLS_MCP_FALLBACK_VERSION);
  });
});

describe('printConnectDiagnosis', () => {
  const base = { channel: 'stable', userDataDir: '/d' } as const;

  it('prints a ✓ line and opens nothing when ready', () => {
    mockProbe.mockReturnValue({ ...base, state: 'ok', platform: 'darwin' });
    printConnectDiagnosis('stable', true, 'darwin');
    expect(logged()).toMatch(/✓ Google Chrome has remote debugging on/);
    expect(logged()).not.toMatch(/Re-run/);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('prints the TCC fix and opens Files & Folders on macOS when blocked', () => {
    mockProbe.mockReturnValue({ ...base, state: 'blocked', platform: 'darwin', errorCode: 'EPERM' });
    printConnectDiagnosis('stable', true, 'darwin');
    expect(logged()).toMatch(/⚠ macOS is blocking access/);
    expect(logged()).toMatch(/Re-run `afk browser connect`/);
    expect(mockExec).toHaveBeenCalledWith('open', [MAC_FILES_AND_FOLDERS_URL], expect.anything());
    expect(logged()).toMatch(/Opened/);
  });

  it('never shells out to open(1) off macOS', () => {
    mockProbe.mockReturnValue({ ...base, state: 'blocked', platform: 'linux', errorCode: 'EACCES' });
    printConnectDiagnosis('stable', true, 'linux');
    expect(mockProbe).toHaveBeenCalledWith({ channel: 'stable', platform: 'linux' });
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('opens chrome://inspect inside the right Chrome app when missing', () => {
    mockProbe.mockReturnValue({ ...base, channel: 'canary', state: 'missing', platform: 'darwin' });
    printConnectDiagnosis('canary', true, 'darwin');
    expect(mockProbe).toHaveBeenCalledWith({ channel: 'canary', platform: 'darwin' });
    expect(mockExec).toHaveBeenCalledWith(
      'open',
      ['-a', 'Google Chrome Canary', 'chrome://inspect/#remote-debugging'],
      expect.anything(),
    );
  });

  it('respects --no-open', () => {
    mockProbe.mockReturnValue({ ...base, state: 'missing', platform: 'darwin' });
    printConnectDiagnosis('stable', false, 'darwin');
    expect(mockExec).not.toHaveBeenCalled();
    expect(logged()).toMatch(/chrome:\/\/inspect/);
  });

  it('survives open(1) failing', () => {
    mockProbe.mockReturnValue({ ...base, state: 'missing', platform: 'darwin' });
    mockExec.mockImplementation(() => { throw new Error('no open'); });
    expect(() => printConnectDiagnosis('stable', true, 'darwin')).not.toThrow();
    expect(logged()).not.toMatch(/Opened/);
  });
});
