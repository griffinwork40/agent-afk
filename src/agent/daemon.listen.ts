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
import { execFileSync } from 'node:child_process';

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
    if (!fallback) throw enrichEaddrinuse(requestedPort, host);

    // Only fall back when we can confirm no live process owns the port.
    // `true` = real owner, `null` = unknown (lsof unavailable) — both must
    // surface as a hard error, not silently redirect the daemon.
    const owned = portHasOwner(requestedPort);
    if (owned === null) {
      process.stderr.write(
        `[daemon] lsof unavailable — cannot verify ghost socket; treating EADDRINUSE as real\n`,
      );
      throw enrichEaddrinuse(requestedPort, host, null);
    }
    if (owned !== false) throw enrichEaddrinuse(requestedPort, host);

    // Retry on the alternate loopback address.
    try {
      const result = await bindOnce(server, requestedPort, fallback);
      logFallback(requestedPort, host, fallback);
      return result;
    } catch (retryErr: unknown) {
      // Fallback also failed — both loopback addresses are occupied.
      process.stderr.write(
        `[daemon] EADDRINUSE on ${host}:${requestedPort} and fallback ${fallback}:${requestedPort} — both loopback addresses are occupied.\n`,
      );
      throw enrichEaddrinuse(requestedPort, host, fallback);
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
    // output when nothing matches. execFileSync throws on non-zero exit.
    // Using execFileSync (no shell) eliminates shell-injection risk on `port`.
    const out = execFileSync('lsof', ['-i', `:${port}`, '-sTCP:LISTEN', '-t'], {
      encoding: 'utf-8',
      timeout: 3_000,
      stdio: ['pipe', 'pipe', 'pipe'], // capture stderr to distinguish lsof-not-found
    });
    return out.trim().length > 0;
  } catch (err: unknown) {
    // Distinguish "lsof ran, found nothing" (exit 1) from "lsof not found"
    // (exit 127/ENOENT) or permission-denied (exit 1 with stderr warning).
    if (err && typeof err === 'object' && 'status' in err) {
      const status = (err as { status: number | null }).status;
      if (status === 1) {
        // A stderr "Permission denied" or "WARNING:" means lsof was restricted
        // from inspecting the socket — we cannot confirm there is no owner.
        const stderr =
          'stderr' in err && typeof (err as { stderr: unknown }).stderr === 'string'
            ? (err as { stderr: string }).stderr
            : '';
        if (stderr.includes('Permission denied') || stderr.includes('WARNING:')) {
          return null; // lsof ran but was restricted → unknown
        }
        return false; // lsof ran cleanly, found no listener → ghost socket
      }
    }
    return null; // lsof unavailable or unexpected error → unknown
  }
}

/**
 * Build an enriched EADDRINUSE error.
 *
 * @param ownershipStatus - `null` = lsof unavailable (ownership-unknown message);
 *                          a string = fallback address that also failed;
 *                          `undefined` = real/unknown owner (default message).
 */
function enrichEaddrinuse(
  port: number,
  host: string,
  ownershipStatus?: string | null,
): NodeJS.ErrnoException {
  let msg: string;
  if (ownershipStatus === null) {
    msg = `listen EADDRINUSE: address already in use ${host}:${port}. lsof unavailable — ownership unknown; cannot determine if a ghost socket or a real listener holds the port. Try --port <other>.`;
  } else if (typeof ownershipStatus === 'string') {
    // ownershipStatus is the fallback address that also failed.
    msg =
      `listen EADDRINUSE: address already in use ${host}:${port} ` +
      `(fallback ${ownershipStatus}:${port} also failed). ` +
      `Both loopback addresses are occupied. Try --port <other>.`;
  } else {
    msg = `listen EADDRINUSE: address already in use ${host}:${port}. If no process owns this port (check: lsof -i :${port}), the kernel may hold a ghost socket from a killed daemon. A reboot clears it; or try --port <other>.`;
  }
  const enriched = new Error(msg) as NodeJS.ErrnoException;
  enriched.code = 'EADDRINUSE';
  return enriched;
}

function logFallback(port: number, original: string, fallback: string): void {
  // Invariant: this writes to stderr so launchd captures it in the service log.
  // The message is intentionally explicit — a daemon silently moving addresses
  // with no log would be invisible, defeating the recovery's purpose.
  process.stderr.write(
    `[daemon] EADDRINUSE on ${original}:${port} (ghost socket — no owning process). ` +
      `Fell back to ${fallback}:${port}. ` +
      `After a reboot the ghost socket clears and the daemon returns to ${original}:${port}.\n`,
  );
}
