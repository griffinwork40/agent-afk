/**
 * Wiring test: McpClient.callTool runs MCP error hints on BOTH failure paths.
 * chrome-devtools-mcp reports "Could not find DevToolsActivePort" as an
 * `isError` RESULT (not a throw), so the hint must run after normalization.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../browser/real-chrome-probe.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../browser/real-chrome-probe.js')>();
  return {
    ...actual,
    probeRealChrome: vi.fn(() => ({
      state: 'blocked',
      channel: 'stable',
      platform: 'darwin',
      userDataDir: '/d',
      errorCode: 'EPERM',
    })),
  };
});

import { McpClient } from './client.js';

const ERR = 'Could not connect to Chrome.\nCause: Could not find DevToolsActivePort for chrome at /d/DevToolsActivePort';
const config = { command: 'npx', args: ['chrome-devtools-mcp@1.11.0', '--autoConnect'] };

function clientWith(callTool: () => Promise<unknown>): McpClient {
  const c = new McpClient('chrome-devtools', config);
  // Inject a connected SDK client without a real transport.
  (c as unknown as { client: unknown }).client = { callTool };
  return c;
}

describe('McpClient.callTool error hints', () => {
  it('appends the diagnosis to an isError result', async () => {
    const c = clientWith(async () => ({ content: [{ type: 'text', text: ERR }], isError: true }));
    const out = await c.callTool('list_pages', {}, new AbortController().signal);
    expect(out.isError).toBe(true);
    expect(out.content).toContain(ERR);
    expect(out.content).toContain('[afk diagnosis]');
    expect(out.content).toContain('Files & Folders');
  });

  it('appends the diagnosis when the SDK call throws', async () => {
    const c = clientWith(async () => { throw new Error(ERR); });
    const out = await c.callTool('list_pages', {}, new AbortController().signal);
    expect(out.content).toMatch(/^MCP tool "chrome-devtools\.list_pages" failed:/);
    expect(out.content).toContain('[afk diagnosis]');
  });

  it('leaves successful results untouched', async () => {
    const c = clientWith(async () => ({ content: [{ type: 'text', text: 'Pages: 1' }] }));
    const out = await c.callTool('list_pages', {}, new AbortController().signal);
    expect(out).toEqual({ content: 'Pages: 1' });
  });
});
