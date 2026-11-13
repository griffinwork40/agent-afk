/**
 * Main-session fallback model (`models.fallback`) for {@link ProviderRouter}:
 * arming, consuming `model.fallback_request`, swapping, replaying, notifying.
 *
 * Extracted from provider-router.ts (350-code-line ceiling). The router keeps
 * only short call sites; it hands itself in as a {@link FallbackRouterHost}.
 * All state lives on the per-router {@link ModelFallbackController} instance
 * (never module scope), so two sessions never share a "fallback used" flag.
 *
 * @module agent/providers/router/provider-router.fallback
 */

import type {
  ModelFallbackReason,
  ProviderEvent,
  ProviderQuery,
  ProviderUserTurn,
} from '../../provider.js';
import type { AgentConfig } from '../../types/config-types.js';
import type { JournalMessage } from '../../journal/index.js';
import type { QueryInputStream } from '../../session/input-iterable.js';
import { resolveModelId } from '../../session/model-resolution.js';
import { emitSessionPhase } from '../../trace/emit.js';
import { interruptedTurnCompletedEvent } from '../anthropic-direct/query-events.js';
import { buildSwitchNotice, prependNotice } from './provider-router.switch.js';
import { debugLog } from '../../../utils/debug.js';

/** One constructed inner provider plus the plumbing to drive it. */
export interface ActiveInner {
  family: string;
  /**
   * Routing signature the inner was built for: family + resolved endpoint(s) +
   * resolved apiKey (see `ProviderRouter.resolveInner`). A switch whose target
   * signature differs requires a REBUILD; `family` alone is too coarse.
   */
  signature: string;
  query: ProviderQuery;
  iterator: AsyncIterator<ProviderEvent>;
  input: QueryInputStream;
}

/** The router surface the fallback swap drives (ProviderRouter satisfies it structurally). */
export interface FallbackRouterHost {
  active: ActiveInner | undefined;
  currentModel: string | undefined;
  activeModel: string | undefined;
  pendingAssistantText: string;
  closed: boolean;
  readonly baseConfig: AgentConfig;
  buildInner(model: string | undefined, seed: boolean, live?: JournalMessage[]): ActiveInner;
  closeActive(): Promise<void>;
  setModel(model?: string): Promise<void>;
}

/** Router deps the controller reads. */
export interface FallbackDeps {
  providerNameForModel: (model: string | undefined) => string;
  /** Raw configured fallback model input (alias, tier, or id), or undefined. */
  getFallbackModel?: () => string | undefined;
}

type FallbackRequest = Extract<ProviderEvent, { type: 'model.fallback_request' }>;

/**
 * Routing identity of a model input: provider family + resolved concrete id.
 * `sonnet` and the id it is bound to compare equal; raw strings would not.
 */
function modelIdentity(deps: FallbackDeps, model: string | undefined): string {
  return `${deps.providerNameForModel(model)}\u0000${resolveModelId(model) ?? model ?? ''}`;
}

/** Drop exactly ONE trailing user-role entry (the failed turn's message). */
export function stripFailedUserTurn(snapshot: JournalMessage[] | undefined): JournalMessage[] | undefined {
  if (snapshot === undefined || snapshot.length === 0) return snapshot;
  return snapshot[snapshot.length - 1]!.role === 'user' ? snapshot.slice(0, -1) : snapshot;
}

function resetTimeOf(error: Error): Date | undefined {
  const info = (error as { info?: { resetsAt?: unknown } }).info;
  return info?.resetsAt instanceof Date ? info.resetsAt : undefined;
}

/** The one-sentence operator notice for a fallback switch (plain text, no markdown). */
export function fallbackNoticeText(from: string, to: string, reason: ModelFallbackReason, error: Error): string {
  let what: string;
  if (reason === 'usage-limit') {
    const resetsAt = resetTimeOf(error);
    const time = resetsAt?.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
    what = `${from} hit its usage limit${time ? ` (resets ${time})` : ''}`;
  } else if (reason === 'credit-exhausted') {
    what = `${from} is out of credit`;
  } else {
    what = `${from} is not available`;
  }
  return `${what}. Continuing on ${to}. Run /model ${from} to switch back.`;
}

