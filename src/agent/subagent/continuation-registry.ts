/**
 * Runtime-owned subagent continuation chains (docs/subagent-continuation.md).
 *
 * Invariant: chain ids are minted here (unguessable `chain_<random>`), never
 * accepted from model text; an id this registry did not mint is "unknown".
 * Admission (`admitContinuation`) is fully synchronous: check + charge +
 * in-flight set happen in one call with no await, so two parallel
 * continuation calls on one chain can never both pass. The registry is in
 * memory only: chains do not survive a process restart or REPL `/resume`.
 *
 * Accounting (D4): the initial attempt is charged at its resolved round cap
 * (full reservation) or, when uncapped (0), at the runtime-counted rounds it
 * used when it ends. Every continuation gets a FINITE allowance clipped to the
 * remaining aggregate and is charged in full at admission. No refunds; no
 * model-reported counts are ever read.
 *
 * @module agent/subagent/continuation-registry
 */

import { randomBytes } from 'node:crypto';

import { env } from '../../config/env.js';

/** Workspace checkpoint captured from the child's runtime-resolved cwd (D5). */
export interface WorkspaceCheckpoint {
  cwd: string;
  git: boolean;
  branch?: string;
  head?: string;
  dirtyFingerprint?: string;
  /** Set when git status (or the repo probe) failed/timed out: drift checks fail closed. */
  unavailable?: true;
}

/** Dispatch inputs that determine child config; continuation reuses them (D2). */
export interface ChainDispatchInputs {
  agent_type?: string;
  model?: string;
  cwd?: string;
  readRoots?: string[];
  writeRoots?: string[];
  isolation?: 'worktree';
  writeCapable: boolean;
}

export interface ContinuationLimits {
  maxRounds: number;
  maxContinuations: number;
}

export interface ChainRecord {
  chainId: string;
  /** Stable non-empty actor identity (see continuation-dispatch actorIdentity). Never ''. */
  owner: string;
  /** Root session id the child journals live under; undefined when unassigned at mint (resolved at admission). */
  rootSessionId: string | undefined;
  latestChildId: string | undefined;
  inputs: ChainDispatchInputs;
  roundsCharged: number;
  continuations: number;
  limits: ContinuationLimits;
  inFlight: boolean;
  /** True while the initial attempt is uncapped and not yet charged. */
  initialUncharged: boolean;
  checkpoint: WorkspaceCheckpoint | undefined;
  lastEndReason: string | undefined;
  /**
   * Post-result bookkeeping (journal flush + workspace checkpoint) of the
   * latest run, still running. The result is delivered before it finishes;
   * in-flight stays true until it settles. Never rejects.
   */
  settling: Promise<void> | undefined;
  /** A continuation call holds the admission reservation (awaiting settling / drift). */
  admitting: boolean;
}

export type AdmissionResult =
  | { ok: true; chain: ChainRecord; allowance: number; index: number; rollback: () => void }
  | { ok: false; reason: string };

export interface TerminalUpdate {
  childId: string;
  journalUsable: boolean;
  roundsUsed: number;
  checkpoint: WorkspaceCheckpoint | undefined;
  endReason: string;
}

/** Defaults match PR #2811's CONTINUATION_BUDGET_DEFAULTS intent. */
export const CONTINUATION_DEFAULTS: ContinuationLimits = { maxRounds: 150, maxContinuations: 3 };

