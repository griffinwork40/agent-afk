/**
 * RemoteSubagentHandle: a {@link SubagentHandle} implementation that runs a
 * child agent on a remote host via `runRemoteAgent` / SSH rather than forking
 * a local {@link AgentSession}.
 *
 * # First slice (Part of #3869)
 *
 * This module ships the core contract — `SubagentHandle<string>` over the
 * existing remote SSH transport — without touching the local-dispatch path.
 * `agent{host}` and compose-node routing are follow-up work listed in the issue.
 *
 * # Design constraints
 *
 * `SubagentHandle.session` is typed as `IAgentSession`, which is a large
 * interface. A remote handle has no local session object, so we provide a
 * minimal `RemoteSessionStub` that satisfies the type with sensible no-ops
 * and throws on methods that presuppose a local provider (e.g. `sendMessage`).
 * Callers that call `handle.session.sendMessage` directly are doing local-only
 * work and must not receive a remote handle.
 *
 * # Guardrails preserved
 *
 * `isRemoteRun()` / `AFK_REMOTE_DEPTH` refusal lives in the tool handler
 * (`src/agent/tools/handlers/remote-agent.ts`) and is untouched — remote
 * agents still cannot fan out to further remote agents.
 *
 * @module remote/remote-subagent-handle
 */

import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import type { SubagentHandle } from '../agent/subagent/handle.js';
import type { SubagentResult, SubagentStatus } from '../agent/subagent/result.js';
import { buildResultFromMessage, buildResultFromError, createEmptyTrace } from '../agent/subagent/result.js';
import type { Message } from '../agent/types.js';
import type { IAgentSession } from '../agent/types/session-types.js';
import type { OutputEvent } from '../agent/types/session-types.js';
import { runRemoteAgent, type RemoteRunRequest, type RemoteRunDeps } from './remote-run.js';

// ---------------------------------------------------------------------------
// RemoteSessionStub
// ---------------------------------------------------------------------------

/**
 * Minimal stub satisfying {@link IAgentSession} for a remote handle.
 *
 * Contract: methods that require a live local provider throw with a clear
 * message so callers discover the mismatch at runtime. Pure-read accessors
 * return safe defaults.
 *
 * Invariant: this stub is ONLY used inside RemoteSubagentHandle. It must
 * never be returned to code that expects real session behaviour. The cast
 * to IAgentSession in RemoteSubagentHandle's constructor is intentional:
 * the stub is structurally compatible for the methods callers of
 * SubagentHandle.session actually use (state, sessionId, cwd, abortSignal).
 */
class RemoteSessionStub {
  readonly state = 'idle' as const;
  readonly sessionId: string | undefined;
  readonly cwd: string | undefined;
  readonly abortSignal: AbortSignal;

  constructor(sessionId: string | undefined, cwd: string | undefined, signal: AbortSignal) {
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.abortSignal = signal;
  }

  sendMessage(): Promise<Message> {
    return Promise.reject(new Error('RemoteSubagentHandle: sendMessage is not supported — use runToResult() instead'));
  }

  sendMessageStream(): AsyncIterable<OutputEvent> {
    throw new Error('RemoteSubagentHandle: sendMessageStream is not supported');
  }

  async interrupt(): Promise<void> { /* abort handled by the outer controller */ }
  async close(): Promise<void> { /* no local session to close */ }
  async reset(): Promise<void> { throw new Error('RemoteSubagentHandle: reset is not supported'); }
  abort(): void { /* no-op; abort propagated through the shared AbortController */ }

  async setModel(): Promise<void> { throw new Error('RemoteSubagentHandle: setModel is not supported'); }
  async setPermissionMode(): Promise<void> { throw new Error('RemoteSubagentHandle: setPermissionMode is not supported'); }
  async takePendingPlanExitSeed(): Promise<undefined> { return undefined; }

