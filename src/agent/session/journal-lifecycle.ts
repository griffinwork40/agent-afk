/**
 * Message-journal glue, extracted from {@link AgentSession}
 * (docs/message-journal.md).
 *
 * Owns the session's {@link MessageJournal}: builds it for top-level sessions,
 * replaces it across `reset()` (`/clear`), and closes it with the session. The
 * journal rides on `AgentConfig.messageJournal`, which
 * `buildProviderLifecycle` hands to the provider (the router copies config
 * into its inner providers), and each provider wraps it in a `JournalSync`.
 *
 * Invariant (session-id gating): a journal pins its session id on first
 * resolution. Until {@link JournalLifecycle.arm} runs (right after the provider
 * lifecycle is rebuilt), the accessor answers only with the CONFIGURED id
 * (`config.sessionId`, i.e. the resumed id or `undefined`), never with the
 * previous state manager's id. Otherwise a journal created during `/clear`
 * could pin the pre-clear id on surfaces that mint a new id after a reset.
 * Symmetrically, closing a journal FREEZES its gate at the id it resolves to
 * at that moment: subagent journals (`forSubagent`) share the accessor and
 * outlive the parent's close, so a child whose writer had not resolved yet
 * must pin the PRE-clear id, never the post-clear one.
 *
 * Invariant (forks): a subagent fork (`isSubagentFork` / `parentSessionId`)
 * never builds its own journal. It keeps the `parent.forSubagent(id)` journal
 * that `assembleChildConfig` stamped on its config (children resume the
 * parent's session id, so a fresh top-level journal would write the parent's
 * file), and closes it when the child closes.
 *
 * @module agent/session/journal-lifecycle
 */

import { createMessageJournal, type MessageJournal } from '../journal/index.js';
import type { AgentConfig } from '../types.js';

/** True for configs that belong to a subagent fork rather than a top-level session. */
export function isForkConfig(config: AgentConfig): boolean {
  return config.isSubagentFork === true || config.parentSessionId !== undefined;
}

interface Gate {
  armed: boolean;
  /** `config.sessionId` at open (the only answer before {@link JournalLifecycle.arm}). */
  configuredId: string | undefined;
  /** Set on close: the accessor answers only with this id from then on. */
  frozen?: { id: string | undefined };
}

export class JournalLifecycle {
  private journal: MessageJournal | undefined;
  /** Whether {@link close} should close {@link journal} (false for a caller-injected one). */
  private owned = false;
  private gate: Gate | undefined;

  /** @param getLiveSessionId - reads the CURRENT state manager's id; may throw before init. */
  constructor(private readonly getLiveSessionId: () => string | undefined) {}

  /** The journal currently wired into the provider config, if any. */
  get current(): MessageJournal | undefined {
    return this.journal;
  }

  /**
   * Attach the journal to a config that is about to build a provider lifecycle.
   * Top-level: builds a fresh journal unless the caller injected one. Fork: keeps
   * (and takes ownership of) the subagent journal already on the config.
   */
  open(config: AgentConfig): AgentConfig {
    if (isForkConfig(config)) {
      this.journal = config.messageJournal;
      this.owned = config.messageJournal !== undefined;
      this.gate = undefined;
      return config;
    }
    if (config.messageJournal !== undefined) {
      this.journal = config.messageJournal;
      this.owned = false;
      this.gate = undefined;
      return config;
    }
    const gate: Gate = { armed: false, configuredId: config.sessionId };
    const journal = createMessageJournal({
      getSessionId: () => this.resolveGateId(gate),
      meta: {
        model: String(config.model),
        ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
        ...(config.provider?.name !== undefined ? { provider: config.provider.name } : {}),
      },
    });
    this.journal = journal;
    this.owned = true;
    this.gate = gate;
    return { ...config, messageJournal: journal };
  }

  /**
   * Let the journal resolve against the live state manager. Call after the
   * lifecycle rebuild. Stamps `mark('resume')` when the session was seeded
   * from a journal.
   */
  arm(config: AgentConfig): void {
    if (!this.gate) return;
    this.gate.armed = true;
    if (config.resumeMessages !== undefined && config.resumeMessages.length > 0) {
      this.journal?.mark('resume', { messages: config.resumeMessages.length });
    }
  }

  /**
   * `/clear`, step 1 (during teardown): close an owned top-level journal. A
   * fork's or caller-injected journal is only flushed; it lives until close.
   */
  async closeForReset(): Promise<void> {
    if (this.gate) await this.close();
    else await this.journal?.flush();
  }

  /**
   * `/clear`, step 2 (inside the config patch): drop the owned journal so
   * {@link open} builds a fresh one with a fresh lazy id accessor. Caller-
   * injected and fork journals are kept.
   */
  stripForReset(config: AgentConfig): AgentConfig {
    if (!this.gate) return config;
    const next = { ...config };
    delete next.messageJournal;
    return next;
  }

  /**
   * `/clear`, step 3 (after the rebuild): annotate the fresh journal and fold
   * it to empty. On surfaces that keep the session id across a reset (cli) the
   * new writer resumes the on-disk length, and the provider's `seed([])` may
   * run before the id resolves (seeing length 0 and writing nothing), so this
   * explicit truncate is what guarantees the fold is empty.
   */
  markCleared(): void {
    if (!this.gate) return;
    this.journal?.mark('clear');
    this.journal?.truncate(0, 'clear');
  }

  /** Annotate a live model switch. */
  markModelSwitch(model: string): void {
    this.journal?.mark('model_switch', { model });
  }

  /** Fire-and-forget flush (abort path). */
  flush(): void {
    void this.journal?.flush();
  }

  /** Flush and close an owned journal; flush a borrowed one. Idempotent. */
  async close(): Promise<void> {
    const journal = this.journal;
    if (!journal) return;
    this.freezeGate();
    if (this.owned) await journal.close();
    else await journal.flush();
  }

  /** Pin the current gate to the id it resolves to now (see the fork invariant). */
  private freezeGate(): void {
    const gate = this.gate;
    if (!gate || gate.frozen) return;
    gate.frozen = { id: this.resolveGateId(gate) };
  }

  private resolveGateId(gate: Gate): string | undefined {
    if (gate.frozen) return gate.frozen.id;
    return gate.armed ? this.safeLiveId() : gate.configuredId;
  }

  private safeLiveId(): string | undefined {
    try {
      return this.getLiveSessionId();
    } catch {
      return undefined;
    }
  }
}
