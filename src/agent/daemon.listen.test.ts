/**
 * Tests for daemon.listen — EADDRINUSE ghost-socket recovery.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { listenWithRecovery, closeServer } from './daemon.listen.js';

// Track servers to close in afterEach to prevent port leaks
let servers: Server[] = [];

function tracked(s: Server): Server {
  servers.push(s);
  return s;
}

beforeEach(() => {
  servers = [];
});

afterEach(async () => {
  for (const s of servers) {
    try {
      await closeServer(s);
    } catch {
      // already closed
    }
  }
});

describe('listenWithRecovery', () => {
  it('binds to the requested address when port is free', async () => {
    const server = tracked(createServer());
    const result = await listenWithRecovery(server, 0, '127.0.0.1');
    expect(result.port).toBeGreaterThan(0);
    expect(result.address).toBe('127.0.0.1');
  });

  it('binds to IPv6 loopback when requested', async () => {
    const server = tracked(createServer());
    const result = await listenWithRecovery(server, 0, '::1');
    expect(result.port).toBeGreaterThan(0);
    expect(result.address).toBe('::1');
  });

  it('throws EADDRINUSE when a real process holds the port', async () => {
    // Occupy a port with a real server
    const blocker = tracked(createServer());
    const { port } = await listenWithRecovery(blocker, 0, '127.0.0.1');

    // Attempt to bind the same address:port — should fail since a real process owns it
    const server = tracked(createServer());
    await expect(listenWithRecovery(server, port, '127.0.0.1')).rejects.toThrow(/EADDRINUSE/);
  });

  it('surfaces enriched error message with diagnostic guidance', async () => {
    const blocker = tracked(createServer());
    const { port } = await listenWithRecovery(blocker, 0, '127.0.0.1');

    const server = tracked(createServer());
    await expect(listenWithRecovery(server, port, '127.0.0.1')).rejects.toThrow(/ghost socket/);
  });

  it('throws on non-loopback EADDRINUSE without fallback attempt', async () => {
    // Occupy 0.0.0.0:port
    const blocker = tracked(createServer());
    const { port } = await listenWithRecovery(blocker, 0, '0.0.0.0');

    const server = tracked(createServer());
    await expect(listenWithRecovery(server, port, '0.0.0.0')).rejects.toThrow(/EADDRINUSE/);
  });
});

describe('closeServer', () => {
  it('resolves on a listening server', async () => {
    const server = createServer();
    await listenWithRecovery(server, 0, '127.0.0.1');
    await expect(closeServer(server)).resolves.toBeUndefined();
  });

  it('rejects on an already-closed server', async () => {
    const server = createServer();
    await listenWithRecovery(server, 0, '127.0.0.1');
    await closeServer(server);
    await expect(closeServer(server)).rejects.toThrow();
  });
});
