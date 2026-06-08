/**
 * ProviderRouter — per-turn, per-model provider routing for the interactive
 * main session.
 *
 * Problem it solves: `AgentSession` historically bound exactly ONE provider at
 * construction, and `setModel()` only changed the model STRING inside that
 * bound provider. So `/model gpt-5.5` in a session started on a Claude model
 * kept hitting the Anthropic API. Users worked around it with `AFK_PROVIDER`,
 * which force-routes EVERY model (including subagents' Claude picks) to one
 * provider — a sledgehammer that breaks mixed-provider orchestration.
 *
 * This class is a {@link ProviderQuery} facade the session installs as its
 * single `providerQuery`. It owns ONE active inner provider at a time; its
 * long-lived async-iterator pumps the active inner and yields its events
 * straight through. When the selected model's provider FAMILY changes, at the
 * next turn boundary it tears down the inner, constructs the target inner
 * (seeded with a router-maintained text shadow history), swallows the new
 * inner's `session.init`, and keeps pumping.
 *
 * Why this beats a session-level reset (the rejected "fork-on-switch"): the
 * swap happens BELOW the session. `AgentSession`'s cost/token/turn accumulators
 * and its SessionStart/SessionEnd hooks (see `agent-session.ts` /
 * `hooks-dispatch.ts`) are untouched by an inner swap — only the inner provider
 * is replaced. So a model switch does not zero budgets or re-fire lifecycle
 * hooks.
 *
 * Invariant: this router is installed ONLY when `config.provider` is unset
 * (no caller-injected provider). When a caller injects a provider, the session
 * uses it directly and this router is never constructed — so injected-provider
 * behavior is unchanged.
 *
 * Invariant: history does NOT round-trip across families at full fidelity.
 * Anthropic `thinking` blocks carry crypto signatures with no OpenAI
 * equivalent, and tool-call ID schemas differ. The router therefore carries a
 * TEXT-ONLY shadow history (`ResumeHistoryTurn[]`) across a family switch — the
 * new model sees prior turns as plain prose, not structured tool/thinking
 * content. This is the documented, accepted degradation for cross-provider
 * switches; same-family runs keep full native fidelity inside the live inner.
 *
 * @module agent/providers/router/provider-router
 */

import type {
  ModelProvider,
  ProviderQuery,
  ProviderEvent,
  ProviderUserTurn,
  ProviderCommandInfo,
  ProviderModelInfo,
  ProviderAgentInfo,
  ProviderContextUsage,
  ProviderMcpServerStatus,
  ProviderAccountInfo,
  ProviderRewindResult,
  ProviderCompactResult,
} from '../../provider.js';
import type { AgentConfig, ResumeHistoryTurn } from '../../types/config-types.js';
import { QueryInputStream } from '../../session/input-iterable.js';
import { applySlotCredentials } from '../../session/slot-credentials.js';
import { debugLog } from '../../../utils/debug.js';

/** Collaborators injected for testability (real impls come from the providers/auth layer). */
export interface ProviderRouterDeps {
  /** Map a model id/alias to its concrete provider instance (e.g. `resolveProvider`). */
  resolveProvider: (model: string | undefined) => ModelProvider;
  /** Cheap classifier: the provider FAMILY name for a model (e.g. `providerForModel`). */
  providerNameForModel: (model: string | undefined) => string;
  /**
   * Resolve the API key for a model's OWN provider family, never another
   * family's (anti-leak). Returns undefined when the provider should fall back
   * to its own env source (e.g. `resolveCredentialForModel`).
   */
  resolveApiKey: (model: string | undefined) => string | undefined;
}

export interface ProviderRouterArgs {
  /** Outer input stream from the session (one long-lived iterable). */
  prompt: AsyncIterable<ProviderUserTurn>;
  config: AgentConfig;
}

/** One constructed inner provider plus the plumbing to drive it. */
interface ActiveInner {
  family: string;
  query: ProviderQuery;
  iterator: AsyncIterator<ProviderEvent>;
  input: QueryInputStream;
}

function stringifyUserContent(content: ProviderUserTurn['content']): string {
  if (typeof content === 'string') return content;
  // ContentBlockParam[] — extract text blocks for the text-only shadow history.
  // Non-text blocks (images) are dropped from the carry; this is intentional.
  return content
    .map((block) => {
      const b = block as { type?: string; text?: string };
      return b.type === 'text' && typeof b.text === 'string' ? b.text : '';
    })
    .filter((t) => t.length > 0)
    .join('\n');
}

export class ProviderRouter implements ProviderQuery {
  private readonly outerIterator: AsyncIterator<ProviderUserTurn>;
  private readonly baseConfig: AgentConfig;
  private readonly deps: ProviderRouterDeps;

