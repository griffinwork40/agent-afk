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

  it('returns null for an unsupported platform (win32)', () => {
    expect(serviceManagerFor('win32')).toBeNull();
  });

  it('exposes the same neutral label/path surface on both backends', () => {
    const launchd = serviceManagerFor('darwin');
    const systemd = serviceManagerFor('linux');
    // launchd: reverse-DNS label + LaunchAgents plist path.
    expect(launchd?.label('telegram')).toBe('com.afk.telegram');
    expect(launchd?.configPath('telegram')).toContain('Library/LaunchAgents/com.afk.telegram.plist');
    // systemd: unit-name label + user-unit path.
    expect(systemd?.label('telegram')).toBe('afk-telegram.service');
    expect(systemd?.configPath('telegram')).toContain('.config/systemd/user/afk-telegram.service');
  });
});