/**
 * Drive a freshly built inner to its `session.init` WITHOUT touching the
 * router's `closed` flag (unlike `driveUntilInit`): a fallback that fails to
 * start must not kill the lane. Returns pre-init events on success, or
 * `undefined` when the inner errored / ended before init.
 */
async function driveInitQuietly(inner: ActiveInner): Promise<ProviderEvent[] | undefined> {
  const pre: ProviderEvent[] = [];
  while (true) {
    const r = await inner.iterator.next();
    if (r.done || r.value.type === 'error') return undefined;
    if (r.value.type === 'session.init') return pre;
    pre.push(r.value);
  }
}

/** Build + init an inner; any synchronous throw or init failure reads as `undefined`. */
async function startInner(
  host: FallbackRouterHost,
  model: string | undefined,
  live: JournalMessage[] | undefined,
): Promise<ProviderEvent[] | undefined> {
  try {
    host.active = host.buildInner(model, /* seed */ true, live);
    const pre = await driveInitQuietly(host.active);
    if (pre !== undefined) return pre;
  } catch (err) {
    debugLog(`ProviderRouter: inner for ${String(model)} failed to start: ${String(err)}`);
  }
  await host.closeActive();
  return undefined;
}

export class ModelFallbackController {
  private used = false;
  private swapping = false;
  private interruptPending = false;
  private deferredModel: string | undefined;

  constructor(
    private readonly host: FallbackRouterHost,
    private readonly deps: FallbackDeps,
  ) {}

  /** LIVE predicate handed to every inner as `modelFallbackArmed`. */
  readonly armed = (): boolean => this.isEligible();

  isEligible(): boolean {
    if (this.used || this.host.baseConfig.isSubagentFork === true) return false;
    const fallback = this.deps.getFallbackModel?.();
    if (fallback === undefined || fallback.length === 0) return false;
    return modelIdentity(this.deps, fallback) !== modelIdentity(this.deps, this.host.currentModel);
  }

  /**
   * Record an interrupt that arrives mid-swap. Returns true when swallowed:
   * `closeActive` clears `active` before awaiting, and forwarding into the
   * fresh inner would park an abort that ends its lane (anthropic-direct
   * `driveTurns` returns on a drained abort). The swap synthesises the terminal.
   */
  noteInterrupt(): boolean {
    if (this.swapping) this.interruptPending = true;
    return this.swapping;
  }

  /** Defer a `/model` that arrives mid-swap; applied once the swap completes. */
  deferSetModel(model: string | undefined): boolean {
    if (this.swapping && typeof model === 'string' && model.length > 0) this.deferredModel = model;
    return this.swapping;
  }

  /**
   * Consume a `model.fallback_request` (never yielded to the session). Yields
   * whatever the session should see. Returns true when the turn was replayed
   * on the fallback and the router must keep pumping the SAME turn; false when
   * a terminal (error / interrupted turn.completed) was already yielded.
   */
  async *consume(request: FallbackRequest, turn: ProviderUserTurn): AsyncGenerator<ProviderEvent, boolean> {
    if (!this.isEligible()) {
      // Race / stale inner: armed when the tier asked, not now. End as an error does.
      yield { type: 'error', error: request.error };
      return false;
    }
    this.swapping = true;
    try {
      return yield* this.swap(request, turn);
    } finally {
      this.swapping = false;
      this.interruptPending = false;
      const deferred = this.deferredModel;
      this.deferredModel = undefined;
      if (deferred !== undefined) await this.host.setModel(deferred);
    }
  }

