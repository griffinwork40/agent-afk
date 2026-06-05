/**
 * Integration test for `McpManager` against a hand-rolled stdio MCP server
 * fixture (`__fixtures__/test-server.mjs`). The fixture exposes three
 * deterministic tools: `echo`, `add`, `boom`.
 *
 * What this test proves end-to-end:
 *   - `McpManager.fromConfig()` spawns the child via stdio transport,
 *     completes the handshake, and surfaces tools as `mcp__<server>__<tool>`.
 *   - `getMcpTools()` returns Anthropic-shaped schemas with `input_schema`.
 *   - `getMcpHandlers()` exposes a working `ToolHandler` per tool.
 *   - A tool call returns the expected text content.
 *   - `isError: true` propagates through the normalizer.
 *   - `disconnectAll()` tears down child processes cleanly.
 *
 * Q3 decision: this is the in-test fixture path. `server-everything` lands
 * in PR 2/3 as a real-world conformance test.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { McpManager } from './manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, '__fixtures__/test-server.mjs');

let manager: McpManager | undefined;

afterEach(async () => {
  if (manager) {
    await manager.disconnectAll();
    manager = undefined;
  }
});

describe('McpManager (integration: stdio fixture)', () => {
  it(
    'connects, lists tools, and routes calls through the bridged handler',
    async () => {
      manager = await McpManager.fromConfig({
        testsrv: {
          type: 'stdio',
          command: process.execPath, // node
          args: [FIXTURE],
        },
      });

      const states = manager.getServerStates();
      expect(states.length).toBe(1);
      expect(states[0]!.status).toBe('connected');
      expect(states[0]!.toolCount).toBe(3);

      const schemas = manager.getMcpTools();
      const names = schemas.map((s) => s.name).sort();
      expect(names).toEqual([
        'mcp__testsrv__add',
        'mcp__testsrv__boom',
        'mcp__testsrv__echo',
      ]);

      // input_schema is JSON-Schema-shaped (carried over verbatim from
      // the server's Zod-derived inputSchema).
      const echoSchema = schemas.find((s) => s.name === 'mcp__testsrv__echo')!;
      expect(echoSchema.input_schema.type).toBe('object');

      const handlers = manager.getMcpHandlers();
      expect(handlers.size).toBe(3);
      const echoHandler = handlers.get('mcp__testsrv__echo')!;

      const ac = new AbortController();
      const result = await echoHandler({ text: 'hello world' }, ac.signal);
      expect(result.isError).toBeFalsy();
      expect(result.content).toContain('hello world');
    },
    { timeout: 15_000 },
  );

  it(
    'returns isError=true when the server reports a tool failure',
    async () => {
      manager = await McpManager.fromConfig({
        testsrv: {
          type: 'stdio',
          command: process.execPath,
          args: [FIXTURE],
        },
      });

      const boomHandler = manager.getMcpHandlers().get('mcp__testsrv__boom')!;
      const ac = new AbortController();
      const result = await boomHandler({}, ac.signal);
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/boom/);
    },
    { timeout: 15_000 },
  );

  it(
    'passes structured args through to the server',
    async () => {
      manager = await McpManager.fromConfig({
        testsrv: {
          type: 'stdio',
          command: process.execPath,
          args: [FIXTURE],
        },
      });

      const addHandler = manager.getMcpHandlers().get('mcp__testsrv__add')!;
      const ac = new AbortController();
      const result = await addHandler({ a: 7, b: 35 }, ac.signal);
      expect(result.isError).toBeFalsy();
      expect(result.content.trim()).toBe('42');
    },
    { timeout: 15_000 },
  );

  it(
    'marks a server as `error` when it fails to spawn and continues with the rest',
    async () => {
      manager = await McpManager.fromConfig({
        good: {
          type: 'stdio',
          command: process.execPath,
          args: [FIXTURE],
        },
        bad: {
          type: 'stdio',
          // Use a path that's guaranteed to not exist so spawn rejects.
          command: '/this/path/does/not/exist-mcp',
        },
      });

      const states = manager.getServerStates();
      const byName = new Map(states.map((s) => [s.serverName, s]));
      expect(byName.get('good')?.status).toBe('connected');
      expect(byName.get('bad')?.status).toBe('error');
      expect(byName.get('bad')?.error).toBeTruthy();

      // Good server's tools are still bridged.
      expect(manager.getMcpToolWireNames().sort()).toEqual([
        'mcp__good__add',
        'mcp__good__boom',
        'mcp__good__echo',
      ]);
    },
    { timeout: 15_000 },
  );

  it(
    'throws when an alwaysLoad server fails',
    async () => {
      let caught: unknown;
      try {
        manager = await McpManager.fromConfig({
          required: {
            type: 'stdio',
            command: '/this/path/does/not/exist-mcp',
            alwaysLoad: true,
          },
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toMatch(/alwaysLoad/);
      // manager is undefined here; afterEach is a no-op.
    },
    { timeout: 10_000 },
  );

  it(
    'skips disabled servers without spawning them',
    async () => {
      manager = await McpManager.fromConfig({
        off: {
          type: 'stdio',
          command: '/this/should/never/be/invoked',
          disabled: true,
        },
      });
      const states = manager.getServerStates();
      expect(states.length).toBe(1);
      expect(states[0]!.status).toBe('disabled');
      expect(manager.getMcpTools()).toEqual([]);
      expect(manager.getMcpHandlers().size).toBe(0);
    },
    { timeout: 5_000 },
  );
});
