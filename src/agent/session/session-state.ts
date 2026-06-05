/**
 * Session state management: initialization, metadata, and session identity.
 * @module agent/session/session-state
 */

import type { SessionIdentity, SessionMetadata } from '../types.js';

export class SessionStateManager {
  private initializationPromise: Promise<SessionMetadata>;
  private resolveInitialization!: (metadata: SessionMetadata) => void;
  private rejectInitialization!: (error: Error) => void;
  private initializationSettled = false;
  private sessionMetadata: SessionMetadata;
  private sessionIdentity: SessionIdentity;

  constructor(sessionIdentity: SessionIdentity, initialMetadata: SessionMetadata) {
    this.sessionIdentity = sessionIdentity;
    this.sessionMetadata = initialMetadata;

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
    this.sessionIdentity = { ...this.sessionIdentity, sessionId };
    this.sessionMetadata = { ...this.sessionMetadata, sessionId };
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