  // Invariant: the swap order below is load-bearing; each step names why.
  //   a. mark used FIRST: every inner built from here on reads armed=false,
  //      so neither the fallback nor a restored primary can loop.
  //   b. snapshot the outgoing inner's journal while it is still live.
  //   c. FULLY close the outgoing inner before building the next: its
  //      teardown syncs the journal, and building first would let that sync
  //      truncate under the new inner.
  //   d. strip exactly ONE trailing user entry (the failed turn); an earlier
  //      errored turn's user entry just before it must stay. No journal: the
  //      snapshot is undefined and the text shadow holds only prior turns
  //      (the failed turn is still `pendingUserText`), so nothing to strip.
  //   e. move currentModel/activeModel to the fallback so the next turn
  //      boundary does not swap back.
  //   f. build the fallback seeded from the stripped snapshot; swallow init.
  //   g/h. notice to the operator, then the `model_fallback` trace phase.
  //   i. reset the assistant carry and replay the ORIGINAL turn content (the
  //      snapshot entry may have been mutated by image handling) with the
  //      model-visible switch notice; the shadow records the user's real text
  //      once, from `pendingUserText`, only for the successful attempt.
  // A fallback that fails to START (sync throw or init error) restores the
  // primary on the UNSTRIPPED snapshot and surfaces the original error. The
  // OpenAI-compatible provider yields `session.init` BEFORE a credential
  // error, so a bad fallback key can also surface after the swap as an
  // ordinary turn error on the fallback model; that is acceptable.
  private async *swap(request: FallbackRequest, turn: ProviderUserTurn): AsyncGenerator<ProviderEvent, boolean> {
    const host = this.host;
    const to = this.deps.getFallbackModel?.() ?? '';
    const prevCurrent = host.currentModel;
    const prevActive = host.activeModel;
    const from = prevActive ?? prevCurrent ?? '(unset)';
    const previousFamily = host.active?.family;
    this.used = true; // a
    const snapshot = host.active?.query.journalSnapshot?.(); // b
    await host.closeActive(); // c
    const stripped = stripFailedUserTurn(snapshot); // d
    if (host.closed) return false;
    if (this.interruptPending) {
      // Interrupted before the switch happened: cancel it, primary stays armed.
      this.used = false;
      yield* this.restorePrimary(prevCurrent, prevActive, snapshot);
      yield interruptedTurnCompletedEvent(turn.sessionId ?? '');
      return false;
    }
    host.currentModel = to; // e
    host.activeModel = to;
    const pre = await startInner(host, to, stripped); // f
    if (pre === undefined) {
      yield* this.restorePrimary(prevCurrent, prevActive, snapshot);
      yield { type: 'error', error: request.error };
      return false;
    }
    yield { type: 'notice', kind: 'model-fallback', fallback: { from, to, reason: request.reason }, text: fallbackNoticeText(from, to, request.reason, request.error) }; // g
    void emitSessionPhase(host.baseConfig.traceWriter, { phase: 'model_fallback', metadata: { fromModel: from, toModel: to, reason: request.reason } }); // h
    debugLog(`ProviderRouter: model fallback ${from} → ${to} (${request.reason})`);
    for (const ev of pre) yield ev;
    if (this.interruptPending) {
      yield interruptedTurnCompletedEvent(turn.sessionId ?? '');
      return false;
    }
    host.pendingAssistantText = ''; // i
    const notice = buildSwitchNotice(from, to, previousFamily, host.active!.family);
    host.active!.input.pushUserMessage(prependNotice(turn.content, notice));
    return true;
  }

  /** Rebuild the primary on the unstripped snapshot; on failure leave no inner (the next turn rebuilds). */
  private async *restorePrimary(
    prevCurrent: string | undefined,
    prevActive: string | undefined,
    snapshot: JournalMessage[] | undefined,
  ): AsyncGenerator<ProviderEvent, void> {
    this.host.currentModel = prevCurrent;
    this.host.activeModel = prevActive;
    const pre = await startInner(this.host, prevActive, snapshot);
    if (pre !== undefined) for (const ev of pre) yield ev;
  }
}
