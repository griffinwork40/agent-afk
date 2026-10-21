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

/** Workspace checkpoint captured from the child's runtime-resolved cwd (D5). */
export interface WorkspaceCheckpoint {
  cwd: string;
  git: boolean;
  branch?: string;
  head?: string;
  dirtyFingerprint?: string;
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
  owner: string;
  rootSessionId: string;
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

export class ContinuationRegistry {
  private readonly chains = new Map<string, ChainRecord>();

  constructor(private readonly limits: ContinuationLimits = CONTINUATION_DEFAULTS) {}

  /** Mint a chain for an initial dispatch; `roundCap` 0 means uncapped. */
  createChain(args: { owner: string; rootSessionId: string; inputs: ChainDispatchInputs; roundCap: number }): ChainRecord {
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
    };
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
  admitContinuation(chainId: string, caller: string, requested: number | undefined, defaultAllowance: number): AdmissionResult {
    const chain = this.chains.get(chainId);
    if (chain === undefined) return { ok: false, reason: `unknown continuation chain "${chainId}" (chains are runtime-minted and in-memory only; they do not survive a restart or /resume)` };
    if (chain.owner !== caller) return { ok: false, reason: `continuation chain "${chainId}" is owned by another actor` };
    if (chain.inFlight) return { ok: false, reason: `a run on continuation chain "${chainId}" is still in flight` };
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

/** One-line machine-readable continuation note (D6). */
export function formatContinuationLine(chain: ChainRecord): string {
  return `[continuation: chain_id=${chain.chainId}, rounds ${chain.roundsCharged}/${chain.limits.maxRounds} used, ` +
    `continuations ${chain.continuations}/${chain.limits.maxContinuations} used; pass continuation_chain_id to continue]`;
}
