/**
 * Tests for ProviderRouter — per-turn, per-model provider routing.
 *
 * Uses fake providers so routing/swap/delegation/shadow-history/credential
 * behavior is exercised without any real SDK.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ProviderRouter, type ProviderRouterDeps } from './provider-router.js';
import { QueryInputStream } from '../../session/input-iterable.js';
import { resetSlotBindings, setSlotBindings } from '../../session/model-slots.js';
import { resolveModelId } from '../../session/model-resolution.js';
import type { AgentConfig } from '../../types/config-types.js';
import type {
  ModelProvider,
  ProviderQuery,
  ProviderEvent,
  ProviderQueryArgs,
  ProviderUserTurn,
  ProviderContextUsage,
  ProviderAccountInfo,
} from '../../provider.js';

// ---- fakes ----------------------------------------------------------------

interface QueryRecord {
  config: AgentConfig;
  setModelCalls: string[];
  closed: boolean;
}

class FakeQuery implements ProviderQuery {
  readonly rec: QueryRecord;
  private readonly promptIter: AsyncIterator<ProviderUserTurn>;
  private readonly sessionId: string;
  private readonly supportsCompact: boolean;

  constructor(args: ProviderQueryArgs, sessionId: string, supportsCompact: boolean) {
    this.rec = { config: args.config, setModelCalls: [], closed: false };
    this.promptIter = args.prompt[Symbol.asyncIterator]();
    this.sessionId = sessionId;
    this.supportsCompact = supportsCompact;
    if (!supportsCompact) {
      // Mirror a provider that does not implement optional compaction.
      (this as { compact?: unknown }).compact = undefined;
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<ProviderEvent, void, unknown> {
    yield { type: 'session.init', info: { sessionId: this.sessionId, model: String(this.rec.config.model) } };
    while (true) {
      const r = await this.promptIter.next();
      if (r.done) return;
      const userText = typeof r.value.content === 'string' ? r.value.content : '[blocks]';
      yield { type: 'delta.text', text: `echo:${userText}` };
      yield { type: 'assistant.message', text: `reply-from-${this.sessionId}:${userText}` };
      yield { type: 'turn.completed', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    }
  }

  async interrupt(): Promise<void> {}
  async setModel(model?: string): Promise<void> {
    if (model) this.rec.setModelCalls.push(model);
  }
  async setPermissionMode(): Promise<void> {}
  async supportedCommands() {
    return [{ name: `cmd-${this.sessionId}` }];
  }
  async supportedModels() {
    return [{ value: `model-${this.sessionId}` }];
  }
  async supportedAgents() {
    return [];
  }
  async getContextUsage(): Promise<ProviderContextUsage> {
    return { isAutoCompactEnabled: true, marker: this.sessionId };
  }
  async mcpServerStatus() {
    return [{ name: `mcp-${this.sessionId}`, status: 'connected' }];
  }
  async accountInfo(): Promise<ProviderAccountInfo> {
    return { subscriptionType: this.sessionId };
  }
  async rewindFiles() {
    return { canRewind: false };
  }
  listRewindTargets() {
    return [{ turnIndex: 0, preview: `turn-${this.sessionId}` }];
  }
  async rewindConversation(turnIndex: number) {
    return {
      rewound: true,
      reloadText: `reload-${turnIndex}`,
      messagesBefore: 4,
      messagesAfter: turnIndex,
    };
  }
  compact?(): Promise<import('../../provider.js').ProviderCompactResult>;
  close(): void {
    this.rec.closed = true;
  }
}

class FakeProvider implements ModelProvider {
  readonly name: string;
  readonly queries: FakeQuery[] = [];
  private seq = 0;
  private readonly supportsCompact: boolean;

  constructor(name: string, supportsCompact = true) {
    this.name = name;
    this.supportsCompact = supportsCompact;
  }

  query(args: ProviderQueryArgs): ProviderQuery {
    const q = new FakeQuery(args, `${this.name}#${this.seq++}`, this.supportsCompact);
    this.queries.push(q);
    return q;
  }
}

// model → family: gpt* → openai-compatible, else anthropic-direct
function fakeFamily(model: string | undefined): string {
  return typeof model === 'string' && model.startsWith('gpt') ? 'openai-compatible' : 'anthropic-direct';
}

function makeRouter(
  config: Partial<AgentConfig>,
): {
  router: ProviderRouter;
  outer: QueryInputStream;
  anthropic: FakeProvider;
  openai: FakeProvider;
  resolveApiKeyCalls: Array<string | undefined>;
} {
  const anthropic = new FakeProvider('anthropic-direct');
  const openai = new FakeProvider('openai-compatible', /* supportsCompact */ false);
  const resolveApiKeyCalls: Array<string | undefined> = [];
  const deps: ProviderRouterDeps = {
    resolveProvider: (m) => (fakeFamily(m) === 'openai-compatible' ? openai : anthropic),
    providerNameForModel: (m) => fakeFamily(m),
    resolveApiKey: (m) => {
      resolveApiKeyCalls.push(m);
      return fakeFamily(m) === 'openai-compatible' ? 'key-openai' : 'key-anthropic-resolved';
    },
  };
  const outer = new QueryInputStream(() => 'sess');
  const fullConfig = { model: 'sonnet', ...config } as AgentConfig;
  const router = new ProviderRouter({ prompt: outer.createIterable(), config: fullConfig }, deps);
  return { router, outer, anthropic, openai, resolveApiKeyCalls };
}