  /** The model the NEXT turn should run on (updated by `setModel`). */
  private currentModel: string | undefined;
  /** Permission mode / cwd carried across inner swaps. */
  private currentPermissionMode: AgentConfig['permissionMode'];
  private currentCwd: string | undefined;
  /** The provider family `config.apiKey` was resolved for (anti-leak gate). */
  private readonly startupFamily: string;

  private active: ActiveInner | undefined;
  private closed = false;

  /** Text-only conversation carry, seeded from any resumeHistory, grown per turn. */
  private readonly shadowHistory: ResumeHistoryTurn[];
  private pendingUserText: string | undefined;
  private pendingAssistantText = '';
  /** sessionId of the most recent outer turn, forwarded to inner input streams. */
  private lastSessionId: string | undefined;

  constructor(args: ProviderRouterArgs, deps: ProviderRouterDeps) {
    this.outerIterator = args.prompt[Symbol.asyncIterator]();
    this.baseConfig = args.config;
    this.deps = deps;
    this.currentModel = typeof args.config.model === 'string' ? args.config.model : undefined;
    this.currentPermissionMode = args.config.permissionMode;
    this.currentCwd = args.config.cwd;
    this.startupFamily = deps.providerNameForModel(this.currentModel);
    this.shadowHistory = [...(args.config.resumeHistory ?? [])];
  }

  // ---- inner construction -------------------------------------------------

  /**
   * Build the inner provider for `model`. When `seed` is true (a family swap),
   * the inner is seeded with the text shadow history so the new model sees
   * prior turns as prose. Credentials are resolved for the model's OWN family.
   */
  private buildInner(model: string | undefined, seed: boolean): ActiveInner {
    const provider = this.deps.resolveProvider(model);
    const input = new QueryInputStream(() => this.lastSessionId);

    const innerConfig: AgentConfig = { ...this.baseConfig };
    innerConfig.model = (model ?? this.baseConfig.model) as AgentConfig['model'];

    // Anti-leak credential rule: honor an explicit/startup-resolved key only
    // for the family it was resolved for; otherwise resolve the key for THIS
    // model's family (never inherit another family's credential).
    const apiKey =
      provider.name === this.startupFamily && this.baseConfig.apiKey !== undefined
        ? this.baseConfig.apiKey
        : this.deps.resolveApiKey(model);
    if (apiKey !== undefined) innerConfig.apiKey = apiKey;
    else delete (innerConfig as { apiKey?: string }).apiKey;

    // Per-tier slot credentials (model-slots Stage 2) override when a slot
    // carries explicit provider/baseUrl/apiKey for the (possibly aliased) model.
    applySlotCredentials(innerConfig);

    // Carry mid-session permission-mode / cwd changes onto the new inner.
    if (this.currentPermissionMode !== undefined) innerConfig.permissionMode = this.currentPermissionMode;
    if (this.currentCwd !== undefined) innerConfig.cwd = this.currentCwd;

    if (seed) innerConfig.resumeHistory = [...this.shadowHistory];

    const query = provider.query({ prompt: input.createIterable(), config: innerConfig });
    return {
      family: provider.name,
      query,
      iterator: (query as AsyncIterable<ProviderEvent>)[Symbol.asyncIterator](),
      input,
    };
  }

  private async closeActive(): Promise<void> {
    const a = this.active;
    if (!a) return;
    this.active = undefined;
    try {
      await a.iterator.return?.(undefined as never);
    } catch {
      /* iterator already done */
    }
    try {
      await a.query.close();
    } catch {
      /* provider already closed */
    }
  }

  // ---- shadow history -----------------------------------------------------

  private observeEvent(ev: ProviderEvent): void {
    if (ev.type === 'assistant.message') {
      this.pendingAssistantText += (this.pendingAssistantText ? '\n' : '') + ev.text;
    }
  }

  private commitShadowTurn(): void {
    if (this.pendingUserText === undefined) return;
    this.shadowHistory.push({ user: this.pendingUserText, assistant: this.pendingAssistantText });
    this.pendingUserText = undefined;
    this.pendingAssistantText = '';
  }

  // ---- the multiplexing event lane ---------------------------------------

