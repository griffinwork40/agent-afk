import { describe, expect, it, vi } from 'vitest';
import {
  channelFromArgs,
  chromeAppName,
  probeRealChrome,
  resolveChromeUserDataDir,
} from './real-chrome-probe.js';

function errno(code: string): Error {
  return Object.assign(new Error(code), { code });
}

describe('resolveChromeUserDataDir', () => {
  it('maps every macOS channel under Application Support/Google', () => {
    expect(resolveChromeUserDataDir('stable', 'darwin', '/Users/u', undefined)).toBe(
      '/Users/u/Library/Application Support/Google/Chrome',
    );
    expect(resolveChromeUserDataDir('beta', 'darwin', '/Users/u', undefined)).toBe(
      '/Users/u/Library/Application Support/Google/Chrome Beta',
    );
    expect(resolveChromeUserDataDir('canary', 'darwin', '/Users/u', undefined)).toBe(
      '/Users/u/Library/Application Support/Google/Chrome Canary',
    );
    expect(resolveChromeUserDataDir('dev', 'darwin', '/Users/u', undefined)).toBe(
      '/Users/u/Library/Application Support/Google/Chrome Dev',
    );
  });

  it('maps Linux channels under ~/.config', () => {
    expect(resolveChromeUserDataDir('stable', 'linux', '/home/u', undefined)).toBe('/home/u/.config/google-chrome');
    expect(resolveChromeUserDataDir('dev', 'linux', '/home/u', undefined)).toBe('/home/u/.config/google-chrome-unstable');
  });

  it('maps Windows channels under LOCALAPPDATA and needs it set', () => {
    expect(resolveChromeUserDataDir('stable', 'win32', 'C:\\Users\\u', 'C:\\Users\\u\\AppData\\Local')).toBe(
      'C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\User Data',
    );
    expect(resolveChromeUserDataDir('canary', 'win32', 'C:\\Users\\u', 'C:\\L')).toBe('C:\\L\\Google\\Chrome SxS\\User Data');
    expect(resolveChromeUserDataDir('stable', 'win32', 'C:\\Users\\u', undefined)).toBeNull();
  });

  it('returns null on unsupported platforms', () => {
    expect(resolveChromeUserDataDir('stable', 'aix', '/home/u', undefined)).toBeNull();
  });
});

describe('probeRealChrome', () => {
  const base = { platform: 'darwin' as const, home: '/Users/u', terminalBundleId: 'com.example.term' };

  it('touches only DevToolsActivePort and reports ok when it opens', () => {
    const touchFile = vi.fn();
    const r = probeRealChrome({ ...base, touchFile });
    expect(touchFile).toHaveBeenCalledTimes(1);
    expect(touchFile).toHaveBeenCalledWith('/Users/u/Library/Application Support/Google/Chrome/DevToolsActivePort');
    expect(r).toMatchObject({ state: 'ok', channel: 'stable', terminalBundleId: 'com.example.term' });
    expect(r.errorCode).toBeUndefined();
  });

  it.each([
    ['ENOENT', 'missing'],
    ['ENOTDIR', 'missing'],
    ['EPERM', 'blocked'],
    ['EACCES', 'blocked'],
    ['EIO', 'unknown'],
  ])('classifies %s as %s', (code, state) => {
    const r = probeRealChrome({ ...base, touchFile: () => { throw errno(code); } });
    expect(r.state).toBe(state);
    expect(r.errorCode).toBe(code);
  });

  it('reports unknown without touching anything when the dir is unresolvable', () => {
    const touchFile = vi.fn();
    const r = probeRealChrome({ platform: 'win32', home: 'C:\\u', localAppData: '', touchFile });
    expect(r.state).toBe('unknown');
    expect(r.userDataDir).toBeNull();
    expect(touchFile).not.toHaveBeenCalled();
  });

  it('omits the bundle id hint off macOS', () => {
    const r = probeRealChrome({ platform: 'linux', home: '/home/u', terminalBundleId: 'x', touchFile: () => undefined });
    expect(r.terminalBundleId).toBeUndefined();
  });

  it('never throws, even when the error has no code', () => {
    const r = probeRealChrome({ ...base, touchFile: () => { throw new Error('boom'); } });
    expect(r.state).toBe('unknown');
  });
});

describe('channelFromArgs / chromeAppName', () => {
  it('parses --channel and defaults to stable', () => {
    expect(channelFromArgs(['chrome-devtools-mcp@1.0.0', '--autoConnect', '--channel', 'canary'])).toBe('canary');
    expect(channelFromArgs(['chrome-devtools-mcp@1.0.0', '--autoConnect'])).toBe('stable');
    expect(channelFromArgs(['--channel', 'bogus'])).toBe('stable');
    expect(channelFromArgs(undefined)).toBe('stable');
  });

  it('names the app as macOS Files & Folders lists it', () => {
    expect(chromeAppName('stable')).toBe('Google Chrome');
    expect(chromeAppName('canary')).toBe('Google Chrome Canary');
  });
});