  waitForInitialization(): Promise<import('../agent/types/session-types.js').SessionMetadata> {
    return Promise.resolve({} as import('../agent/types/session-types.js').SessionMetadata);
  }
  getSessionIdentity(): import('../agent/types/session-types.js').SessionIdentity {
    return {} as import('../agent/types/session-types.js').SessionIdentity;
  }
  getSessionMetadata(): import('../agent/types/session-types.js').SessionMetadata {
    return {} as import('../agent/types/session-types.js').SessionMetadata;
  }
  getQuery(): never {
    throw new Error('RemoteSubagentHandle: getQuery is not supported');
  }
  getLastResponseMetadata(): null { return null; }
  getOutputStream(): AsyncIterable<OutputEvent> {
    throw new Error('RemoteSubagentHandle: getOutputStream is not supported');
  }
  getInputStreamRef(): never {
    throw new Error('RemoteSubagentHandle: getInputStreamRef is not supported');
  }
}

// ---------------------------------------------------------------------------
// RemoteSubagentHandle
// ---------------------------------------------------------------------------

/** Options for constructing a {@link RemoteSubagentHandle}. */
export interface RemoteSubagentHandleOptions {
  /** Stable handle ID (e.g. `remote-<host>-<uuid-prefix>`). */
  id: string;
  /** The fully-resolved {@link RemoteRunRequest} (target, runId, sessionId, …). */
  request: RemoteRunRequest;
  /** Transport + sleep injected for testing. */
  deps: RemoteRunDeps;
}

/**
 * {@link SubagentHandle} implementation backed by `runRemoteAgent`.
 *
 * Implements the handle contract with `string` as the result type — remote
 * output is always plain text; Zod output schemas are not supported in this
 * first slice.
 *
 * Only `run()` / `runToResult()` and `cancel()` do real work. The steering,
 * sendMessage, and workspace-delivery methods are no-ops: they require
 * in-process subagent machinery that a remote handle does not have.
 */
export class RemoteSubagentHandle implements SubagentHandle<string> {
  readonly id: string;
  // Invariant: session is a stub; callers must not rely on local-provider methods.
  readonly session: IAgentSession;
  private _status: SubagentStatus = 'idle';
  private _durationMs: number | undefined;
  private readonly _controller: AbortController;
  private readonly _request: RemoteRunRequest;
  private readonly _deps: RemoteRunDeps;

  constructor(options: RemoteSubagentHandleOptions) {
    this.id = options.id;
    this._request = options.request;
    this._deps = options.deps;
    this._controller = new AbortController();
    this.session = new RemoteSessionStub(
      options.request.sessionId,
      options.request.cwd,
      this._controller.signal,
    ) as unknown as IAgentSession;
  }

  get status(): SubagentStatus {
    return this._status;
  }

  get durationMs(): number | undefined {
    return this._durationMs;
  }

  /**
   * Run the remote agent and return a synthetic {@link Message} whose content
   * is the remote reply.
   *
   * Throws on `error` / `lost` / `aborted` outcomes. Use `runToResult()` for
   * a non-throwing interface.
   *
   * Note: the `prompt` parameter is ignored — the handle uses the prompt from
   * the {@link RemoteRunRequest} supplied at construction time. This is
   * single-shot semantics: one handle, one remote run, one prompt.
   */
  async run(_prompt: string | ContentBlockParam[]): Promise<Message> {
    if (this._status === 'running') throw new Error(`RemoteSubagentHandle ${this.id} is already running`);
    if (this._status === 'cancelled') throw new Error(`RemoteSubagentHandle ${this.id} is cancelled`);

    this._status = 'running';
    const start = Date.now();
    try {
      const outcome = await runRemoteAgent(this._request, this._controller.signal, this._deps);
      this._durationMs = Date.now() - start;

      if (outcome.kind === 'aborted') {
        this._status = 'cancelled';
        throw new Error(`remote agent aborted (host=${this._request.target})`);
      }
      if (outcome.kind === 'error' || outcome.kind === 'lost') {
        this._status = 'failed';
        // Include remoteDetail in the error message (mirrors runToResult() and remote-agent.ts handler)
        const detail = outcome.remoteDetail ? `: ${outcome.remoteDetail}` : '';
        throw new Error(`${outcome.reason}${detail}`);
      }
      // kind === 'done'
      this._status = 'succeeded';
      const content: string = outcome.message;
      return { content, role: 'assistant' } as Message;
    } catch (err) {
      this._durationMs = Date.now() - start;
      if (this._status === 'running') this._status = 'failed';
      throw err;
    }
  }

