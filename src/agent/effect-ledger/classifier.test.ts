/**
 * Unit tests for the tool-call classifier.
 */

import { describe, it, expect } from 'vitest';
import { classifyToolCall } from './classifier.js';

// ---------------------------------------------------------------------------
// Always-external tools
// ---------------------------------------------------------------------------

describe('classifyToolCall — always-external tools', () => {
  it('send_telegram is always external', () => {
    const c = classifyToolCall('send_telegram', { message: 'hi' });
    expect(c.isExternal).toBe(true);
    expect(c.operationType).toBe('send_telegram');
  });

  it('mcp__ prefixed tools are external', () => {
    const c = classifyToolCall('mcp__github__create_issue', {});
    expect(c.isExternal).toBe(true);
    expect(c.operationType).toBe('mcp_write');
  });

  it('MCP__ prefixed tools are external (uppercase)', () => {
    const c = classifyToolCall('MCP__someserver__write', {});
    expect(c.isExternal).toBe(true);
    expect(c.operationType).toBe('mcp_write');
  });
});

// ---------------------------------------------------------------------------
// Bash — external patterns
// ---------------------------------------------------------------------------

describe('classifyToolCall — bash external patterns', () => {
  it('gh pr create is external', () => {
    const c = classifyToolCall('bash', { command: 'gh pr create --title "My PR"' });
    expect(c.isExternal).toBe(true);
    expect(c.operationType).toBe('bash_external');
  });

  it('gh issue create is external', () => {
    const c = classifyToolCall('bash', { command: 'gh issue create --title "Bug"' });
    expect(c.isExternal).toBe(true);
  });

  it('gh release create is external', () => {
    const c = classifyToolCall('bash', { command: 'gh release create v1.0.0' });
    expect(c.isExternal).toBe(true);
  });

  it('git push is external', () => {
    const c = classifyToolCall('bash', { command: 'git push origin main' });
    expect(c.isExternal).toBe(true);
  });

  it('git push --force is external', () => {
    const c = classifyToolCall('bash', { command: 'git push --force origin my-branch' });
    expect(c.isExternal).toBe(true);
  });

  it('curl POST is external', () => {
    const c = classifyToolCall('bash', { command: 'curl -X POST https://api.example.com/webhook -d \'{"event":"test"}\'' });
    expect(c.isExternal).toBe(true);
  });

  it('curl --data is external', () => {
    const c = classifyToolCall('bash', { command: 'curl --data \'payload\' https://api.example.com/' });
    expect(c.isExternal).toBe(true);
  });

  it('pnpm publish is external', () => {
    const c = classifyToolCall('bash', { command: 'pnpm publish --access public' });
    expect(c.isExternal).toBe(true);
  });

  it('npm publish is external', () => {
    const c = classifyToolCall('bash', { command: 'npm publish' });
    expect(c.isExternal).toBe(true);
  });

  it('docker push is external', () => {
    const c = classifyToolCall('bash', { command: 'docker push myimage:latest' });
    expect(c.isExternal).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Bash — NOT external
// ---------------------------------------------------------------------------

describe('classifyToolCall — bash not external', () => {
  it('git commit is not external', () => {
    const c = classifyToolCall('bash', { command: 'git commit -m "feat: add tests"' });
    expect(c.isExternal).toBe(false);
  });

  it('git status is not external', () => {
    const c = classifyToolCall('bash', { command: 'git status' });
    expect(c.isExternal).toBe(false);
  });

  it('ls command is not external', () => {
    const c = classifyToolCall('bash', { command: 'ls -la' });
    expect(c.isExternal).toBe(false);
  });

  it('curl GET (no -d / -X POST) is not external', () => {
    const c = classifyToolCall('bash', { command: 'curl https://api.example.com/status' });
    expect(c.isExternal).toBe(false);
  });

  it('pnpm test is not external', () => {
    const c = classifyToolCall('bash', { command: 'pnpm test' });
    expect(c.isExternal).toBe(false);
  });

  it('handles missing command field gracefully', () => {
    const c = classifyToolCall('bash', { notCommand: 'foo' });
    expect(c.isExternal).toBe(false);
  });

  it('handles null input gracefully', () => {
    const c = classifyToolCall('bash', null);
    expect(c.isExternal).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// browser_act
// ---------------------------------------------------------------------------

describe('classifyToolCall — browser_act', () => {
  it('click is external', () => {
    const c = classifyToolCall('browser_act', { action: 'click', target: { kind: 'semantic', text: 'Submit' } });
    expect(c.isExternal).toBe(true);
    expect(c.operationType).toBe('browser_act_external');
  });

  it('fill is external', () => {
    const c = classifyToolCall('browser_act', { action: 'fill', target: { kind: 'semantic', text: 'Email' }, value: 'test@example.com' });
    expect(c.isExternal).toBe(true);
  });

  it('scroll_to is not external', () => {
    const c = classifyToolCall('browser_act', { action: 'scroll_to', target: { kind: 'semantic', text: 'Footer' } });
    expect(c.isExternal).toBe(false);
  });

  it('hover is not external', () => {
    const c = classifyToolCall('browser_act', { action: 'hover', target: { kind: 'semantic', text: 'Menu' } });
    expect(c.isExternal).toBe(false);
  });

  it('wait_for is not external', () => {
    const c = classifyToolCall('browser_act', { action: 'wait_for', target: { kind: 'semantic', text: 'Spinner' } });
    expect(c.isExternal).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Read/write/shell tools — not external
// ---------------------------------------------------------------------------

describe('classifyToolCall — non-external tools', () => {
  it('read_file is not external', () => {
    expect(classifyToolCall('read_file', { file_path: '/tmp/foo.ts' }).isExternal).toBe(false);
  });

  it('write_file is not external', () => {
    expect(classifyToolCall('write_file', { file_path: '/tmp/foo.ts', content: '' }).isExternal).toBe(false);
  });

  it('edit_file is not external', () => {
    expect(classifyToolCall('edit_file', {}).isExternal).toBe(false);
  });

  it('glob is not external', () => {
    expect(classifyToolCall('glob', { pattern: '**/*.ts' }).isExternal).toBe(false);
  });

  it('agent is not external', () => {
    expect(classifyToolCall('agent', { prompt: 'do something' }).isExternal).toBe(false);
  });

  it('unknown tool is not external', () => {
    expect(classifyToolCall('some_custom_tool', {}).isExternal).toBe(false);
  });
});
