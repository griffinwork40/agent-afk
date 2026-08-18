/**
 * Tests for daemon.listen — EADDRINUSE ghost-socket recovery.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.mock is hoisted above imports — must appear before any other import.
vi.mock('node:child_process', async (importActual) => {
  const actual = await importActual<typeof import('node:child_process')>();
  return {
    ...actual,
    execSync: vi.fn(actual.execSync),
  };
});

import { execSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { listenWithRecovery, closeServer } from './daemon.listen.js';

const mockExecSync = vi.mocked(execSync);

// Track servers to close in afterEach to prevent port leaks
let servers: Server[] = [];

function tracked(s: Server): Server {
  servers.push(s);
  return s;
}

beforeEach(() => {
  servers = [];
  // Default: delegate to the real execSync so lsof runs normally.
  mockExecSync.mockImplementation((...args) => {
    const { execSync: realExecSync } = vi.importActual<typeof import('node:child_process')>(
      'node:child_process',
    ) as typeof import('node:child_process');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (realExecSync as any)(...args);
  });
});

afterEach(async () => {
  for (const s of servers) {
    try {
      await closeServer(s);
    } catch {
      // already closed
    }
  }
  vi.restoreAllMocks();
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

  describe('ghost-socket fallback: lsof finds no owner (exit status 1)', () => {
    // Stub execSync to simulate "lsof ran, found no listener" — ghost socket.
    // exit status 1 is the signal that portHasOwner returns `false`, allowing
    // the fallback to the alternate loopback address to proceed.
    beforeEach(() => {
      mockExecSync.mockImplementation(() => {
        const err = Object.assign(new Error('Command failed'), { status: 1 });
        throw err;
      });
    });

    it('falls back to ::1 when 127.0.0.1 has a ghost socket', async () => {
      // Occupy 127.0.0.1:PORT with a real server so EADDRINUSE fires on that
      // address, then verify listenWithRecovery binds successfully on ::1.
      const blocker = tracked(createServer());
      const { port } = await listenWithRecovery(blocker, 0, '127.0.0.1');

      const server = tracked(createServer());
      const result = await listenWithRecovery(server, port, '127.0.0.1');
      expect(result.address).toBe('::1');
      expect(result.port).toBe(port);
    });
  });

  describe('lsof unavailable: ownership unknown (exit status 127)', () => {
    // Stub execSync to simulate lsof not installed — returns null from
    // portHasOwner, which must NOT fall back (emit stderr + throw).
    beforeEach(() => {
      mockExecSync.mockImplementation(() => {
        const err = Object.assign(new Error('lsof: command not found'), { status: 127 });
        throw err;
      });
    });

    it('throws with lsof-unavailable message when ownership is unknown', async () => {
      const blocker = tracked(createServer());
      const { port } = await listenWithRecovery(blocker, 0, '127.0.0.1');

      const server = tracked(createServer());
      await expect(listenWithRecovery(server, port, '127.0.0.1')).rejects.toThrow(
        /lsof unavailable/,
      );
    });
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
