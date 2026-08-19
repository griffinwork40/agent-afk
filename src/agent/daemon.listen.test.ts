/**
 * Tests for daemon.listen — EADDRINUSE ghost-socket recovery.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as net from 'node:net';

// vi.mock is hoisted above imports — must appear before any other import.
vi.mock('node:child_process', async (importActual) => {
  const actual = await importActual<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn(actual.execFileSync),
  };
});

import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { listenWithRecovery, closeServer } from './daemon.listen.js';

const mockExecFileSync = vi.mocked(execFileSync);

// ---------------------------------------------------------------------------
// IPv6 availability guard
// Environments with IPv6 disabled (some CI hosts, Docker with --sysctl
// net.ipv6.conf.all.disable_ipv6=1) cannot bind ::1 at all.  Tests that
// exercise the IPv4 → IPv6 fallback path are skipped in those environments
// rather than failing with an OS-level EADDRNOTAVAIL.
// ---------------------------------------------------------------------------
function isIPv6Available(): boolean {
  try {
    const s = net.createServer();
    // listen() is synchronous enough for detection purposes when we wait for
    // the 'listening' event — but for a synchronous probe we can use a raw
    // TCP socket bind via the low-level dgram trick.  The simplest portable
    // approach is to attempt a real listen and close it immediately.
    let available = false;
    s.listen(0, '::1');
    available = true;
    s.close();
    return available;
  } catch {
    return false;
  }
}

const ipv6Available = isIPv6Available();

// Track servers to close in afterEach to prevent port leaks
let servers: Server[] = [];

function tracked(s: Server): Server {
  servers.push(s);
  return s;
}

beforeEach(() => {
  servers = [];
  // Default: delegate to the real execFileSync so lsof runs normally.
  mockExecFileSync.mockImplementation((...args) => {
    const { execFileSync: realExecFileSync } = vi.importActual<
      typeof import('node:child_process')
    >('node:child_process') as typeof import('node:child_process');
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
    const server = tracked(createServer());
    const result = await listenWithRecovery(server, 0, '127.0.0.1');
    expect(result.port).toBeGreaterThan(0);
    expect(result.address).toBe('127.0.0.1');
  });

  it.skipIf(!ipv6Available)('binds to IPv6 loopback when requested', async () => {
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

  describe.skipIf(!ipv6Available)(
    'ghost-socket fallback: lsof finds no owner (exit status 1)',
    () => {
      // Stub execFileSync to simulate "lsof ran, found no listener" — ghost socket.
      // exit status 1 is the signal that portHasOwner returns `false`, allowing
      // the fallback to the alternate loopback address to proceed.
      beforeEach(() => {
        mockExecFileSync.mockImplementation(() => {
          const err = Object.assign(new Error('Command failed'), { status: 1, stderr: '' });
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
    },
  );

  describe('lsof unavailable: ownership unknown (exit status 127)', () => {
    // Stub execFileSync to simulate lsof not installed — returns null from
    // portHasOwner, which must NOT fall back (emit stderr + throw).
    beforeEach(() => {
      mockExecFileSync.mockImplementation(() => {
        const err = Object.assign(new Error('lsof: command not found'), {
          status: 127,
          stderr: '',
        });
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

  describe.skipIf(!ipv6Available)(
    'fallback-failure: both loopback addresses occupied',
    () => {
      // Stub execFileSync to simulate ghost-socket detection (lsof exit 1) so
      // listenWithRecovery attempts the fallback — then occupy BOTH addresses so
      // the retry also fails. The thrown error must carry EADDRINUSE and name
      // both the original address and the fallback.
      beforeEach(() => {
        mockExecFileSync.mockImplementation(() => {
          const err = Object.assign(new Error('Command failed'), { status: 1, stderr: '' });
          throw err;
        });
      });

      it('throws EADDRINUSE naming both addresses when fallback also fails', async () => {
        // Hold a server on 127.0.0.1:P so the primary bind fails (EADDRINUSE).
        const blockerV4 = tracked(createServer());
        const { port } = await listenWithRecovery(blockerV4, 0, '127.0.0.1');

        // Also hold a server on ::1:P so the fallback bind fails too.
        const blockerV6 = tracked(createServer());
        await new Promise<void>((resolve, reject) => {
          blockerV6.once('error', reject);
          blockerV6.listen(port, '::1', () => {
            blockerV6.removeListener('error', reject);
            resolve();
          });
        });

        // listenWithRecovery detects ghost (lsof exit 1), tries ::1, also fails.
        const server = tracked(createServer());
        const err = await listenWithRecovery(server, port, '127.0.0.1').then(
          () => null,
          (e: unknown) => e,
        );
        expect(err).toBeDefined();
        const errNode = err as NodeJS.ErrnoException;
        expect(errNode.code).toBe('EADDRINUSE');
        // Error message must reference the original address and the fallback.
        expect(errNode.message).toMatch(/127\.0\.0\.1/);
        expect(errNode.message).toMatch(/::1/);
      });
    },
  );

  describe('permission-denied detection: lsof restricted (exit status 1 + stderr warning)', () => {
    // Stub execFileSync to simulate lsof running but being restricted by
    // macOS SIP or Linux capabilities — stderr carries "Permission denied" or
    // "WARNING:", so portHasOwner must return null (unknown), not false.
    beforeEach(() => {
      mockExecFileSync.mockImplementation(() => {
        const err = Object.assign(new Error('Command failed'), {
          status: 1,
          stderr: 'lsof: WARNING: can\'t stat() fuse.gvfsd-fuse ...\nPermission denied',
        });
        throw err;
      });
    });

    it('treats permission-denied lsof as unknown and throws rather than falling back', async () => {
      const blocker = tracked(createServer());
      const { port } = await listenWithRecovery(blocker, 0, '127.0.0.1');

      const server = tracked(createServer());
      // portHasOwner returns null → daemon must NOT fall back, must throw.
      // The error should be the lsof-unavailable variant or EADDRINUSE — either
      // way the daemon does not silently redirect.
      await expect(listenWithRecovery(server, port, '127.0.0.1')).rejects.toThrow(/EADDRINUSE/);
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
