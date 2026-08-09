/**
 * Single-use browser handoff nonces for the `afk web` auto-open path.
 *
 * Invariant: the bearer token must never appear in an argv element. `open` and
 * `xdg-open` are exec'd with the target URL as an argument, and arguments are
 * world-readable in the process table — so auto-opening `?token=<bearer>`
 * publishes the live agent-driving credential to every other local user for as
 * long as the browser process lives. The credential in the opened URL is
 * therefore a handoff nonce: redeemable exactly ONCE and only within
 * `HANDOFF_TTL_MS`, so the same `ps aux` read yields something that is almost
 * certainly already burnt, and that can never be replayed after the browser
 * has used it. The human-readable URL printed to the terminal still carries the
 * real token — terminal output is not the process table, and a pasteable URL
 * has to keep working after the nonce expires.
 */

import { mintToken } from './auth.js';

/** How long a freshly minted handoff nonce remains redeemable. */
export const HANDOFF_TTL_MS = 60_000;

/**
 * A bounded set of one-shot credentials.
 *
 * Contract: `redeem` BURNS the nonce whether or not it was still valid, so a
 * replay inside the TTL window fails exactly like a replay after it. The clock
 * is injectable so expiry is testable without timer manipulation.
 */
export class HandoffNonces {
  private readonly issued = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Mint a nonce redeemable once, within `HANDOFF_TTL_MS`. */
  mint(): string {
    const nonce = mintToken();
    this.issued.set(nonce, this.now() + HANDOFF_TTL_MS);
    return nonce;
  }

  /** Redeem a nonce, burning it. Returns whether it was valid and unexpired. */
  redeem(nonce: string | undefined): boolean {
    this.sweep();
    if (nonce === undefined || nonce === '') return false;
    const expiry = this.issued.get(nonce);
    if (expiry === undefined) return false;
    this.issued.delete(nonce);
    return expiry > this.now();
  }

  /** Drop expired entries so an unredeemed nonce cannot accumulate forever. */
  private sweep(): void {
    const cutoff = this.now();
    for (const [nonce, expiry] of this.issued) {
      if (expiry <= cutoff) this.issued.delete(nonce);
    }
  }
}
