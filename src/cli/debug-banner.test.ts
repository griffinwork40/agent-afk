/**
 * Tests for src/cli/debug-banner.ts — pure renderer for SessionMetadata.
 * Strips ANSI codes so assertions are color-mode agnostic.
 */

import { describe, it, expect } from 'vitest';
import { renderDebugBanner } from './debug-banner.js';
import type { SessionMetadata } from '../agent/types/session-types.js';

function strip(s: string): string {
  return s.replace(/\x1B\[[0-9;]*m/g, '');
}

describe('renderDebugBanner', () => {
  it('renders a framed block with all populated fields', () => {
    const meta: SessionMetadata = {
      sessionId: 'sess-abc',
      model: 'claude-sonnet-4-6',
      permissionMode: 'bypassPermissions',
      cwd: '/tmp/work',
      claudeCodeVersion: '2.1.114',
      apiKeySource: 'user',
      tools: ['Read', 'Write', 'Edit', 'Bash'],
      mcpServers: [{ name: 'telegram', status: 'connected' }],
      skills: ['spec', 'mint'],
      plugins: [{ name: 'sample-plugin', path: '/plugins/sample-plugin' }],
      slashCommands: ['help', 'debug'],
    };

    const out = strip(renderDebugBanner(meta));
    expect(out).toContain('Session Debug');
    expect(out).toContain('sess-abc');
    expect(out).toContain('claude-sonnet-4-6');
    expect(out).toContain('bypassPermissions');
    expect(out).toContain('/tmp/work');
    expect(out).toContain('v2.1.114');
    expect(out).toContain('tools (4)');
    expect(out).toContain('Read, Write, Edit, Bash');
    expect(out).toContain('mcp (1)');
    expect(out).toContain('telegram[connected]');
    expect(out).toContain('skills (2)');
    expect(out).toContain('plugins (1)');
    expect(out).toContain('sample-plugin');
    expect(out).toContain('slash (2)');
  });

  it('handles empty collections with (none)', () => {
    const meta: SessionMetadata = {
      tools: [],
      mcpServers: [],
      skills: [],
      plugins: [],
      slashCommands: [],
    };
    const out = strip(renderDebugBanner(meta));
    expect(out).toContain('tools (0)');
    expect(out).toContain('mcp (0)');
    expect(out).toContain('skills (0)');
    expect(out).toContain('plugins (0)');
    expect(out).toContain('slash (0)');
    expect(out).toContain('(none)');
  });

  it('omits optional fields that are not present', () => {
    const meta: SessionMetadata = { tools: ['Read'] };
    const out = strip(renderDebugBanner(meta));
    // Section labels that should be absent when their field is missing
    expect(out).not.toContain('session ');
    expect(out).not.toContain('model ');
    expect(out).not.toContain('cwd ');
    expect(out).not.toContain('sdk ');
    // But still prints the framing + tools row
    expect(out).toContain('Session Debug');
    expect(out).toContain('tools (1)');
    expect(out).toContain('Read');
  });

  it('truncates long tool lists with a remainder count', () => {
    const tools = Array.from({ length: 40 }, (_, i) => `tool${i}`);
    const meta: SessionMetadata = { tools };
    const out = strip(renderDebugBanner(meta));
    expect(out).toContain('tools (40)');
    expect(out).toContain('tool0');
    expect(out).toContain('tool29');
    expect(out).toContain('+10 more');
    expect(out).not.toContain('tool30,');
  });
});
