/** Web-owned accounting and stable-id projection around canonical session controls.
 * Admission belongs exclusively to the commands route, not this adapter.
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { clearConversation } from '../agent/session-control/index.js';
import { FastModeController } from '../agent/fast-mode.js';
import { resolveModelId } from '../agent/session/model-resolution.js';
import { SessionLedgerWriter, type LedgerPayload } from '../agent/session-ledger.js';
import { projectJournalMessages, readLedgerCostTotals, readLedgerToolDurations, readProjectionMessages } from './session-owner.projection.js';
import { archiveSessionLedger } from './ledger-archive.js';
import { getSessionLedgerDir, getSessionLedgerPath } from '../paths.js';
import { recordTurn } from '../cli/slash/session-stats.js';
import { saveSession } from '../cli/session-store.js';
import type { SessionAutosaver } from '../cli/session-autosave.js';
import type { AgentSession } from '../agent/session/agent-session.js';
import type { SlashCommand, SlashContext, SessionStats } from '../cli/slash/types.js';
import type { CommandControl } from './shared/command-wire.js';
import type { SessionOwner } from './session-owner.js';
import {
  handleWebExit,
  handleWebFork,
  handleWebResumeList,
  handleWebResumeTarget,
} from './session-owner.lifecycle.js';

export interface SessionControlResult {
  result: Awaited<ReturnType<SlashCommand['handler']>>;
  control?: CommandControl;
  session?: { model?: string; name?: string; thinkingUi?: 'summary' | 'live' | 'digest' | 'off' };
}

/** One instance per owned session, including before provider construction. */
export class WebSessionControl {
  readonly fastMode: FastModeController;
  private projection: SessionLedgerWriter | undefined;
  private bound = false;

  constructor(
    readonly id: string,
    private readonly session: AgentSession,
    private readonly stats: SessionStats,
    private readonly onMetadata: (metadata: { model: string; name?: string }) => void,
    fastMode = new FastModeController(),
    private readonly hasCustomEndpoint = false,
    private readonly owner?: SessionOwner,
  ) { this.fastMode = fastMode; }

  /** Same controller passed to the owning provider, never a UI-only toggle. */
  context(): Pick<SlashContext, 'fastMode' | 'getFastModeContext'> {
    return {
      fastMode: this.fastMode,
      getFastModeContext: () => ({
        resolvedModelId: resolveModelId(this.stats.model) ?? String(this.stats.model),
        // WebSessionWiring currently explicitly constructs this provider family.
        providerFamily: 'anthropic-direct',
        hasCustomEndpoint: this.hasCustomEndpoint,
        executionPath: 'top-level',
      }),
    };
  }

  /** Drain helper receives this saver WITHOUT its legacy second stats update. */
  autosaver(onError: (error: unknown) => void): SessionAutosaver {
    this.stats.sessionId = this.id;
    this.stats.source = 'web';
    let reported = false;
    return {
      stats: this.stats,
      saveTurn: (input, text, metadata, tools) => {
        try {
          recordTurn(this.stats, input, text, metadata, tools);
          this.stats.sessionId = this.id;
          this.persist();
        } catch (error) {
          if (!reported) { reported = true; onError(error); }
        }
      },
    };
  }

  async execute(cmd: SlashCommand, ctx: SlashContext, args: string): Promise<SessionControlResult> {
    if (cmd.name === '/clear') {
      // Do not infer success from shared handler's 'continue': it catches errors.
      await clearConversation(this.session, this.stats);
      await this.session.waitForInitialization();
      this.stats.sessionId = this.id;
      await this.resetProjection();
      this.persist();
      this.onMetadata({ model: String(this.stats.model) });
      ctx.out.success('Conversation history cleared.');
      return { result: 'continue', control: { kind: 'clear' } };
    }

    // Lifecycle commands: handled by session-owner.lifecycle.ts.
    if (cmd.name === '/exit' || cmd.name === '/quit') {
      if (!this.owner) { ctx.out.error('exit not available (no owner)'); return { result: 'continue' }; }
      const control = await handleWebExit(this.owner, this.id, ctx);
      return { result: 'continue', control };
    }
    if (cmd.name === '/fork' || cmd.name === '/branch') {
      if (!this.owner) { ctx.out.error('fork not available (no owner)'); return { result: 'continue' }; }
      const control = await handleWebFork(this.owner, this.id, ctx);
      return { result: 'continue', control: typeof control === 'string' ? { kind: 'continue' } : control };
    }
    if (cmd.name === '/resume') {
      if (!this.owner) { ctx.out.error('resume not available (no owner)'); return { result: 'continue' }; }
      const target = args.trim();
      if (!target) {
        await handleWebResumeList(ctx);
        return { result: 'continue' };
      }
      const control = await handleWebResumeTarget(this.owner, this.id, ctx, target);
      return { result: 'continue', control: typeof control === 'string' ? { kind: 'continue' } : control };
    }

    Object.assign(ctx, this.context());
    const result = cmd.name === '/rewind'
      ? await this.executeRewind(cmd, ctx, args)
      : await cmd.handler(ctx, args);
    this.stats.sessionId = this.id;
    this.onMetadata({ model: String(this.stats.model), ...(this.stats.name ? { name: this.stats.name } : {}) });
    // An explicit /name is shown exactly as typed; `name` (the slug) stays the resume key.
    const shownName = this.stats.nameExplicit ? (this.stats.displayName ?? this.stats.name) : this.stats.name;
    if (cmd.name === '/model' || cmd.name === '/name' || cmd.name === '/thinking') {
      // Metadata is authoritative even when validation rejected the requested value.
      this.persist();
      return { result, session: { model: String(this.stats.model), ...(this.stats.name ? { name: shownName, ...(this.stats.nameExplicit ? { nameExplicit: true } : {}) } : {}), ...(cmd.name === '/thinking' ? { thinkingUi: this.stats.thinkingUi ?? 'live' } : {}) } };
    }
    return { result };
  }

