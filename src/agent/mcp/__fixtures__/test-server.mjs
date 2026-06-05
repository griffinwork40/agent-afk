#!/usr/bin/env node
/**
 * Minimal stdio MCP server used by `manager.test.ts` for the
 * end-to-end PR 1 integration test.
 *
 * Exposes three deterministic tools:
 *   - `echo`     — returns `{ text }` verbatim
 *   - `add`      — returns the sum of `{ a, b }`
 *   - `boom`     — always responds with `isError: true` for negative-path tests
 *
 * Stays a `.mjs` (no TS) so the test can spawn it via plain `node` without
 * needing tsx in the integration path.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer(
  { name: 'agent-afk-test-server', version: '0.0.0' },
  { capabilities: { tools: {} } },
);

server.registerTool(
  'echo',
  {
    description: 'Returns the input text verbatim.',
    inputSchema: { text: z.string() },
  },
  async ({ text }) => ({
    content: [{ type: 'text', text }],
  }),
);

server.registerTool(
  'add',
  {
    description: 'Returns the sum of two integers.',
    inputSchema: { a: z.number(), b: z.number() },
  },
  async ({ a, b }) => ({
    content: [{ type: 'text', text: String(a + b) }],
  }),
);

server.registerTool(
  'boom',
  {
    description: 'Always errors. Used to validate isError propagation.',
    inputSchema: {},
  },
  async () => ({
    content: [{ type: 'text', text: 'boom intentionally failed' }],
    isError: true,
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
