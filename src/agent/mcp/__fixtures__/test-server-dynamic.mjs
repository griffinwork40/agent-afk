#!/usr/bin/env node
/**
 * Stdio MCP server fixture for the `notifications/tools/list_changed`
 * refresh path test (`manager.refresh.test.ts`).
 *
 * Starts with one tool (`ping`) and dynamically registers a second tool
 * (`pong`) when the controller sends the literal line `ADD_POOL\n` on the
 * **control pipe** (FD 3, opened via `stdio: ['pipe','pipe','inherit','pipe']`
 * — note FD 3 is _read-only_ from the parent's perspective and _write-only_
 * from the child's; this fixture reads it as FD 3 = stdin replacement).
 *
 * Wait — Node doesn't expose extra stdio FDs as readable streams trivially
 * from a `.mjs` without `process.stdin.fd` games. We sidestep that: the
 * fixture uses a polling watch on a sentinel file path passed via
 * `process.env.MCP_FIXTURE_TRIGGER_FILE`. When the file appears, the
 * second tool is registered and `sendToolListChanged()` is fired.
 *
 * Constraint (externally-governed — stdio JSON-RPC framing):
 * we MUST NOT write to stdout outside of the SDK's framing. Any debug
 * output goes to stderr.
 *
 * Why file-based: it sidesteps stdio FD allocation entirely (the SDK owns
 * the stdio transport), keeps the fixture a single .mjs, and lets the test
 * orchestrate the timing deterministically by `fs.writeFileSync(triggerPath, '')`.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { existsSync, watch } from 'node:fs';

const server = new McpServer(
  { name: 'agent-afk-test-server-dynamic', version: '0.0.0' },
  // Declare the listChanged capability so the SDK actually emits the
  // notification when `sendToolListChanged()` is called. Without this,
  // the SDK throws assertNotificationCapability on send.
  { capabilities: { tools: { listChanged: true } } },
);

server.registerTool(
  'ping',
  { description: 'Returns "pong"', inputSchema: {} },
  async () => ({ content: [{ type: 'text', text: 'pong' }] }),
);

const triggerPath = process.env.MCP_FIXTURE_TRIGGER_FILE;
if (!triggerPath) {
  // Test misuse — abort with stderr so the test surfaces it cleanly.
  process.stderr.write('test-server-dynamic: MCP_FIXTURE_TRIGGER_FILE not set\n');
  process.exit(2);
}

let triggered = false;
function maybeTrigger() {
  if (triggered) return;
  if (!existsSync(triggerPath)) return;
  triggered = true;
  server.registerTool(
    'pong',
    { description: 'Returns "ping"', inputSchema: {} },
    async () => ({ content: [{ type: 'text', text: 'ping' }] }),
  );
  // Fire-and-forget — the test waits on `onToolsRefreshed` to know it landed.
  server.server.sendToolListChanged().catch((err) => {
    process.stderr.write(`sendToolListChanged failed: ${err?.message ?? err}\n`);
  });
}

// Poll: the file may already exist at startup, or appear later. The poll
// interval is short because the test only waits ~1s before timing out.
const POLL_MS = 50;
const poller = setInterval(maybeTrigger, POLL_MS);
// Also watch the parent dir to react instantly on most platforms.
try {
  const dir = triggerPath.substring(0, triggerPath.lastIndexOf('/')) || '.';
  watch(dir, { persistent: false }, maybeTrigger);
} catch {
  // Watch is best-effort — the polling loop covers all platforms.
}

process.on('exit', () => clearInterval(poller));

const transport = new StdioServerTransport();
await server.connect(transport);
