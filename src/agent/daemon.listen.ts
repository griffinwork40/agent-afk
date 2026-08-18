/**
 * Daemon server bind helpers — extracted from daemon.ts to hold EADDRINUSE
 * recovery logic within the 350-line ceiling.
 *
 * History: on 2026-08-18 a `kill -9`'d daemon left a ghost kernel socket on
 * 127.0.0.1:7777 that no process owned (invisible to lsof/netstat) yet blocked
 * bind. launchd's KeepAlive then crash-looped — each rapid restart created
 * another ghost. Only a reboot cleared it. This module adds loopback-fallback
 * recovery: when EADDRINUSE fires on the requested loopback address and no
 * process owns the port, it retries on the other loopback family (IPv4 ↔ IPv6).
 * Both addresses are loopback-only, so the security invariant (no off-host
 * access) is preserved.
 *
 * @module agent/daemon.listen
 */

import type { Server } from 'node:http';
import { execSync } from 'node:child_process';

// Invariant: these are the only two loopback literals the fallback considers.
// 'localhost' is intentionally excluded — its resolution is OS-dependent and
// may map to either address, making ghost-detection unreliable.
const LOOPBACK_IPV4 = '127.0.0.1';
const LOOPBACK_IPV6 = '::1';

interface ListenResult {
  port: number;
  address: string;
}

/**
 * Bind `server` to `requestedPort` on `host`. On EADDRINUSE against a loopback
 * address where no process owns the port (ghost socket), retries once on the
 * alternate loopback family.
 */
export function listenWithRecovery(
  server: Server,
  requestedPort: number,
  host: string,
): Promise<ListenResult> {
  return bindOnce(server, requestedPort, host).catch(async (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EADDRINUSE') throw err;

    const fallback = loopbackFallback(host);
    if (!fallback) throw enrichEaddrinuse(err, requestedPort, host);

    // Only fall back when we can confirm no live process owns the port.
    // `true` = real owner, `null` = unknown (lsof unavailable) — both must
    // surface as a hard error, not silently redirect the daemon.
    const owned = portHasOwner(requestedPort);
    if (owned !== false) throw enrichEaddrinuse(err, requestedPort, host);

    // Retry on the alternate loopback address.
    try {
      const result = await bindOnce(server, requestedPort, fallback);
      logFallback(requestedPort, host, fallback);
      return result;
    } catch (retryErr: unknown) {
      // Fallback also failed — surface the original error with diagnostics.
      throw enrichEaddrinuse(err, requestedPort, host);
    }
  });
}

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function bindOnce(server: Server, port: number, host: string): Promise<ListenResult> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // Contract: passing `host` restricts the bind to that interface. Omitting
    // it (the prior behaviour) made Node bind the unspecified address (all
    // interfaces) — the vulnerability this argument closes.
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      const address = server.address();
      if (typeof address === 'object' && address) {
        resolve({ port: address.port, address: address.address });
      } else {
        resolve({ port, address: host });
      }
    });
  });
}

/** Return the alternate loopback address, or `undefined` if `host` is not loopback. */
function loopbackFallback(host: string): string | undefined {
  if (host === LOOPBACK_IPV4) return LOOPBACK_IPV6;
  if (host === LOOPBACK_IPV6) return LOOPBACK_IPV4;
  return undefined;
}

/**
 * Check whether a live process currently owns a LISTEN socket on this port.
 * Uses `lsof` (macOS/Linux).
 *
 * Returns:
 *  - `true`  — a live process owns the port (do NOT fall back).
 *  - `false` — lsof ran successfully and found no listener (ghost socket).
 *  - `null`  — lsof is unavailable or errored; ownership is unknown.
 *
 * Invariant: `null` (unknown) is treated as "unsafe to fall back" by the
 * caller — a missing lsof must not silently redirect the daemon to another
 * address when a real process may own the port.
 */
function portHasOwner(port: number): boolean | null {
  try {
    // lsof exits 0 with output when a listener exists, and exits 1 with no
    // output when nothing matches. execSync throws on non-zero exit.
    const out = execSync(`lsof -i :${port} -sTCP:LISTEN -t`, {
      encoding: 'utf-8',
      timeout: 3_000,
      stdio: ['pipe', 'pipe', 'pipe'], // capture stderr to distinguish lsof-not-found
    });
    return out.trim().length > 0;
  } catch (err: unknown) {
    // Distinguish "lsof ran, found nothing" (exit 1) from "lsof not found" (exit 127/ENOENT).
    if (err && typeof err === 'object' && 'status' in err) {
      const status = (err as { status: number | null }).status;
      if (status === 1) return false; // lsof ran, no listener → ghost
    }
    return null; // lsof unavailable or unexpected error → unknown
  }
}

function enrichEaddrinuse(
  err: NodeJS.ErrnoException,
  port: number,
  host: string,
): NodeJS.ErrnoException {
  err.message =
    `listen EADDRINUSE: address already in use ${host}:${port}. ` +
    'If no process owns this port (check: lsof -i :' +
    port +
    '), the kernel may hold a ghost socket from a killed daemon. ' +
    'A reboot clears it; or try --port <other>.';
  return err;
}

function logFallback(port: number, original: string, fallback: string): void {
  // Invariant: this writes to stderr so launchd captures it in the service log.
  // The message is intentionally explicit — a daemon silently moving addresses
  // with no log would be invisible, defeating the recovery's purpose.
  process.stderr.write(
    `[daemon] EADDRINUSE on ${original}:${port} (ghost socket — no owning process). ` +
      `Fell back to ${fallback}:${port}. ` +
      `A reboot clears ghost sockets; revert will happen automatically on next restart.\n`,
  );
}
