/**
 * Tests that desktop_* tools are excluded from CHILD_ALLOWED_TOOLS.
 *
 * Integration-risk I1 from integration-risk-computer-use.md requires that
 * desktop tools are excluded from the child allowlist by default: "Desktop
 * tools are excluded from the child allowlist by default; any delegation is
 * explicit and single-owner."
 *
 * Note: desktop_screenshot is opt-in (AFK_DESKTOP_ENABLED) and is NOT in
 * BUILTIN_TOOL_NAMES. The desktop group is enumerated via toolGroups() which
 * uses ALL_TOOL_SCHEMAS — the closed-world set that includes opt-in tools.
 *
 * @module agent/tools/desktop-nesting.test
 */

import { describe, it, expect } from 'vitest';
import { CHILD_ALLOWED_TOOLS, RECON_ALLOWED_TOOLS } from './nesting.js';
import { toolGroups } from './operator-denied.js';

describe('desktop tools are excluded from child allowlists', () => {
  const desktopTools = toolGroups()['desktop'] ?? [];

  it('there is at least one desktop tool registered (desktop_screenshot)', () => {
    expect(desktopTools).toContain('desktop_screenshot');
  });

  it('no desktop_* tool appears in CHILD_ALLOWED_TOOLS', () => {
    for (const tool of desktopTools) {
      expect(CHILD_ALLOWED_TOOLS, `${tool} must not be in CHILD_ALLOWED_TOOLS`).not.toContain(tool);
    }
  });

  it('no desktop_* tool appears in RECON_ALLOWED_TOOLS', () => {
    for (const tool of desktopTools) {
      expect(RECON_ALLOWED_TOOLS, `${tool} must not be in RECON_ALLOWED_TOOLS`).not.toContain(tool);
    }
  });
});