  /** Observe the actual provider result, not the handler's caught 'continue'.
   * The route already owns the session reservation throughout this call.
   */
  private async executeRewind(cmd: SlashCommand, ctx: SlashContext, args: string): Promise<SessionControlResult['result']> {
    const rewind = this.session.rewindConversation;
    this.session.rewindConversation = async (index) => {
      await readProjectionMessages(this.session); // fail closed BEFORE provider mutation
      // Read cost totals from the CURRENT ledger before it is archived so we
      // can inject them into the rebuilt projection (journals carry no billing).
      const priorCost = await readLedgerCostTotals(this.id);
      const toolDurations = await readLedgerToolDurations(this.id);
      const result = await rewind.call(this.session, index);
      if (result.rewound) {
        const retained = projectJournalMessages(await readProjectionMessages(this.session), priorCost, toolDurations);
        // Unlike clear, rewind doesn't seal the AgentSession's same-id writer.
        await this.session.sealEventLedger();
        await this.resetProjection(retained);
        this.persist();
      }
      return result;
    };
    try { return await cmd.handler(ctx, args); }
    finally { this.session.rewindConversation = rewind; }
  }

  /** Stable browser filename, CURRENT provider journal for /resume. */
  private persist(): void {
    saveSession({ ...this.stats, sessionId: this.session.sessionId ?? this.id }, this.id);
  }

  /** Reset can retain its memoized provider id. Atomically replace the stable
   * ledger so tailers can detect a generation even if it outgrows their offset.
   * The previous ledger is archived first (ledger-archive.ts), never overwritten.
   * When ids match the provider remains the sole writer. Only distinct provider
   * ids need a second, browser-owned projection.
   */
  private async resetProjection(retained: readonly LedgerPayload[] = []): Promise<void> {
    await this.projection?.close('reset');
    mkdirSync(getSessionLedgerDir(this.id), { recursive: true });
    const path = getSessionLedgerPath(this.id);
    const temporary = `${path}.${randomUUID()}.reset`;
    const records: LedgerPayload[] = [{ kind: 'meta', sessionId: this.id, model: String(this.stats.model), ...(this.stats.cwd ? { cwd: this.stats.cwd } : {}) }, ...retained];
    writeFileSync(temporary, records.map((record) => JSON.stringify({ v: 1, ts: Date.now(), ...record })).join('\n') + '\n', { mode: 0o600 });
    archiveSessionLedger(this.id); // never destroy the durable tool-call record (clear and rewind)
    renameSync(temporary, path);
    this.projection = this.session.sessionId !== this.id ? new SessionLedgerWriter(this.id) : undefined;
    if (this.bound) return;
    this.bound = true;
    const sideband = this.session.pushSidebandEvent.bind(this.session);
    this.session.pushSidebandEvent = (event) => {
      if (this.session.sessionId !== this.id) this.projection?.recordEvent(event);
      sideband(event);
    };
    const elicitation = this.session.recordLedgerElicitation.bind(this.session);
    this.session.recordLedgerElicitation = (reqId, request) => {
      if (this.session.sessionId !== this.id) this.projection?.record({ kind: 'elicitation', reqId, request });
      elicitation(reqId, request);
    };
    const send = this.session.sendMessageStream.bind(this.session);
    const control = this;
    this.session.sendMessageStream = async function* (content) {
      // In case a provider retains its id, it already writes this projection.
      const mirror = control.session.sessionId !== control.id;
      if (mirror) {
        const text = typeof content === 'string' ? content : content.map((b) => b.type === 'text' ? b.text : '').join('\n');
        control.projection?.recordUser(text);
      }
      for await (const event of send(content)) {
        if (mirror) control.projection?.recordEvent(event);
        yield event;
      }
    };
  }

  async close(): Promise<void> { await this.projection?.close('close'); }
}
