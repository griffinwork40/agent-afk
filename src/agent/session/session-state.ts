/**
 * Session state management: initialization, metadata, and session identity.
 * @module agent/session/session-state
 */

import type { SessionIdentity, SessionMetadata } from '../types.js';

/**
 * Callback invoked by {@link SessionStateManager.updateSessionIdentity}
 * each time the provider-issued session id becomes known or changes.
 *
 * `sessionId` — the newly assigned id.
 * `priorSessionId` — the id that was set before this call, or `undefined`
 *   on first assignment.
 *
 * The callback is fire-and-forget at the call site; it must not throw.
 */
export type OnSessionIdAssigned = (
  sessionId: string,
  priorSessionId: string | undefined,
) => void;

export class SessionStateManager {
  private initializationPromise: Promise<SessionMetadata>;
  private resolveInitialization!: (metadata: SessionMetadata) => void;
  private rejectInitialization!: (error: Error) => void;
  private initializationSettled = false;
  private sessionMetadata: SessionMetadata;
  private sessionIdentity: SessionIdentity;
  /** Notified whenever the provider-issued id first becomes known or changes. */
  private onSessionIdAssigned?: OnSessionIdAssigned;
  /**
   * The last session id for which `onSessionIdAssigned` was fired, or
   * `undefined` if the callback has never fired. Used by
   * `updateSessionIdentity` to decide whether the id is truly new — the
   * caller's `setSessionMetadata` may have already stored the id in the
   * metadata map before `updateSessionIdentity` is called, so comparing
   * against the current `getSessionId()` would always see a match and
   * silently suppress the callback.
   */
  private lastEmittedSessionId: string | undefined;

  constructor(
    sessionIdentity: SessionIdentity,
    initialMetadata: SessionMetadata,
    onSessionIdAssigned?: OnSessionIdAssigned,
  ) {
    this.sessionIdentity = sessionIdentity;
    this.sessionMetadata = initialMetadata;
    this.onSessionIdAssigned = onSessionIdAssigned;
    // Seed the dedup guard with whatever id may already be known at
    // construction time (e.g. when config.sessionId is pre-set). This
    // prevents a spurious callback if the provider later confirms the
    // same id we already knew about.
    this.lastEmittedSessionId = this.getSessionId();

    this.initializationPromise = new Promise<SessionMetadata>((resolve, reject) => {
      this.resolveInitialization = resolve;
      this.rejectInitialization = reject;
    });
  }

  waitForInitialization(): Promise<SessionMetadata> {
    return this.initializationPromise;
  }

  getSessionIdentity(): SessionIdentity {
    return { ...this.sessionIdentity, sessionId: this.getSessionId() };
  }

  getSessionMetadata(): SessionMetadata {
    return { ...this.sessionMetadata, sessionId: this.getSessionId() };
  }

  getSessionId(): string | undefined {
    return this.sessionMetadata.sessionId ?? this.sessionIdentity.sessionId;
  }

  updateSessionIdentity(sessionId?: string): void {
    if (!sessionId) return;
    // Use `lastEmittedSessionId` (not `getSessionId()`) as the prior to
    // compare against. The stream consumer calls `setSessionMetadata` with the
    // new id BEFORE calling `updateSessionIdentity`, so `getSessionId()` would
    // already return the new id — silently skipping the callback every time.
    // Tracking the last id we actually fired the callback for guarantees the
    // event fires exactly once per new id value, regardless of call order.
    const prior = this.lastEmittedSessionId;
    if (prior === sessionId) return;
    this.lastEmittedSessionId = sessionId;
    this.sessionIdentity = { ...this.sessionIdentity, sessionId };
    this.sessionMetadata = { ...this.sessionMetadata, sessionId };
    try {
      this.onSessionIdAssigned?.(sessionId, prior);
    } catch {
      // Never let a callback failure propagate — the state update has already
      // landed and the session must continue regardless of trace errors.
    }
  }

  setSessionMetadata(updater: (prev: SessionMetadata) => SessionMetadata): void {
    this.sessionMetadata = updater(this.sessionMetadata);
  }

  resolveInitializationIfNeeded(): void {
    if (!this.initializationSettled) {
      this.initializationSettled = true;
      this.resolveInitialization(this.getSessionMetadata());
    }
  }

  resolveInitializationOnce(): void {
    if (this.initializationSettled) return;
    this.initializationSettled = true;
    this.resolveInitialization(this.getSessionMetadata());
  }

  rejectInitializationOnce(error: Error): void {
    if (this.initializationSettled) return;
    this.initializationSettled = true;
    this.rejectInitialization(error);
  }

  isInitializationSettled(): boolean {
    return this.initializationSettled;
  }
}
