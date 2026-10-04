#!/usr/bin/env node
/**
 * Stdio MCP server fixture that IGNORES stdin EOF — used by
 * `stdio-exit-guardian.test.ts`.
 *
 * Same minimal shape as `test-server.mjs` (one `echo` tool), plus a
 * persistent `setInterval` that keeps the event loop alive after the client
 * ends stdin. It therefore only exits when signalled, which is exactly the
 * "stubborn server" the exit guardian exists to clean up. No stdin
 * 'end'/'close' handling on purpose.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer(
  { name: 'agent-afk-stubborn-test-server', version: '0.0.0' },
  { capabilities: { tools: {} } },
);

server.registerTool(
  'echo',
  { description: 'Returns the input text verbatim.', inputSchema: { text: z.string() } },
  async ({ text }) => ({ content: [{ type: 'text', text }] }),
);

setInterval(() => {}, 1000);

const transport = new StdioServerTransport();
await server.connect(transport);
