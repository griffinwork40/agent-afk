/**
 * RFC 8305 Happy Eyeballs address race, extracted from EgressProxy.
 * Pure function — no class state; the caller passes tracking callbacks.
 */

import net from 'node:net';

/** RFC 8305 §5: stagger delay before racing the next candidate address. */
const HAPPY_EYEBALLS_DELAY_MS = 250;

export interface RaceAddressesDeps {
  /** Port to connect to on each candidate address. */
  port: number;
  /** Connect timeout budget (ms) for each socket AND the overall deadline. */
  connectTimeoutMs: number;
  /** Register a socket for proxy-wide drain cleanup. */
  track: (s: net.Socket) => void;
  /** True when the proxy is closing or the downstream client is gone. */
  gone: () => boolean;
}

/**
 * RFC 8305 Happy Eyeballs race over a pre-validated address list.
 * First socket to connect wins; all others are destroyed (no leaks).
 *
 * Each socket is added to `done` exactly once — either by win() or fail().
 * Subsequent events (error after close, close after error, close on a
 * destroyed loser) are all guarded by done.has() and ignored.
 */
export function raceAddresses(addresses: string[], deps: RaceAddressesDeps): Promise<net.Socket> {
  const { port, connectTimeoutMs, track, gone } = deps;
  return new Promise<net.Socket>((resolve, reject) => {
    // done: every socket that has been fully accounted for. Guards against
    // double-counting when both 'error' and 'close' fire on the same socket.
    const done = new Set<net.Socket>();
    // open: sockets currently in-flight (for deadline cleanup).
    const open = new Set<net.Socket>();
    const timers: ReturnType<typeof setTimeout>[] = [];
    let settled = false;
    let lastErr: unknown = new Error('egress proxy: upstream timeout');
    let failCount = 0;

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      fn();
    };

    const win = (up: net.Socket): void => {
      if (done.has(up)) return;
      done.add(up);
      settle(() => {
        // Destroy every loser still open.
        for (const s of open) { if (s !== up) { done.add(s); s.destroy(); } }
        if (gone()) { up.destroy(); reject(new Error('egress proxy: closing')); return; }
        resolve(up);
      });
      // settle() was already called above. If settled was already true (another
      // socket won first), settle() was a no-op and this socket is a late loser
      // that must be cleaned up. open.has(up) distinguishes a loser (still in
      // open) from the original winner (removed from open by its 'connect').
      if (open.has(up)) { open.delete(up); up.destroy(); }
    };

    const fail = (up: net.Socket, err: unknown): void => {
      if (done.has(up)) return; // already accounted for (error+close dedup)
      done.add(up);
      open.delete(up);
      lastErr = err;
      failCount += 1;
      if (failCount === addresses.length) {
        settle(() => reject(lastErr));
      }
    };

    const launch = (address: string): void => {
      if (settled) return;
      const up = net.connect({ host: address, port });
      track(up);
      open.add(up);
      up.setTimeout(connectTimeoutMs, () =>
        up.destroy(new Error('egress proxy: upstream timeout')),
      );
      up.once('connect', () => { up.setTimeout(0); open.delete(up); win(up); });
      // 'error' always precedes 'close'; done.has() deduplicates both.
      up.on('error', (err) => fail(up, err));
      up.once('close', () => fail(up, new Error('egress proxy: upstream closed before connect')));
    };

    // Launch first candidate immediately; stagger the rest.
    launch(addresses[0]!);
    for (let i = 1; i < addresses.length; i++) {
      const addr = addresses[i]!;
      timers.push(setTimeout(() => launch(addr), i * HAPPY_EYEBALLS_DELAY_MS));
    }

    // Hard deadline: cancel everything if the whole budget expires.
    timers.push(
      setTimeout(() => {
        settle(() => {
          for (const s of open) { done.add(s); s.destroy(); }
          reject(new Error('egress proxy: upstream timeout'));
        });
      }, connectTimeoutMs),
    );
  });
}
