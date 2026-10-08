/**
 * Tests for the platform-dispatch factory `serviceManagerFor`. Follows the
 * clipboard.ts model: platform is an injected argument, so each branch is
 * asserted deterministically without stubbing `process.platform`.
 */

import { describe, expect, it } from 'vitest';
import { serviceManagerFor } from './index.js';

describe('serviceManagerFor', () => {
  it('selects the launchd backend on darwin', () => {
    const mgr = serviceManagerFor('darwin');
    expect(mgr).not.toBeNull();
    expect(mgr?.backend).toBe('launchd');
    expect(mgr?.configKind).toBe('LaunchAgent plist');
  });

  it('selects the systemd backend on linux', () => {
    const mgr = serviceManagerFor('linux');
    expect(mgr).not.toBeNull();
    expect(mgr?.backend).toBe('systemd');
    expect(mgr?.configKind).toBe('systemd user unit');
  });

  it('selects the task-scheduler backend on win32', () => {
    const mgr = serviceManagerFor('win32');
    expect(mgr).not.toBeNull();
    expect(mgr?.backend).toBe('task-scheduler');
    expect(mgr?.configKind).toBe('Task Scheduler task');
  });

  it('returns null for an unsupported platform (freebsd)', () => {
    expect(serviceManagerFor('freebsd')).toBeNull();
  });

  it('exposes the same neutral label/path surface on all backends', () => {
    const launchd = serviceManagerFor('darwin');
    const systemd = serviceManagerFor('linux');
    const win = serviceManagerFor('win32');
    // launchd: reverse-DNS label + LaunchAgents plist path.
    expect(launchd?.label('telegram')).toBe('com.afk.telegram');
    // Normalize backslashes for Windows CI (paths use homedir() + join()).
    expect(launchd?.configPath('telegram').replace(/\\/g, '/')).toContain('Library/LaunchAgents/com.afk.telegram.plist');
    // systemd: unit-name label + user-unit path.
    expect(systemd?.label('telegram')).toBe('afk-telegram.service');
    expect(systemd?.configPath('telegram').replace(/\\/g, '/')).toContain('.config/systemd/user/afk-telegram.service');
    // windows: AFK-<name> label + afk home service dir (ends with service/AFK-telegram.xml).
    expect(win?.label('telegram')).toBe('AFK-telegram');
    const winPath = win?.configPath('telegram').replace(/\\/g, '/') ?? '';
    expect(winPath).toMatch(/service\/AFK-telegram\.xml$/);
  });
});