/** Drive the router: pull session.init once, then one turn, collecting events. */
async function pullInit(iter: AsyncIterator<ProviderEvent>): Promise<ProviderEvent> {
  const r = await iter.next();
  if (r.done) throw new Error('router ended before init');
  return r.value;
}

async function driveTurn(
  iter: AsyncIterator<ProviderEvent>,
  outer: QueryInputStream,
  msg: string,
): Promise<ProviderEvent[]> {
  outer.pushUserMessage(msg);
  const events: ProviderEvent[] = [];
  while (true) {
    const r = await iter.next();
    if (r.done) break;
    events.push(r.value);
    if (r.value.type === 'turn.completed' || r.value.type === 'error') break;
  }
  return events;
}

/**
 * Slot-aware router for routing-SIGNATURE tests (same-family endpoint changes).
 * Family is decided by the BOUND id's prefix (resolveModelId → fakeFamily) so
 * slot aliases route correctly; per-slot `provider: 'openai'` makes the real
 * applySlotCredentials (called inside the router) set `openaiBaseUrl`
 * deterministically without reading env. Install bindings via setSlotBindings()
 * BEFORE constructing.
 */
function makeSlotRouter(model: string): {
  router: ProviderRouter;
  outer: QueryInputStream;
  openai: FakeProvider;
  anthropic: FakeProvider;
} {
  const anthropic = new FakeProvider('anthropic-direct');
  const openai = new FakeProvider('openai-compatible', /* supportsCompact */ false);
  const deps: ProviderRouterDeps = {
    resolveProvider: (m) =>
      fakeFamily(resolveModelId(m) ?? m) === 'openai-compatible' ? openai : anthropic,
    providerNameForModel: (m) => fakeFamily(resolveModelId(m) ?? m),
    resolveApiKey: () => undefined,
  };
  const outer = new QueryInputStream(() => 'sess');
  const router = new ProviderRouter(
    { prompt: outer.createIterable(), config: { model } as AgentConfig },
    deps,
  );
  return { router, outer, openai, anthropic };
}

