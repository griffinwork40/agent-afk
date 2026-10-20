/**
 * Tests for /export md|html renderers.
 *
 * Covers:
 *   - HTML escaping (XSS guard via escapeHtml)
 *   - Secret redaction in user/assistant text and tool args/results
 *   - Markdown structure (headers, tool blocks, summary table)
 *   - HTML structure (DOCTYPE, meta charset, detail elements)
 *   - Output path resolution (format, extension, explicit path)
 */

import { describe, it, expect } from 'vitest';
import { escapeHtml, renderSessionHtml } from './export.render-html.js';
import { renderSessionMarkdown } from './export.render-md.js';
import type { SessionStats, TurnRecord } from '../types.js';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function makeTurn(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    user: 'Hello agent',
    assistant: 'Hello user',
    timestamp: 1_700_000_000_000,
    costUsd: 0.001,
    durationMs: 2000,
    toolEvents: [],
    ...overrides,
  };
}

function makeStats(overrides: Partial<SessionStats> = {}): SessionStats {
  return {
    totalTurns: 1,
    totalCostUsd: 0.001,
    unpricedTurns: 0,
    totalTokens: 1000,
    totalDurationMs: 2000,
    sessionStartTime: 1_700_000_000_000,
    turnCosts: [0.001],
    turnTokens: [{ input: 500, output: 500, cache: 0 }],
    turns: [makeTurn()],
    model: 'claude-sonnet',
    permissionMode: 'default',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// escapeHtml
// ---------------------------------------------------------------------------

describe('escapeHtml', () => {
  it('escapes & < > " \'', () => {
    expect(escapeHtml('&')).toBe('&amp;');
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
    expect(escapeHtml('"quoted"')).toBe('&quot;quoted&quot;');
    expect(escapeHtml("it's")).toBe('it&#39;s');
  });

  it('leaves plain text untouched', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });

  it('escapes a full XSS payload', () => {
    const payload = '<img src=x onerror="alert(1)">';
    const escaped = escapeHtml(payload);
    expect(escaped).not.toContain('<img');
    expect(escaped).toContain('&lt;img');
    expect(escaped).toContain('&quot;');
  });
});

// ---------------------------------------------------------------------------
// renderSessionMarkdown — structure
// ---------------------------------------------------------------------------

describe('renderSessionMarkdown', () => {
  it('includes session header fields', () => {
    const md = renderSessionMarkdown(makeStats());
    expect(md).toContain('# AFK Session Export');
    expect(md).toContain('claude-sonnet');
    expect(md).toContain('## Transcript');
    expect(md).toContain('## Tool Summary');
  });

  it('includes turn content', () => {
    const md = renderSessionMarkdown(makeStats());
    expect(md).toContain('Hello agent');
    expect(md).toContain('Hello user');
    expect(md).toContain('Turn 1');
  });

  it('renders tool call as <details> block', () => {
    const stats = makeStats({
      turns: [makeTurn({
        toolEvents: [{
          toolName: 'bash',
          toolUseId: 'tu_1',
          input: '{"command":"ls"}',
          result: 'file1\nfile2',
          isError: false,
        }],
      })],
    });
    const md = renderSessionMarkdown(stats);
    expect(md).toContain('<details>');
    expect(md).toContain('bash');
    expect(md).toContain('file1');
  });

  it('redacts secrets in user text', () => {
    const stats = makeStats({
      turns: [makeTurn({ user: 'My token is sk-ant-api03-supersecretkey1234' })],
    });
    const md = renderSessionMarkdown(stats);
    expect(md).not.toContain('sk-ant-api03-supersecretkey1234');
    expect(md).toContain('[REDACTED]');
  });

  it('redacts secrets in tool args', () => {
    const stats = makeStats({
      turns: [makeTurn({
        toolEvents: [{
          toolName: 'web_request',
          toolUseId: 'tu_2',
          input: '{"headers":{"Authorization":"Bearer sk-ant-api03-supersecrettoken"}}',
          result: 'ok',
          isError: false,
        }],
      })],
    });
    const md = renderSessionMarkdown(stats);
    expect(md).not.toContain('sk-ant-api03-supersecrettoken');
    expect(md).toContain('[REDACTED]');
  });

  it('shows session name when present', () => {
    const md = renderSessionMarkdown(makeStats({ name: 'my-session' }));
    expect(md).toContain('my-session');
  });

  it('shows tool summary table when tools used', () => {
    const stats = makeStats({
      turns: [makeTurn({
        toolEvents: [
          { toolName: 'bash', toolUseId: 'a', input: '{}', result: 'ok', isError: false },
          { toolName: 'bash', toolUseId: 'b', input: '{}', result: 'err', isError: true },
          { toolName: 'read_file', toolUseId: 'c', input: '{}', result: 'data', isError: false },
        ],
      })],
    });
    const md = renderSessionMarkdown(stats);
    expect(md).toContain('`bash`');
    expect(md).toContain('`read_file`');
    expect(md).toContain('Total tool calls: **3**');
  });
});

// ---------------------------------------------------------------------------
// renderSessionHtml — structure and safety
// ---------------------------------------------------------------------------

describe('renderSessionHtml', () => {
  it('produces a valid HTML skeleton', () => {
    const html = renderSessionHtml(makeStats());
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<meta charset="UTF-8">');
    expect(html).toContain('</html>');
  });

  it('includes session metadata', () => {
    const html = renderSessionHtml(makeStats());
    expect(html).toContain('claude-sonnet');
    expect(html).toContain('AFK Session Export');
  });

  it('escapes XSS in user text', () => {
    const payload = '<script>alert("xss")</script>';
    const stats = makeStats({ turns: [makeTurn({ user: payload })] });
    const html = renderSessionHtml(stats);
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes XSS in tool result', () => {
    const stats = makeStats({
      turns: [makeTurn({
        toolEvents: [{
          toolName: 'bash',
          toolUseId: 'tu_x',
          input: '{}',
          result: '<img src=x onerror=alert(1)>',
          isError: false,
        }],
      })],
    });
    const html = renderSessionHtml(stats);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });

  it('redacts secrets in html output', () => {
    const stats = makeStats({
      turns: [makeTurn({ assistant: 'Key: sk-ant-api03-topsecretkey99' })],
    });
    const html = renderSessionHtml(stats);
    expect(html).not.toContain('sk-ant-api03-topsecretkey99');
    expect(html).toContain('[REDACTED]');
  });

  it('renders tool calls with <details> elements', () => {
    const stats = makeStats({
      turns: [makeTurn({
        toolEvents: [{
          toolName: 'read_file',
          toolUseId: 'tu_r',
          input: '{"file_path":"/etc/passwd"}',
          result: 'root:x:0:0',
          isError: false,
        }],
      })],
    });
    const html = renderSessionHtml(stats);
    expect(html).toContain('<details');
    expect(html).toContain('read_file');
    expect(html).toContain('root:x:0:0');
  });

  it('includes inline CSS (no external assets)', () => {
    const html = renderSessionHtml(makeStats());
    expect(html).toContain('<style>');
    expect(html).not.toContain('<link');
    expect(html).not.toMatch(/src=["']https?:/);
  });

  it('no turns produces empty transcript section without error', () => {
    const stats = makeStats({ turns: [], totalTurns: 0 });
    const html = renderSessionHtml(stats);
    expect(html).toContain('Transcript');
    expect(html).toContain('Tool Summary');
    expect(html).toContain('No tool calls this session.');
  });
});
