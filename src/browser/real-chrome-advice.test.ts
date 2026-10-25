import { describe, expect, it } from 'vitest';
import {
  MAC_FILES_AND_FOLDERS_URL,
  REMOTE_DEBUGGING_URL,
  adviseRealChrome,
  formatRealChromeAdvice,
} from './real-chrome-advice.js';
import type { RealChromeProbeResult } from './real-chrome-probe.js';

function probe(over: Partial<RealChromeProbeResult>): RealChromeProbeResult {
  return { state: 'ok', channel: 'stable', platform: 'darwin', userDataDir: '/d', ...over };
}

describe('adviseRealChrome', () => {
  it('ok: only the Allow step remains, nothing to open', () => {
    const a = adviseRealChrome(probe({ state: 'ok' }));
    expect(a.headline).toMatch(/remote debugging on/);
    expect(a.steps.join(' ')).toMatch(/Allow/);
    expect(a.openUrl).toBeUndefined();
  });

  it('missing: points at chrome://inspect and opens it on macOS only', () => {
    const mac = adviseRealChrome(probe({ state: 'missing' }));
    expect(mac.steps[0]).toContain(REMOTE_DEBUGGING_URL);
    expect(mac.openUrl).toBe(REMOTE_DEBUGGING_URL);
    expect(adviseRealChrome(probe({ state: 'missing', platform: 'linux' })).openUrl).toBeUndefined();
  });

  it('blocked: names the TCC fix, the channel app, the bundle hint, and the settings pane', () => {
    const a = adviseRealChrome(probe({ state: 'blocked', errorCode: 'EPERM', channel: 'beta', terminalBundleId: 'com.x.term' }));
    expect(a.headline).toMatch(/macOS is blocking access/);
    expect(a.headline).toContain('EPERM');
    expect(a.headline).toContain('#3089');
    const text = a.steps.join('\n');
    expect(text).toContain('Files & Folders');
    expect(text).toContain('"Google Chrome Beta"');
    expect(text).toContain('com.x.term');
    expect(text).toContain(REMOTE_DEBUGGING_URL);
    expect(a.openUrl).toBe(MAC_FILES_AND_FOLDERS_URL);
  });

  it('blocked on Linux: generic permission advice, no macOS-specific text or URL', () => {
    const a = adviseRealChrome(probe({ state: 'blocked', errorCode: 'EACCES', platform: 'linux' }));
    expect(a.headline).toMatch(/Access.*was denied/);
    expect(a.headline).not.toMatch(/macOS/);
    expect(a.headline).toContain('EACCES');
    const text = a.steps.join('\n');
    expect(text).not.toContain('Files & Folders');
    expect(text).not.toContain('System Settings');
    expect(a.openUrl).toBeUndefined();
  });

  it('blocked on Windows: generic permission advice, no macOS-specific text or URL', () => {
    const a = adviseRealChrome(probe({ state: 'blocked', errorCode: 'EPERM', platform: 'win32' }));
    expect(a.headline).toMatch(/Access.*was denied/);
    expect(a.headline).not.toMatch(/macOS/);
    expect(a.openUrl).toBeUndefined();
  });

  it('unknown: lists both causes and distinguishes an unresolvable dir', () => {
    const noDir = adviseRealChrome(probe({ state: 'unknown', userDataDir: null }));
    expect(noDir.headline).toMatch(/Could not locate/);
    const other = adviseRealChrome(probe({ state: 'unknown', errorCode: 'EIO' }));
    expect(other.headline).toContain('EIO');
    expect(other.steps.join(' ')).toMatch(/remote-debugging[\s\S]*Files & Folders/);
  });
});

describe('formatRealChromeAdvice', () => {
  it('renders headline then numbered steps as plain text', () => {
    expect(formatRealChromeAdvice({ headline: 'H', steps: ['a', 'b'] })).toBe('H\n1. a\n2. b');
  });
});