describe('ProviderRouter', () => {
  beforeEach(() => resetSlotBindings());
  afterEach(() => resetSlotBindings());

  it('surfaces the first inner session.init and routes a turn to the startup family', async () => {
    const { router, outer, anthropic, openai } = makeRouter({ model: 'sonnet', apiKey: 'key-anthropic' });
    const iter = router[Symbol.asyncIterator]();

    const init = await pullInit(iter);
    expect(init.type).toBe('session.init');

    const events = await driveTurn(iter, outer, 'hello');
    expect(events.map((e) => e.type)).toEqual(['delta.text', 'assistant.message', 'turn.completed']);
    // Routed to the anthropic fake (startup family); openai never constructed.
    expect(anthropic.queries).toHaveLength(1);
    expect(openai.queries).toHaveLength(0);
    await router.close();
  });

  it('swaps providers at the turn boundary on a cross-family /model switch', async () => {
    const { router, outer, anthropic, openai } = makeRouter({ model: 'sonnet', apiKey: 'key-anthropic' });
    const iter = router[Symbol.asyncIterator]();
    await pullInit(iter);

    await driveTurn(iter, outer, 'first'); // anthropic
    await router.setModel('gpt-5.5'); // cross-family — recorded, swap deferred
    const events = await driveTurn(iter, outer, 'second'); // should swap to openai

    // The swapped inner's session.init is SWALLOWED — the session never sees a re-init.
    expect(events.map((e) => e.type)).toEqual(['delta.text', 'assistant.message', 'turn.completed']);
    expect(openai.queries).toHaveLength(1);
    // The openai turn was actually served by the openai fake.
    const asst = events.find((e) => e.type === 'assistant.message');
    expect(asst && asst.type === 'assistant.message' && asst.text).toContain('openai-compatible#0');
    // Old anthropic inner was torn down.
    expect(anthropic.queries[0]!.rec.closed).toBe(true);
    await router.close();
  });

  it('seeds the swapped inner with the text shadow history (cross-provider carry)', async () => {
    const { router, outer, openai } = makeRouter({ model: 'sonnet', apiKey: 'key-anthropic' });
    const iter = router[Symbol.asyncIterator]();
    await pullInit(iter);

    await driveTurn(iter, outer, 'remember this');
    await router.setModel('gpt-5.5');
    await driveTurn(iter, outer, 'and now switch');

    const seeded = openai.queries[0]!.rec.config.resumeHistory ?? [];
    // The pre-switch turn is carried as a text {user, assistant} pair.
    expect(seeded.length).toBeGreaterThanOrEqual(1);
    expect(seeded[0]!.user).toBe('remember this');
    expect(seeded[0]!.assistant).toContain('reply-from-anthropic-direct#0');
    await router.close();
  });

  it('injects a one-turn model-switch notice into the first turn a swapped inner serves', async () => {
    const { router, outer } = makeRouter({ model: 'sonnet', apiKey: 'key-anthropic' });
    const iter = router[Symbol.asyncIterator]();
    await pullInit(iter);

    await driveTurn(iter, outer, 'first'); // anthropic
    await router.setModel('gpt-5.5'); // cross-family
    const events = await driveTurn(iter, outer, 'second'); // swaps to openai

    // The FakeQuery echoes the pushed user content, so the notice + real text
    // both surface in the swapped inner's first-turn output.
    const delta = events.find((e) => e.type === 'delta.text');
    const text = delta && delta.type === 'delta.text' ? delta.text : '';
    expect(text).toContain('Your model was switched');
    expect(text).toContain('sonnet → gpt-5.5');
    expect(text).toContain('anthropic-direct → openai-compatible');
    // The user's real message still rides the same turn, after the notice.
    expect(text).toContain('second');
    await router.close();
  });

  it('does NOT inject a switch notice on a same-family forward (no rebuild)', async () => {
    const { router, outer } = makeRouter({ model: 'sonnet', apiKey: 'key-anthropic' });
    const iter = router[Symbol.asyncIterator]();
    await pullInit(iter);

    await driveTurn(iter, outer, 'first');
    await router.setModel('opus'); // same family (anthropic) → forwarded, not rebuilt
    const events = await driveTurn(iter, outer, 'second');

    const delta = events.find((e) => e.type === 'delta.text');
    const text = delta && delta.type === 'delta.text' ? delta.text : '';
    expect(text).not.toContain('Your model was switched');
    expect(text).toContain('second'); // plain user turn forwarded unchanged
    await router.close();
  });

  it('keeps the switch notice out of the carried shadow history (records user text only)', async () => {
    const { router, outer, anthropic } = makeRouter({ model: 'sonnet', apiKey: 'key-anthropic' });
    const iter = router[Symbol.asyncIterator]();
    await pullInit(iter);

    await driveTurn(iter, outer, 'alpha'); // anthropic#0
    await router.setModel('gpt-5.5');
    await driveTurn(iter, outer, 'beta'); // swap → openai#0 (notice injected on this turn)
    await router.setModel('sonnet');
    await driveTurn(iter, outer, 'gamma'); // swap → anthropic#1 (seeded from shadow history)

    // The rebuilt anthropic inner is seeded with prior turns as TEXT. The 'beta'
    // turn must be recorded as the user's real text, never the injected notice.
    const seeded = anthropic.queries[1]!.rec.config.resumeHistory ?? [];
    expect(seeded.find((t) => t.user === 'beta'), 'beta recorded as clean user text').toBeDefined();
    expect(seeded.some((t) => t.user.includes('Your model was switched'))).toBe(false);
    await router.close();
  });

  it('resolves credentials per-family on swap and never leaks the anthropic key to openai', async () => {
    const { router, outer, anthropic, openai } = makeRouter({ model: 'sonnet', apiKey: 'key-anthropic' });
    const iter = router[Symbol.asyncIterator]();
    await pullInit(iter);

    // Startup (anthropic) family keeps the explicit/startup-resolved key.
    expect(anthropic.queries[0]!.rec.config.apiKey).toBe('key-anthropic');

    await router.setModel('gpt-5.5');
    await driveTurn(iter, outer, 'go');
    // The openai inner gets the OPENAI key, not the anthropic one.
    expect(openai.queries[0]!.rec.config.apiKey).toBe('key-openai');
    expect(openai.queries[0]!.rec.config.apiKey).not.toBe('key-anthropic');
    await router.close();
  });

  it('forwards a same-family /model switch to the live inner without swapping', async () => {
    const { router, outer, anthropic } = makeRouter({ model: 'sonnet', apiKey: 'key-anthropic' });
    const iter = router[Symbol.asyncIterator]();
    await pullInit(iter);

    await router.setModel('opus'); // same family (anthropic)
    await driveTurn(iter, outer, 'hi');
    // No new inner constructed; the existing one received setModel('opus').
    expect(anthropic.queries).toHaveLength(1);
    expect(anthropic.queries[0]!.rec.setModelCalls).toContain('opus');
    await router.close();
  });

  it('delegates getContextUsage / accountInfo / supportedCommands to the active inner', async () => {
    const { router, outer } = makeRouter({ model: 'sonnet', apiKey: 'key-anthropic' });
    const iter = router[Symbol.asyncIterator]();
    await pullInit(iter);

    const usage = await router.getContextUsage();
    expect(usage['marker']).toBe('anthropic-direct#0');

    await router.setModel('gpt-5.5');
    await driveTurn(iter, outer, 'switch');
    const usage2 = await router.getContextUsage();
    expect(usage2['marker']).toBe('openai-compatible#0'); // now reflects the active (openai) inner
    const acct = await router.accountInfo();
    expect(acct.subscriptionType).toBe('openai-compatible#0');
    await router.close();
  });

  it('returns a not-supported compact result when the active inner lacks compaction', async () => {
    const { router, outer } = makeRouter({ model: 'sonnet', apiKey: 'key-anthropic' });
    const iter = router[Symbol.asyncIterator]();
    await pullInit(iter);
    await router.setModel('gpt-5.5');
    await driveTurn(iter, outer, 'switch'); // openai fake does not implement compact

    const result = await router.compact();
    expect(result.compacted).toBe(false);
    expect(result.reason).toMatch(/does not support/i);
    await router.close();
  });

  it('delegates listRewindTargets / rewindConversation to the active inner', async () => {
    const { router, outer } = makeRouter({ model: 'sonnet', apiKey: 'key-anthropic' });
    const iter = router[Symbol.asyncIterator]();
    await pullInit(iter);
    void outer;

    const targets = router.listRewindTargets();
    expect(targets).toHaveLength(1);
    expect(targets[0]!.preview).toContain('anthropic-direct#0');

    const result = await router.rewindConversation(2);
    expect(result.rewound).toBe(true);
    expect(result.reloadText).toBe('reload-2');
    expect(result.messagesAfter).toBe(2);
    await router.close();
  });

  it('returns empty targets / not-supported rewind before any provider is active', async () => {
    const { router } = makeRouter({ model: 'sonnet', apiKey: 'key-anthropic' });
    // No iteration yet → no active inner.
    expect(router.listRewindTargets()).toEqual([]);
    const result = await router.rewindConversation(0);
    expect(result.rewound).toBe(false);
    expect(result.reason).toBe('not-supported');
  });

  it('drops the credential entirely when the family has no resolvable key', async () => {
    const anthropic = new FakeProvider('anthropic-direct');
    const openai = new FakeProvider('openai-compatible', false);
    const deps: ProviderRouterDeps = {
      resolveProvider: (m) => (fakeFamily(m) === 'openai-compatible' ? openai : anthropic),
      providerNameForModel: (m) => fakeFamily(m),
      resolveApiKey: () => undefined, // no env key for the target family
    };
    const outer = new QueryInputStream(() => 'sess');
    const router = new ProviderRouter(
      { prompt: outer.createIterable(), config: { model: 'sonnet', apiKey: 'key-anthropic' } as AgentConfig },
      deps,
    );
    const iter = router[Symbol.asyncIterator]();
    await pullInit(iter);
    await router.setModel('gpt-5.5');
    await driveTurn(iter, outer, 'go');
    // apiKey must be absent (fall through to the provider's own env source), NOT the anthropic key.
    expect(openai.queries[0]!.rec.config.apiKey).toBeUndefined();
    await router.close();
  });

  it('closes the active inner on router close()', async () => {
    const { router, outer, anthropic } = makeRouter({ model: 'sonnet', apiKey: 'key-anthropic' });
    const iter = router[Symbol.asyncIterator]();
    await pullInit(iter);
    await driveTurn(iter, outer, 'hi');
    await router.close();
    expect(anthropic.queries[0]!.rec.closed).toBe(true);
  });

  it('rebuilds the inner on a same-family switch when the resolved endpoint differs', async () => {
    // Two OpenAI-family tiers on DIFFERENT endpoints: a cloud tier and a local
    // shim tier with its own baseUrl. Switching cloud → local must REBUILD the
    // inner so the new endpoint/credentials apply. The prior family-only check
    // reused the cloud inner and kept the request on the cloud backend (the
    // gpt-5.5 → local `/model` bug: ChatGPT/Codex 400 on the frozen backend).
    setSlotBindings({
      local: { id: '' },
      small: { id: 'gpt-cloud', provider: 'openai' },
      medium: { id: 'gpt-local', provider: 'openai', baseUrl: 'http://localhost:8081/v1' },
      large: { id: 'claude-opus-4-8' },
    });
    const { router, outer, openai } = makeSlotRouter('small');
    const iter = router[Symbol.asyncIterator]();
    await pullInit(iter);

    await driveTurn(iter, outer, 'on cloud');
    expect(openai.queries).toHaveLength(1);
    expect(openai.queries[0]!.rec.config.openaiBaseUrl).toBeUndefined();

    await router.setModel('medium'); // same family (openai), different endpoint
    const events = await driveTurn(iter, outer, 'on local');
    expect(events.map((e) => e.type)).toEqual(['delta.text', 'assistant.message', 'turn.completed']);

    // A SECOND inner was constructed, pointed at the local endpoint…
    expect(openai.queries).toHaveLength(2);
    expect(openai.queries[1]!.rec.config.openaiBaseUrl).toBe('http://localhost:8081/v1');
    // …and the old cloud inner was torn down.
    expect(openai.queries[0]!.rec.closed).toBe(true);
    await router.close();
  });

  it('does NOT rebuild a same-family switch when the endpoint is unchanged (forwards instead)', async () => {
    setSlotBindings({
      local: { id: '' },
      small: { id: 'gpt-4o-mini', provider: 'openai' },
      medium: { id: 'gpt-4o', provider: 'openai' },
      large: { id: 'claude-opus-4-8' },
    });
    const { router, outer, openai } = makeSlotRouter('small');
    const iter = router[Symbol.asyncIterator]();
    await pullInit(iter);

    await driveTurn(iter, outer, 'first');
    await router.setModel('medium'); // same family AND same (default) endpoint
    await driveTurn(iter, outer, 'second');

    // No rebuild: still ONE inner, and it received the forwarded switch.
    expect(openai.queries).toHaveLength(1);
    expect(openai.queries[0]!.rec.setModelCalls).toContain('medium');
    await router.close();
  });

  it('rebuilds a same-endpoint switch when a tier forces ChatGPT OAuth (signature folds it in)', async () => {
    // Two OpenAI-family tiers on the SAME default endpoint: a plain keyed tier
    // and a chatgpt-oauth tier. Without folding forceChatgptOAuth into the
    // routing signature these collide → the switch is forwarded onto the keyed
    // inner and the request hits the wrong (keyed vs subscription) backend.
    setSlotBindings({
      local: { id: '' },
      small: { id: 'gpt-4o', provider: 'openai' },
      medium: { id: 'gpt-5.6', provider: 'chatgpt-oauth' },
      large: { id: 'claude-opus-4-8' },
    });
    const { router, outer, openai } = makeSlotRouter('small');
    const iter = router[Symbol.asyncIterator]();
    await pullInit(iter);

    await driveTurn(iter, outer, 'keyed');
    expect(openai.queries).toHaveLength(1);
    expect(openai.queries[0]!.rec.config.forceChatgptOAuth).toBeFalsy();

    await router.setModel('medium'); // same family + endpoint, but chatgpt-oauth
    await driveTurn(iter, outer, 'subscription');

    // A SECOND inner was built (signature now includes the forced-OAuth intent)…
    expect(openai.queries).toHaveLength(2);
    expect(openai.queries[1]!.rec.config.forceChatgptOAuth).toBe(true);
    // …and the plain-keyed inner was torn down.
    expect(openai.queries[0]!.rec.closed).toBe(true);
    await router.close();
  });
});