function parseLimit(raw: string | undefined, min: number, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

/** D4: chain limits from `AFK_SUBAGENT_CONTINUATION_MAX_ROUNDS` / `_MAX_CONTINUATIONS`. */
export function resolveContinuationLimits(): ContinuationLimits {
  return {
    maxRounds: parseLimit(env.AFK_SUBAGENT_CONTINUATION_MAX_ROUNDS, 1, CONTINUATION_DEFAULTS.maxRounds),
    maxContinuations: parseLimit(env.AFK_SUBAGENT_CONTINUATION_MAX_CONTINUATIONS, 0, CONTINUATION_DEFAULTS.maxContinuations),
  };
}

/** Max chains held per registry; beyond it the oldest non-in-flight chains are evicted (then refused as unknown). */
export const MAX_CHAINS = 256;

export class ContinuationRegistry {
  /** Insertion-ordered: iteration yields the oldest chain first. */
  private readonly chains = new Map<string, ChainRecord>();
  /**
   * Per-registry identity of the depth-0 (root) session. The root session's
   * provider id can be unassigned during its first turn, so ownership never
   * keys off it: one registry exists per root session (wire-executors).
   */
  readonly rootActor = `root_${randomBytes(12).toString('hex')}`;

  constructor(
    private readonly limits: ContinuationLimits = resolveContinuationLimits(),
    private readonly maxChains: number = MAX_CHAINS,
  ) {}

  /** Number of chains currently held. */
  get size(): number {
    return this.chains.size;
  }

  /**
   * Bound memory: evict oldest chains that are not in flight until a new one
   * fits under the cap. In-flight chains are never evicted (their terminal
   * must still find them), so the map may briefly exceed the cap when every
   * held chain is in flight.
   */
  private evictForInsert(): void {
    for (const [id, chain] of this.chains) {
      if (this.chains.size < this.maxChains) return;
      if (!chain.inFlight && !chain.admitting) this.chains.delete(id);
    }
  }

  /** Mint a chain for an initial dispatch; `roundCap` 0 means uncapped. */
  createChain(args: { owner: string; rootSessionId: string | undefined; inputs: ChainDispatchInputs; roundCap: number }): ChainRecord {
    if (args.owner === '') throw new Error('continuation chain owner must be a non-empty actor identity');
    const chainId = `chain_${randomBytes(12).toString('hex')}`;
    const record: ChainRecord = {
      chainId,
      owner: args.owner,
      rootSessionId: args.rootSessionId,
      latestChildId: undefined,
      inputs: { ...args.inputs },
      roundsCharged: args.roundCap > 0 ? args.roundCap : 0,
      continuations: 0,
      limits: { ...this.limits },
      inFlight: true,
      initialUncharged: args.roundCap <= 0,
      checkpoint: undefined,
      lastEndReason: undefined,
      settling: undefined,
      admitting: false,
    };
    this.evictForInsert();
    this.chains.set(chainId, record);
    return record;
  }

  get(chainId: string): ChainRecord | undefined {
    return this.chains.get(chainId);
  }

  /**
   * Synchronous admission: refuses unknown chain, non-owner, in-flight,
   * exhausted limits. On success charges the allowance, bumps the count, and
   * sets in-flight; `rollback()` undoes exactly that (fork-construction failure).
   */
  admitContinuation(chainId: string, caller: string, requested: number | undefined, defaultAllowance: number, reserved = false): AdmissionResult {
    const chain = this.chains.get(chainId);
    if (chain === undefined) return { ok: false, reason: `unknown continuation chain "${chainId}" (chains are runtime-minted and in-memory only; they do not survive a restart or /resume)` };
    if (caller === '' || chain.owner !== caller) return { ok: false, reason: `continuation chain "${chainId}" is owned by another actor` };
    if (chain.inFlight) return { ok: false, reason: `a run on continuation chain "${chainId}" is still in flight` };
    if (chain.admitting && !reserved) return { ok: false, reason: admittingReason(chainId) };
    if (chain.continuations >= chain.limits.maxContinuations) {
      return { ok: false, reason: `continuation limit reached (${chain.continuations}/${chain.limits.maxContinuations})` };
    }
    const remaining = chain.limits.maxRounds - chain.roundsCharged;
    if (remaining <= 0) return { ok: false, reason: `aggregate round limit reached (${chain.roundsCharged}/${chain.limits.maxRounds})` };
    const want = requested !== undefined && requested > 0 ? requested : defaultAllowance;
    const allowance = Math.max(1, Math.min(want > 0 ? want : remaining, remaining));
    chain.roundsCharged += allowance;
    chain.continuations += 1;
    chain.inFlight = true;
    const index = chain.continuations;
    let rolledBack = false;
    const rollback = (): void => {
      if (rolledBack) return;
      rolledBack = true;
      chain.roundsCharged -= allowance;
      chain.continuations -= 1;
      chain.inFlight = false;
    };
    return { ok: true, chain, allowance, index, rollback };
  }

  /**
   * Synchronous admission reservation, taken before any await (settling wait,
   * drift git I/O) so a concurrent second call on the chain is refused at once
   * without doing git work. Returns the release function, or a refusal reason.
   * The holder passes `reserved: true` to admitContinuation, then releases.
   */
  reserveAdmission(chainId: string): { ok: true; release: () => void } | { ok: false; reason: string } {
    const chain = this.chains.get(chainId);
    if (chain === undefined) return { ok: false, reason: `unknown continuation chain "${chainId}"` };
    if (chain.admitting) return { ok: false, reason: admittingReason(chainId) };
    chain.admitting = true;
    let released = false;
    return { ok: true, release: () => { if (!released) { released = true; chain.admitting = false; } } };
  }

  /**
   * D4, at the run's end (synchronously, before the result is delivered): an
   * uncapped initial attempt is charged its runtime-counted rounds, so the
   * delivered metadata/line already reflect the charge. Idempotent.
   */
  chargeInitialRounds(chainId: string, roundsUsed: number): void {
    const chain = this.chains.get(chainId);
    if (chain === undefined || !chain.initialUncharged) return;
    chain.roundsCharged += Math.max(0, roundsUsed);
    chain.initialUncharged = false;
  }

  /** Track the latest run's post-result bookkeeping; cleared once it settles. */
  setSettling(chainId: string, settling: Promise<void>): void {
    const chain = this.chains.get(chainId);
    if (chain === undefined) return;
    chain.settling = settling;
    void settling.finally(() => { if (chain.settling === settling) chain.settling = undefined; }).catch(() => undefined);
  }

  /** D9: called on every terminal outcome (foreground and background). */
  recordTerminal(chainId: string, update: TerminalUpdate): void {
    const chain = this.chains.get(chainId);
    if (chain === undefined) return;
    chain.inFlight = false;
    if (update.journalUsable) chain.latestChildId = update.childId;
    if (chain.initialUncharged) {
      chain.roundsCharged += Math.max(0, update.roundsUsed);
      chain.initialUncharged = false;
    }
    chain.checkpoint = update.checkpoint;
    chain.lastEndReason = update.endReason;
  }
}

function admittingReason(chainId: string): string {
  return `a run on continuation chain "${chainId}" is still in flight (another continuation is already being admitted)`;
}

/** One-line machine-readable continuation note (D6). */
export function formatContinuationLine(chain: ChainRecord): string {
  return `[continuation: chain_id=${chain.chainId}, rounds ${chain.roundsCharged}/${chain.limits.maxRounds} used, ` +
    `continuations ${chain.continuations}/${chain.limits.maxContinuations} used; pass continuation_chain_id to continue]`;
}
