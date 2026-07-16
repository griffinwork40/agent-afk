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

import { describe, it, expect, afterEach, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { McpManager } from './manager.js';
import { McpClient } from './client.js';

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
    // Issue #247: fromConfig's fatal path (manager.ts ~251-263) must not
    // orphan a sibling child process that connected fine before the
    // alwaysLoad server's rejection tore the whole batch down.
    'disconnects an already-connected sibling server when an alwaysLoad server fails (#247)',
    async () => {
      const disconnectSpy = vi.spyOn(McpClient.prototype, 'disconnect');
      let caught: unknown;
      try {
        manager = await McpManager.fromConfig({
          good: {
            type: 'stdio',
            command: process.execPath,
            args: [FIXTURE],
          },
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
      // manager stays undefined — fromConfig rejected before returning one.
      expect(manager).toBeUndefined();
      // The 'good' server connected successfully before the batch was torn
      // down; its client must still be disconnected so its child process
      // is not orphaned. Assert BEFORE mockRestore — restoring clears
      // recorded calls on this spy.
      expect(disconnectSpy).toHaveBeenCalled();
      disconnectSpy.mockRestore();
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

  it(
    // Issue #247: disconnectAll()'s per-server error-swallow (manager.ts
    // ~508-519). Each `rec.client.disconnect()` is wrapped in a `.catch()`
    // that logs `[mcp:<server>] disconnect error: <msg>` via console.warn and
    // lets `Promise.all` resolve anyway — so ONE server's teardown failure
    // never aborts the sweep or orphans the OTHER servers' children. Pins the
    // swallow so a regression that lets a teardown rejection escape (turning
    // the warning into a thrown error) is caught. NOTE: the real
    // `McpClient.disconnect()` swallows `client.close()` errors internally
    // (client.ts ~404-408), so to make `disconnect()` itself REJECT we must
    // stub the client method — stubbing the underlying transport would be
    // swallowed before it ever reaches disconnectAll()'s catch.
    'disconnectAll swallows a per-server disconnect rejection, warns, and still tears down the other servers (#247)',
    async () => {
      manager = await McpManager.fromConfig({
        // Two independently-connected fixture servers. Map insertion order is
        // preserved, so disconnectAll() iterates good→bad — but the assertions
        // below are order-independent (they key on serverName).
        good: {
          type: 'stdio',
          command: process.execPath,
          args: [FIXTURE],
        },
        bad: {
          type: 'stdio',
          command: process.execPath,
          args: [FIXTURE],
        },
      });

      // Both connected before we touch teardown.
      const states = manager.getServerStates();
      const byName = new Map(states.map((s) => [s.serverName, s.status]));
      expect(byName.get('good')).toBe('connected');
      expect(byName.get('bad')).toBe('connected');

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      // Capture the REAL disconnect before spying so the 'good' server can
      // still tear its child down for real (no orphaned process) while 'bad'
      // rejects. `serverName` is private on McpClient — read it off `this`.
      const originalDisconnect = McpClient.prototype.disconnect;
      const disconnectedForReal: string[] = [];
      const disconnectSpy = vi
        .spyOn(McpClient.prototype, 'disconnect')
        .mockImplementation(async function (this: McpClient): Promise<void> {
          const name = (this as unknown as { serverName: string }).serverName;
          if (name === 'bad') {
            throw new Error('simulated transport close failure');
          }
          disconnectedForReal.push(name);
          // Delegate to the real teardown so the good child is actually reaped.
          await originalDisconnect.call(this);
        });

      try {
        // (a) MUST resolve — the rejection is swallowed, Promise.all still settles.
        await expect(manager.disconnectAll()).resolves.toBeUndefined();

        // (b) Both servers' disconnect() was attempted — the failing one did
        // not short-circuit the sweep before the sibling ran.
        expect(disconnectSpy).toHaveBeenCalledTimes(2);

        // (c) The OTHER (good) server's real teardown ran despite bad's throw.
        expect(disconnectedForReal).toEqual(['good']);

        // (d) The warn fired for the FAILING server with the documented shape,
        // and NOT for the good one.
        const warnLines = warnSpy.mock.calls.map((c) => String(c[0]));
        expect(warnLines).toContainEqual(
          '[mcp:bad] disconnect error: simulated transport close failure',
        );
        expect(warnLines.some((l) => l.startsWith('[mcp:good] disconnect error'))).toBe(false);
      } finally {
        // Restore BEFORE afterEach's disconnectAll() so cleanup uses the real
        // method (and restoring clears recorded calls — assert above first).
        disconnectSpy.mockRestore();
        warnSpy.mockRestore();
        // The good child was already torn down for real above; drop the manager
        // so afterEach doesn't double-disconnect. 'bad' never really closed, so
        // give it one honest teardown here now that the stub is gone.
        await manager.disconnectAll();
        manager = undefined;
      }
    },
    { timeout: 15_000 },
  );
});
