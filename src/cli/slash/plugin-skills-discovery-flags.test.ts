/**
 * #3332 — flags + category flow through skill discovery end-to-end:
 *
 *   SKILL.md → extractPluginSkills (tool-injector) → collectSkillEntries
 *   (skill-bridge) → collectSupportedCommands → registerPluginSkills (REPL)
 *   / registerPluginSkillsForWeb (web) — no second disk walk.
 *
 * Collision contract (deliberate, replaces the old harvest's cross-copy merge):
 * discovery is first-wins by scan order (project → user → bundled → imported),
 * and the WINNING SKILL.md supplies both flags and category. A shadowed
 * same-named copy contributes nothing — no flag union, no category bleed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { useUnsetAfkHome } from '../../__test-utils__/unset-afk-home.js';
import { _resetPluginScanCache } from '../../agent/plugins-scanner.js';
import { collectSkillEntries } from '../../agent/tools/skill-bridge.js';
import { collectSupportedCommands } from '../../agent/providers/shared/supported-commands.js';
import { registerPluginSkills } from './plugin-skills.js';
import { renderSkillDetail } from './plugin-skills/listing-detail.js';
import { lookup, resetRegistry } from './registry.js';
import { evictSkillsByOrigin, registerSkill } from '../../skills/skill-registry.js';
import { stripAnsi } from '../display.js';
import type { SlashContext } from './types.js';

const INLINE_SKILL = `---
name: zz3332-inline
description: "Batch-review open PRs."
category: "Build & ship"
flags: [--auto-merge, --skip-fix, --prs]
---

Prose mentions --not-a-flag.
`;

const BLOCK_SKILL = `---
name: zz3332-block
description: "Tackle issues."
category: Debug & fix
flags:
  - --draft
  - label
---

Body.
`;

const HINT_SKILL = `---
name: zz3332-hint
description: "Review things."
argument-hint: "[--post github] [--light]"
---

Use --staged too.
`;

function writePlugin(root: string, name: string, skills: Record<string, string>): void {
  const plugin = join(root, name);
  mkdirSync(join(plugin, '.claude-plugin'), { recursive: true });
  writeFileSync(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name }));
  for (const [dir, content] of Object.entries(skills)) {
    mkdirSync(join(plugin, 'skills', dir), { recursive: true });
    writeFileSync(join(plugin, 'skills', dir, 'SKILL.md'), content);
  }
}

function makeCtx(): { ctx: SlashContext; lines: string[] } {
  const lines: string[] = [];
  const push = (t = ''): void => void lines.push(t);
  const ctx = {
    session: { current: {} },
    stats: {},
    out: { line: push, raw: push, success: push, info: push, warn: push, error: push },
    ui: { clearScreen: vi.fn(), repaintStatusLine: vi.fn() },
  } as unknown as SlashContext;
  return { ctx, lines };
}

describe('plugin-skill flags + category through discovery (#3332)', () => {
  useUnsetAfkHome();

  let tmpRoot: string;
  let userPlugins: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;

  beforeEach(() => {
    tmpRoot = join(tmpdir(), `afk-3332-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    userPlugins = join(tmpRoot, '.afk', 'plugins');
    writePlugin(userPlugins, 'software-factory', {
      'zz3332-inline': INLINE_SKILL,
      'zz3332-block': BLOCK_SKILL,
      'zz3332-hint': HINT_SKILL,
    });
    originalHome = process.env['HOME'];
    originalUserProfile = process.env['USERPROFILE'];
    process.env['HOME'] = tmpRoot;
    process.env['USERPROFILE'] = tmpRoot;
    _resetPluginScanCache();
    resetRegistry();
  });

  afterEach(() => {
    process.env['HOME'] = originalHome;
    process.env['USERPROFILE'] = originalUserProfile;
    _resetPluginScanCache();
    resetRegistry();
    if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('collectSupportedCommands carries inline/block flags, hint fallback, and category', async () => {
    const byName = new Map((await collectSupportedCommands()).map((c) => [c.name, c]));
    expect(byName.get('zz3332-inline')?.flags).toEqual(['--auto-merge', '--prs', '--skip-fix']);
    expect(byName.get('zz3332-inline')?.category).toBe('Build & ship');
    expect(byName.get('zz3332-block')?.flags).toEqual(['--draft', '--label']);
    expect(byName.get('zz3332-block')?.category).toBe('Debug & fix');
    expect(byName.get('zz3332-hint')?.flags).toEqual(['--light', '--post', '--staged']);
    expect(byName.get('zz3332-hint')?.category).toBeUndefined();
  });

  it('registerPluginSkills attaches discovery flags to the slash command with no harvest walk', async () => {
    const session = { supportedCommands: () => collectSupportedCommands() };
    await registerPluginSkills(session as unknown as Parameters<typeof registerPluginSkills>[0]);
    expect(lookup('/zz3332-inline')?.flags).toEqual(['--auto-merge', '--prs', '--skip-fix']);
    expect(lookup('/zz3332-block')?.flags).toEqual(['--draft', '--label']);
    expect(lookup('/zz3332-hint')?.flags).toEqual(['--light', '--post', '--staged']);
  });

  it('registerPluginSkills trusts command-info flags over what is on disk (single parse)', async () => {
    // The on-disk SKILL.md declares different flags; registration must use the
    // command info verbatim, proving no second SKILL.md parse happens.
    const session = {
      supportedCommands: async () => [
        { name: 'zz3332-inline', description: 'x', flags: ['--from-info'], category: 'Setup & ops' },
        { name: 'zz3332-block', description: 'y' },
      ],
    };
    await registerPluginSkills(session as unknown as Parameters<typeof registerPluginSkills>[0]);
    expect(lookup('/zz3332-inline')?.flags).toEqual(['--from-info']);
    expect(lookup('/zz3332-block')?.flags).toBeUndefined();
    const { state } = await import('./plugin-skills/state.js');
    expect(state.discovered.find((d) => d.name === 'zz3332-inline')?.category).toBe('Setup & ops');
  });

  it('registerPluginSkillsForWeb attaches flags to the web slash menu entry', async () => {
    const { registerPluginSkillsForWeb } = await import('../../web-server/register-plugin-skills.js');
    await registerPluginSkillsForWeb();
    expect(lookup('/zz3332-inline')?.flags).toEqual(['--auto-merge', '--prs', '--skip-fix']);
    expect(lookup('/zz3332-block')?.flags).toEqual(['--draft', '--label']);
  });

  it('first-wins collision: the winning copy supplies flags + category; no union with the shadowed copy', () => {
    const projectDir = join(tmpRoot, 'project');
    writePlugin(join(projectDir, '.afk', 'plugins'), 'proj-plugin', {
      'zz3332-inline': INLINE_SKILL.replace('category: "Build & ship"', 'category: "Review & verify"').replace(
        'flags: [--auto-merge, --skip-fix, --prs]',
        'flags: [--project-only]',
      ),
    });
    _resetPluginScanCache();
    const entry = collectSkillEntries(undefined, { cwd: projectDir }).find((e) => e.name === 'zz3332-inline');
    expect(entry?.flags).toEqual(['--project-only']);
    expect(entry?.category).toBe('Review & verify');
  });

  it('detail card uses discovery flags for a discovered skill', () => {
    const { ctx, lines } = makeCtx();
    renderSkillDetail(
      ctx,
      'zz3332-inline',
      [{ name: 'zz3332-inline', description: 'Batch-review open PRs.', flags: ['--from-discovery'] }],
      false,
    );
    const out = stripAnsi(lines.join('\n'));
    expect(out).toContain('--from-discovery');
    expect(out).not.toContain('--auto-merge');
  });

  it('detail card falls back to the disk walk for skills absent from the command list', () => {
    // A flagless registry skill sharing the bare name, with NO discovered plugin
    // entry (e.g. the boot-time `/skills` card before plugin registration) —
    // the only source left is the retained disk-walk fallback.
    registerSkill({ name: 'zz3332-block', description: 'registry copy', origin: 'user', handler: async () => 'ok' });
    try {
      const { ctx, lines } = makeCtx();
      renderSkillDetail(ctx, 'zz3332-block', [], false);
      const out = stripAnsi(lines.join('\n'));
      expect(out).toContain('Flags');
      expect(out).toContain('--draft, --label');
    } finally {
      evictSkillsByOrigin('user');
    }
  });
});
