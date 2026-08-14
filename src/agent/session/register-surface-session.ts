/**
 * Cross-surface session registration (step 7 of the session-registry effort).
 *
 * Registers a top-level session — the CLI REPL and the daemon scheduler — in the
 * process-wide {@link sessionRegistry}, so they appear in the surface-agnostic
 * index alongside the Telegram adapter's sessions. This closes the loop from the
 * registry foundation to every user-facing surface.
 *
 * Invariant: registration and disposal are BEST-EFFORT — they must never throw
 * into the caller. A registry hiccup can never break or abort a live session;
 * the cross-surface index is auxiliary, not load-bearing.
 *
 * The SDK session id is late-bound (undefined until the provider emits it
 * mid-first-turn — see session-registry.ts). When it is already known at
 * registration (e.g. a CLI `--resume` target) it is passed up front and used as
 * the binding key; otherwise it is attached asynchronously after
 * `waitForInitialization()`, best-effort.
 *
 * Lifecycle: process-scoped surfaces (the CLI REPL — one process, one session)
 * need no disposal: the in-memory registry dies with the process. Long-lived
 * surfaces (the daemon — many sessions per process) MUST call `dispose()` on
 * session close so the handle is archived and its binding key freed, preventing
 * unbounded handle growth.
 *
 * @module agent/session/register-surface-session
 */

import { randomUUID } from 'node:crypto';
import type { AgentModelInput } from '../types.js';
import {
  sessionRegistry,
  type SessionRegistry,
  type SessionHandle,
  type SessionSurface,
} from './session-registry.js';

/** Minimal session shape needed for late SDK-session-id attachment. The
 *  init result is awaited but unused, so its type is intentionally `unknown`
 *  (AgentSession resolves SessionMetadata; a stub may resolve void). */
interface RegisterableSession {
  readonly sessionId?: string;
  waitForInitialization?(): Promise<unknown>;
}

export interface RegisterSurfaceSessionOptions {
  surface: SessionSurface;
  model: AgentModelInput;
  cwd?: string;
  name?: string;
  /** SDK session id when already known (e.g. a --resume target); else attached lazily. */
  sdkSessionId?: string;
  /** Registry to register in. Defaults to the process-wide singleton (tests inject a fresh one). */
  registry?: SessionRegistry;
}

export interface SurfaceSessionRegistration {
  /** The created handle, or undefined when registration failed (best-effort). */
  handle: SessionHandle | undefined;
  /** Archive the handle (frees its binding key). Idempotent + best-effort — call on close for long-lived surfaces. */
  dispose(): void;
}

const NOOP_REGISTRATION: SurfaceSessionRegistration = { handle: undefined, dispose: () => {} };

/**
 * Register a top-level session in the cross-surface registry. Returns the handle
 * (or undefined on failure) plus a best-effort `dispose()` that archives it.
 */
export function registerSurfaceSession(
  session: RegisterableSession,
  opts: RegisterSurfaceSessionOptions,
): SurfaceSessionRegistration {
  const registry = opts.registry ?? sessionRegistry;

  let handle: SessionHandle | undefined;
  try {
    handle = registry.create({
      surface: opts.surface,
      model: opts.model,
      // Key on the SDK id when known (meaningful, reverse-lookupable); else a
      // unique opaque key — CLI/daemon have no external routing key like a chatId.
      key: opts.sdkSessionId ?? `${opts.surface}:${randomUUID()}`,
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts.name !== undefined ? { name: opts.name } : {}),
      ...(opts.sdkSessionId !== undefined ? { sdkSessionId: opts.sdkSessionId } : {}),
    });
  } catch {
    // Registration is auxiliary; never surface a registry error to the session.
    return NOOP_REGISTRATION;
  }

  const id = handle.id;

  // Late-bind the SDK session id once the provider emits it (best-effort, non-blocking).
  if (opts.sdkSessionId === undefined && typeof session.waitForInitialization === 'function') {
    void session
      .waitForInitialization()
      .then(() => {
        const sid = session.sessionId;
        if (sid) {
          try {
            registry.attachSdkSessionId(id, sid);
          } catch {
            /* best-effort */
          }
        }
      })
      .catch(() => {
        /* best-effort — init failure is handled by the session itself */
      });
  }

  return {
    handle,
    dispose: () => {
      try {
        registry.archive(id);
      } catch {
        /* best-effort — already archived / unknown id */
      }
    },
  };
}