  async *[Symbol.asyncIterator](): AsyncGenerator<ProviderEvent, void, unknown> {
    try {
      // Construct the first inner and surface its session.init to the session.
      this.active = this.buildInner(this.currentModel, /* seed */ false);
      yield* this.driveUntilInit(/* swallow */ false);

      while (!this.closed) {
        const next = await this.outerIterator.next();
        if (next.done) break;
        const turn = next.value;
        this.lastSessionId = turn.sessionId;

        // Switch the inner provider at this turn boundary if the family changed.
        const targetFamily = this.deps.providerNameForModel(this.currentModel);
        if (!this.active || targetFamily !== this.active.family) {
          await this.closeActive();
          this.active = this.buildInner(this.currentModel, /* seed */ true);
          debugLog(`🔀 ProviderRouter: switched inner provider → ${this.active.family} (model=${this.currentModel})`);
          // Swallow the new inner's session.init; propagate a construction error.
          const failed = yield* this.driveUntilInit(/* swallow */ true);
          if (failed) break;
        }

        // Route the user turn to the active inner and pump until turn end.
        this.pendingUserText = stringifyUserContent(turn.content);
        this.pendingAssistantText = '';
        this.active!.input.pushUserMessage(turn.content);

        while (true) {
          const r = await this.active!.iterator.next();
          if (r.done) {
            this.closed = true;
            break;
          }
          const ev = r.value;
          this.observeEvent(ev);
          yield ev;
          if (ev.type === 'turn.completed') {
            this.commitShadowTurn();
            break;
          }
          if (ev.type === 'error') {
            this.commitShadowTurn();
            break;
          }
        }
      }
    } finally {
      await this.closeActive();
    }
  }

  /**
   * Drive the active inner until its `session.init`. When `swallow` is false
   * (the first inner) the init is yielded to the session; when true (a swap)
   * it is swallowed so the session never sees a re-init. Returns `true` if the
   * inner failed during init (an `error` event was propagated and routing
   * should stop).
   */
  private async *driveUntilInit(swallow: boolean): AsyncGenerator<ProviderEvent, boolean> {
    while (true) {
      const r = await this.active!.iterator.next();
      if (r.done) {
        yield { type: 'error', error: new Error('provider ended before initialization') };
        this.closed = true;
        return true;
      }
      const ev = r.value;
      if (ev.type === 'session.init') {
        if (!swallow) yield ev;
        return false;
      }
      if (ev.type === 'error') {
        yield ev;
        this.closed = true;
        return true;
      }
      // Any other pre-init event: pass it through (rare; keeps the lane honest).
      yield ev;
    }
  }

  // ---- ProviderQuery delegation ------------------------------------------

  async interrupt(): Promise<void> {
    await this.active?.query.interrupt();
  }

  async setModel(model?: string): Promise<void> {
    if (typeof model === 'string' && model.length > 0) {
      this.currentModel = model;
      // Same-family switch: forward to the live inner so the next turn uses the
      // new model string. Cross-family switch: recorded only — the swap happens
      // at the next turn boundary in the event lane.
      if (this.active && this.deps.providerNameForModel(model) === this.active.family) {
        await this.active.query.setModel(model);
      }
    }
  }

  async setPermissionMode(mode: string): Promise<void> {
    this.currentPermissionMode = mode as AgentConfig['permissionMode'];
    await this.active?.query.setPermissionMode(mode);
  }

  setCwd(cwd: string): void {
    this.currentCwd = cwd;
    this.active?.query.setCwd?.(cwd);
  }

  async reauth(): Promise<{ accountId: string; swapped: boolean } | null> {
    return (await this.active?.query.reauth?.()) ?? null;
  }

  async supportedCommands(): Promise<ProviderCommandInfo[]> {
    return (await this.active?.query.supportedCommands()) ?? [];
  }

  async supportedModels(): Promise<ProviderModelInfo[]> {
    return (await this.active?.query.supportedModels()) ?? [];
  }

  async supportedAgents(): Promise<ProviderAgentInfo[]> {
    return (await this.active?.query.supportedAgents()) ?? [];
  }

  async getContextUsage(): Promise<ProviderContextUsage> {
    return (await this.active?.query.getContextUsage()) ?? {};
  }

  async mcpServerStatus(): Promise<ProviderMcpServerStatus[]> {
    return (await this.active?.query.mcpServerStatus()) ?? [];
  }

  async accountInfo(): Promise<ProviderAccountInfo> {
    return (await this.active?.query.accountInfo()) ?? {};
  }

  async rewindFiles(
    userMessageId: string,
    options?: { dryRun?: boolean },
  ): Promise<ProviderRewindResult> {
    const a = this.active;
    if (!a) return { canRewind: false, error: 'no active provider' };
    return a.query.rewindFiles(userMessageId, options);
  }

  async compact(): Promise<ProviderCompactResult> {
    const a = this.active;
    if (a?.query.compact) return a.query.compact();
    return {
      compacted: false,
      reason: 'provider does not support compaction',
      messagesBefore: 0,
      messagesAfter: 0,
    };
  }

  /**
   * Duck-typed passthrough for `/reload-plugins` (the session reads this off
   * the live query via structural typing — see `plugin-skills.ts`). Forwards to
   * the active inner when it implements the method; no-op otherwise.
   */
  async reloadPlugins(...args: unknown[]): Promise<unknown> {
    const inner = this.active?.query as unknown as {
      reloadPlugins?: (...a: unknown[]) => unknown;
    };
    if (inner && typeof inner.reloadPlugins === 'function') {
      return inner.reloadPlugins(...args);
    }
    return undefined;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.closeActive();
  }
}
