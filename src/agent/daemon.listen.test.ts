/**
 * Tests for daemon.listen — EADDRINUSE ghost-socket recovery.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { networkInterfaces } from 'node:os';

// vi.mock is hoisted above imports — must appear before any other import.
vi.mock('node:child_process', async (importActual) => {
  const actual = await importActual<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn(actual.execFileSync),
  };
});

import { execFileSync } from 'node:child_process';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { listenWithRecovery, closeServer } from './daemon.listen.js';

const mockExecFileSync = vi.mocked(execFileSync);

/** Return true when this host has an IPv6 loopback interface (::1). */
function hasIPv6Loopback(): boolean {
  return Object.values(networkInterfaces())
    .flat()
    .some((iface) => iface?.family === 'IPv6' && iface.address === '::1');
}

const IPV6_AVAILABLE = hasIPv6Loopback();

// Track servers to close in afterEach to prevent port leaks
let servers: HttpServer[] = [];

function tracked(s: HttpServer): HttpServer {
  servers.push(s);
  return s;
}

beforeEach(() => {
  servers = [];
  // Default: delegate to the real execFileSync so lsof runs normally.
  mockExecFileSync.mockImplementation((...args) => {
    const { execFileSync: realExecFileSync } = vi.importActual<typeof import('node:child_process')>(
      'node:child_process',
    ) as typeof import('node:child_process');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (realExecFileSync as any)(...args);
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
    const server = tracked(createHttpServer());
    const result = await listenWithRecovery(server, 0, '127.0.0.1');
    expect(result.port).toBeGreaterThan(0);
    expect(result.address).toBe('127.0.0.1');
  });

  it.skipIf(!IPV6_AVAILABLE)('binds to IPv6 loopback when requested', async () => {
    const server = tracked(createHttpServer());
    const result = await listenWithRecovery(server, 0, '::1');
    expect(result.port).toBeGreaterThan(0);
    expect(result.address).toBe('::1');
  });

  it('throws EADDRINUSE when a real process holds the port', async () => {
    // Occupy a port with a real server
    const blocker = tracked(createHttpServer());
    const { port } = await listenWithRecovery(blocker, 0, '127.0.0.1');

    // Attempt to bind the same address:port — should fail since a real process owns it
    const server = tracked(createHttpServer());
    await expect(listenWithRecovery(server, port, '127.0.0.1')).rejects.toThrow(/EADDRINUSE/);
  });

  it('surfaces enriched error message with diagnostic guidance', async () => {
    const blocker = tracked(createHttpServer());
    const { port } = await listenWithRecovery(blocker, 0, '127.0.0.1');

    const server = tracked(createHttpServer());
    await expect(listenWithRecovery(server, port, '127.0.0.1')).rejects.toThrow(/ghost socket/);
  });

  it('throws on non-loopback EADDRINUSE without fallback attempt', async () => {
    // Occupy 0.0.0.0:port
    const blocker = tracked(createHttpServer());
    const { port } = await listenWithRecovery(blocker, 0, '0.0.0.0');

    const server = tracked(createHttpServer());
    await expect(listenWithRecovery(server, port, '0.0.0.0')).rejects.toThrow(/EADDRINUSE/);
  });

  describe('ghost-socket fallback: lsof finds no owner (exit status 1)', () => {
    // Stub execFileSync to simulate "lsof ran, found no listener" — ghost socket.
    // exit status 1 is the signal that portHasOwner returns `false`, allowing
    // the fallback to the alternate loopback address to proceed.
    beforeEach(() => {
      mockExecFileSync.mockImplementation(() => {
        const err = Object.assign(new Error('Command failed'), { status: 1 });
        throw err;
      });
    });

    it.skipIf(!IPV6_AVAILABLE)(
      'falls back to ::1 when 127.0.0.1 has a ghost socket',
      async () => {
        // Occupy 127.0.0.1:PORT with a real server so EADDRINUSE fires on that
        // address, then verify listenWithRecovery binds successfully on ::1.
        const blocker = tracked(createHttpServer());
        const { port } = await listenWithRecovery(blocker, 0, '127.0.0.1');

        const server = tracked(createHttpServer());
        const result = await listenWithRecovery(server, port, '127.0.0.1');
        expect(result.address).toBe('::1');
        expect(result.port).toBe(port);
      },
    );
  });

  describe('fallback-failure: both loopback addresses occupied (ghost socket confirmed)', () => {
    // Stub execFileSync to simulate "lsof ran, found no listener" (exit 1), so the
    // ghost-socket path is taken. Then hold BOTH 127.0.0.1:P and ::1:P with real
    // servers so the fallback bind also fails. Verifies the error is enriched with
    // both addresses and that stderr captures the recovery attempt.
    beforeEach(() => {
      mockExecFileSync.mockImplementation(() => {
        const err = Object.assign(new Error('Command failed'), { status: 1 });
        throw err;
      });
    });

    it.skipIf(!IPV6_AVAILABLE)(
      'throws EADDRINUSE naming both addresses when fallback also fails',
      async () => {
        // Block 127.0.0.1:P
        const blocker4 = tracked(createHttpServer());
        const { port } = await listenWithRecovery(blocker4, 0, '127.0.0.1');

        // Block ::1:P with the same port number
        const blocker6 = tracked(createHttpServer());
        await listenWithRecovery(blocker6, port, '::1');

        const stderrWrites: string[] = [];
        const orig = process.stderr.write.bind(process.stderr);
        const spy = vi
          .spyOn(process.stderr, 'write')
          .mockImplementation((chunk: unknown, ...rest: unknown[]) => {
            if (typeof chunk === 'string') stderrWrites.push(chunk);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return (orig as any)(chunk, ...rest);
          });

        const server = tracked(createHttpServer());
        let caught: Error | undefined;
        try {
          await listenWithRecovery(server, port, '127.0.0.1');
        } catch (e) {
          caught = e as Error;
        } finally {
          spy.mockRestore();
        }

        expect(caught).toBeDefined();
        expect((caught as NodeJS.ErrnoException).code).toBe('EADDRINUSE');
        expect(caught!.message).toContain('127.0.0.1');
        expect(caught!.message).toContain('::1');
        expect(caught!.message).toContain('fallback');
        expect(
          stderrWrites.some((line) => line.includes('fallback') && line.includes('::1')),
        ).toBe(true);
      },
    );
  });

  describe('lsof permission denied: ownership unknown (exit status 1 + Permission denied)', () => {
    beforeEach(() => {
      mockExecFileSync.mockImplementation(() => {
        const err = Object.assign(new Error('Command failed'), {
          status: 1,
          stderr: 'Permission denied',
        });
        throw err;
      });
    });

    it('throws with lsof-unavailable message when lsof is permission-denied', async () => {
      const blocker = tracked(createHttpServer());
      const { port } = await listenWithRecovery(blocker, 0, '127.0.0.1');

      const server = tracked(createHttpServer());
      await expect(listenWithRecovery(server, port, '127.0.0.1')).rejects.toThrow(
        /lsof unavailable/,
      );
    });
  });

  describe('lsof unavailable: ownership unknown (exit status 127)', () => {
    // Stub execFileSync to simulate lsof not installed — returns null from
    // portHasOwner, which must NOT fall back (emit stderr + throw).
    beforeEach(() => {
      mockExecFileSync.mockImplementation(() => {
        const err = Object.assign(new Error('lsof: command not found'), { status: 127 });
        throw err;
      });
    });

    it('throws with lsof-unavailable message when ownership is unknown', async () => {
      const blocker = tracked(createHttpServer());
      const { port } = await listenWithRecovery(blocker, 0, '127.0.0.1');

      const server = tracked(createHttpServer());
      await expect(listenWithRecovery(server, port, '127.0.0.1')).rejects.toThrow(
        /lsof unavailable/,
      );
    });
  });
});

describe('closeServer', () => {
  it('resolves on a listening server', async () => {
    const server = createHttpServer();
    await listenWithRecovery(server, 0, '127.0.0.1');
    await expect(closeServer(server)).resolves.toBeUndefined();
  });

  it('rejects on an already-closed server', async () => {
    const server = createHttpServer();
    await listenWithRecovery(server, 0, '127.0.0.1');
    await closeServer(server);
    await expect(closeServer(server)).rejects.toThrow();
  });
});
