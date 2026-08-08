/**
 * Creates and drives `AgentSession`s that live inside the `afk web` process.
 *
 * Invariant: "owned" is the whole security and correctness boundary of this
 * surface. A session created here shares this process's memory, so its
 * elicitations reach the single-slot `elicitationRouter` that
 * {@link WebElicitationBridge} installs, and a browser can answer them. A
 * session discovered on disk belongs to ANOTHER OS process whose handler lives
 * in its own memory — unreachable from here, which is why the routes layer
 * hard-409s prompts and approvals addressed to it rather than accepting them
 * into a void. This class is the only thing that may add to that set.
 *
 * Streaming is deliberately NOT wired here. `AgentSession` writes its ledger
 * unconditionally (agent-session.ts records the user turn and every output
 * event), and the SSE route independently tails that file. So driving a session
 * needs no event plumbing back to the browser: write to the ledger, and the
 * existing replay-then-tail path delivers it. Draining the iterator here exists
 * only to run the turn to completion.
 */

import { AgentSession } from '../agent/session/agent-session.js';
import { createDefaultHookRegistry } from '../agent/default-hook-registry.js';
import { getApiKeyForModel, resolveBaseSystemPrompt } from '../cli/shared-helpers.js';
import type { AgentConfig } from '../agent/types.js';
import type { PermissionMode } from '../agent/types/sdk-types.js';

export interface CreateSessionRequest {
  /** Working directory. Ignored unless `allowArbitraryCwd` — see the guard. */
  cwd?: string;
  model?: string;
}

export interface OwnedSessionInfo {
  id: string;
  cwd: string;
  model: string;
  createdAt: string;
}

export interface SessionOwnerOptions {
  /** Directory browser-started sessions run in. Defaults to the server's cwd. */
  cwd?: string;
  model: string;
  /**
   * Permission mode for browser-started sessions.
   *
   * Contract: the default is 'default' — REAL approvals. A tool needing consent
   * raises an elicitation, the bridge holds it, and the browser renders a card.
   * Choosing 'bypassPermissions' here would make a loopback page able to run any
   * tool with no consent step, so it must be an explicit operator decision
   * rather than a default that silently disarms the gate.
   */
  permissionMode?: PermissionMode;
  /**
   * Allow a browser-supplied `cwd`. Default false: an authenticated page could
   * otherwise start an agent anywhere on the filesystem, which converts a token
   * leak into arbitrary whole-machine access rather than access scoped to the
   * directory the operator launched the server in.
   */
  allowArbitraryCwd?: boolean;
}

/** Owns the lifecycle of every session this process can actually drive. */
export class SessionOwner {
  readonly owned = new Set<string>();
  private readonly sessions = new Map<string, AgentSession>();
  private readonly info = new Map<string, OwnedSessionInfo>();
  /** Per-session serialization chain — see {@link submitPrompt}. */
  private readonly turns = new Map<string, Promise<void>>();
  private readonly busy = new Set<string>();

  constructor(private readonly options: SessionOwnerOptions) {}

  private get baseCwd(): string {
    return this.options.cwd ?? process.cwd();
  }

  /** Construct a session, wait for its id, and register it as drivable. */
  async create(request: CreateSessionRequest = {}): Promise<OwnedSessionInfo> {
    const cwd = this.options.allowArbitraryCwd === true ? (request.cwd ?? this.baseCwd) : this.baseCwd;
    const model = request.model ?? this.options.model;

    const { prompt, source } = resolveBaseSystemPrompt(cwd);
    const { registry } = createDefaultHookRegistry(undefined, 'web', undefined, undefined, undefined, {
      cwd,
    });

    const config: AgentConfig = {
      model,
      // Trace `origin` attribution: distinguishes browser-started work from a
      // REPL or daemon session in the witness trace.
      surface: 'web',
      apiKey: getApiKeyForModel(model),
      cwd,
      hookRegistry: registry,
      permissionMode: this.options.permissionMode ?? 'default',
      ...(prompt !== undefined ? { systemPrompt: prompt } : {}),
      ...(source !== undefined ? { systemPromptSource: source } : {}),
    };

    const session = new AgentSession(config);

    // Invariant: the id is provider-issued and undefined until initialization
    // resolves. Registering as owned before this point would make prompt and
    // approve 409 against an id the caller was just handed.
    const metadata = await session.waitForInitialization();
    const id = metadata.sessionId ?? session.sessionId;
    if (id === undefined) {
      await session.close().catch(() => {});
      throw new Error('session initialized without an id');
    }

    const record: OwnedSessionInfo = {
      id,
      cwd,
      model,
      createdAt: new Date().toISOString(),
    };
    this.sessions.set(id, session);
    this.info.set(id, record);
    this.owned.add(id);
    return record;
  }

  /**
   * Queue a prompt for an owned session.
   *
   * Contract: resolves once the turn has been ACCEPTED, not once it completes.
   * Awaiting completion would hold the HTTP response open for the entire turn —
   * minutes, for a long agent run — while the browser is already receiving that
   * turn's output over SSE. Turns are chained per session so two rapid posts
   * serialize instead of racing `assertCanSend`.
   */
  async submitPrompt(sessionId: string, text: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`session ${sessionId} is not owned by this process`);

    const previous = this.turns.get(sessionId) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        this.busy.add(sessionId);
        try {
          // The ledger is written as a side effect of the turn; the SSE route
          // tails it. Draining just runs the turn to completion.
          for await (const _event of session.sendMessageStream(text)) {
            void _event;
          }
        } finally {
          this.busy.delete(sessionId);
        }
      });

    this.turns.set(sessionId, next);
    // Surface nothing to the caller beyond acceptance, but never leave an
    // unhandled rejection: a failed turn records an `error` in the ledger,
    // which is the browser's channel for it.
    next.catch(() => {});
  }

  /** True while a turn is in flight — drives the Stop affordance. */
  isBusy(sessionId: string): boolean {
    return this.busy.has(sessionId);
  }

  /** Soft-interrupt an in-flight turn. The session stays usable afterwards. */
  async interrupt(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`session ${sessionId} is not owned by this process`);
    await session.interrupt();
  }

  list(): OwnedSessionInfo[] {
    return [...this.info.values()];
  }

  /**
   * Close every owned session.
   *
   * Contract: failures are swallowed per session so one wedged close cannot
   * strand the others — this runs on the shutdown path, where partial teardown
   * is strictly worse than best-effort teardown.
   */
  async closeAll(): Promise<void> {
    const all = [...this.sessions.values()];
    this.sessions.clear();
    this.info.clear();
    this.owned.clear();
    this.busy.clear();
    this.turns.clear();
    await Promise.all(all.map((s) => s.close().catch(() => {})));
  }
}