  /**
   * Non-throwing variant of {@link run}.
   *
   * Note: the `prompt` parameter is ignored — the handle uses the prompt from
   * the {@link RemoteRunRequest} supplied at construction time (single-shot
   * semantics).
   */
  async runToResult(_prompt: string | ContentBlockParam[]): Promise<SubagentResult<string>> {
    if (this._status === 'running') {
      return buildResultFromError<string>(this.id, 'failed', new Error(`RemoteSubagentHandle ${this.id} is already running`), createEmptyTrace());
    }
    if (this._status === 'cancelled') {
      return buildResultFromError<string>(this.id, 'cancelled', new Error(`RemoteSubagentHandle ${this.id} is cancelled`), createEmptyTrace());
    }

    this._status = 'running';
    const start = Date.now();
    try {
      const outcome = await runRemoteAgent(this._request, this._controller.signal, this._deps);
      this._durationMs = Date.now() - start;

      if (outcome.kind === 'aborted') {
        this._status = 'cancelled';
        return buildResultFromError<string>(this.id, 'cancelled', new Error(`remote agent aborted (host=${this._request.target})`), createEmptyTrace());
      }
      if (outcome.kind === 'error' || outcome.kind === 'lost') {
        this._status = 'failed';
        // Include remoteDetail in the error message (mirrors remote-agent.ts handler)
        const detail = outcome.remoteDetail ? `: ${outcome.remoteDetail}` : '';
        const err = new Error(`${outcome.reason}${detail}`);
        const partial = outcome.partial;
        const result = buildResultFromError<string>(this.id, 'failed', err, createEmptyTrace());
        if (partial !== undefined && partial !== '') result.partialOutput = partial;
        return result;
      }
      // kind === 'done'
      this._status = 'succeeded';
      const msg: Message = { content: outcome.message, role: 'assistant' } as Message;
      return buildResultFromMessage<string>(this.id, 'succeeded', msg, undefined, createEmptyTrace());
    } catch (err) {
      this._durationMs = Date.now() - start;
      if (this._status === 'running') this._status = 'failed';
      return buildResultFromError<string>(this.id, 'failed', err, createEmptyTrace());
    }
  }

  // R1: .catch() is required — if onResult throws, or if a bug allows an
  // error to escape runToResult's own try/catch, the unhandled rejection
  // would leak into the daemon and leave the handle stuck in 'running'.
  // External constraint: Node process-level 'unhandledRejection' — any
  // naked void promise that rejects terminates the process in strict mode.
  runInBackground(
    prompt: string,
    onResult?: (result: SubagentResult<string>) => void,
  ): void {
    void this.runToResult(prompt).then((result) => {
      onResult?.(result);
    }).catch((err: unknown) => {
      console.error('RemoteSubagentHandle.runInBackground: unexpected rejection:', err);
    });
  }

  async cancel(): Promise<void> {
    if (this._status === 'cancelled') return;
    this._status = 'cancelled';
    // Aborting the controller propagates the abort signal into runRemoteAgent,
    // which then sends `kill <pid>` on the remote (best-effort).
    this._controller.abort('cancelled');
  }

  async teardown(): Promise<void> {
    // For a remote handle, teardown is a no-op — there is no local session
    // to close. If the handle is still running, cancel it.
    if (this._status === 'running') await this.cancel();
  }

  getLastStopInjectContext(): string | undefined {
    return undefined;
  }

  /** No-op: remote handles have no local message queue. */
  sendMessage(_text: string): void { /* no-op */ }

  /** No-op: inter-round steering requires an in-process provider loop. */
  steer(_text: string): void { /* no-op */ }
}
