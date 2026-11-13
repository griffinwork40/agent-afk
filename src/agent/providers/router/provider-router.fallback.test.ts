/**
 * Tests for the main-session fallback model in ProviderRouter
 * (provider-router.fallback.ts): arming, consume, swap, replay, notice,
 * start failure, interrupt and `/model` during the swap.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ProviderRouter, type ProviderRouterDeps } from './provider-router.js';
import { fallbackNoticeText, stripFailedUserTurn } from './provider-router.fallback.js';
import { QueryInputStream } from '../../session/input-iterable.js';
import { resetSlotBindings } from '../../session/model-slots.js';
import { resolveModelId } from '../../session/model-resolution.js';
import { isModelFallbackArmed } from '../shared/model-fallback-armed.js';
import { UsageLimitError } from '../../../utils/errors.js';
import type { AgentConfig, ResumeHistoryTurn } from '../../types/config-types.js';
import type { JournalMessage } from '../../journal/index.js';
import type {
  ModelProvider,
  ProviderQuery,
  ProviderEvent,
  ProviderQueryArgs,
  ProviderUserTurn,
} from '../../provider.js';

const PRIMARY_ERR = new Error('primary is out');

interface ProviderOpts {
  /** Emit a fallback request (when armed) on this (queryIndex, turnIndex). */
  requestOn?: (q: number, t: number) => boolean;
  /** Emit the request even when not armed (stale-inner race). */
  forceRequest?: boolean;
  snapshot?: (q: number) => JournalMessage[] | undefined;
  initError?: boolean;
  throwOnQuery?: boolean;
  /** Awaited inside close() so a test can act mid-swap. */
  closeGate?: () => Promise<void>;
}

class FakeQuery {
  readonly turns: Array<ProviderUserTurn['content']> = [];
  readonly interrupts: string[] = [];
  closed = false;
  readonly promptIter: AsyncIterator<ProviderUserTurn>;
  constructor(
    readonly config: AgentConfig,
    prompt: AsyncIterable<ProviderUserTurn>,
    readonly id: string,
    readonly index: number,
    readonly opts: ProviderOpts,
  ) {
    this.promptIter = prompt[Symbol.asyncIterator]();
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<ProviderEvent, void, unknown> {
    if (this.opts.initError) {
      yield { type: 'error', error: new Error(`${this.id} init failed`) };
      return;
    }
    yield { type: 'session.init', info: { sessionId: this.id, model: String(this.config.model) } };
    for (let t = 0; ; t++) {
      const r = await this.promptIter.next();
      if (r.done) return;
      this.turns.push(r.value.content);
      if (this.opts.requestOn?.(this.index, t)) {
        if (this.opts.forceRequest || isModelFallbackArmed(this.config)) {
          yield { type: 'model.fallback_request', reason: 'usage-limit', error: PRIMARY_ERR };
        } else {
          yield { type: 'error', error: PRIMARY_ERR };
        }
        continue;
      }
      const text = typeof r.value.content === 'string' ? r.value.content : '[blocks]';
      yield { type: 'assistant.message', text: `reply-${this.id}:${text}` };
      yield { type: 'turn.completed', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    }
  }
  journalSnapshot(): JournalMessage[] | undefined {
    return this.opts.snapshot?.(this.index);
  }
  async interrupt(reason?: string): Promise<void> {
    this.interrupts.push(reason ?? 'interrupted');
  }
  setModelCalls: string[] = [];
  async setModel(m?: string): Promise<void> {
    if (m) this.setModelCalls.push(m);
  }
  async close(): Promise<void> {
    await this.opts.closeGate?.();
    this.closed = true;
  }
}

class FakeProvider implements ModelProvider {
  readonly queries: FakeQuery[] = [];
  constructor(readonly name: string, public opts: ProviderOpts = {}) {}
  query(args: ProviderQueryArgs): ProviderQuery {
    if (this.opts.throwOnQuery) throw new Error(`${this.name} cannot start`);
    const q = new FakeQuery(args.config, args.prompt, `${this.name}#${this.queries.length}`, this.queries.length, this.opts);
    this.queries.push(q);
    return q as unknown as ProviderQuery;
  }
}

const family = (m: string | undefined): string =>
  (resolveModelId(m) ?? m ?? '').startsWith('gpt') ? 'openai-compatible' : 'anthropic-direct';

function makeRouter(o: {
  model?: string;
  fallback?: string | undefined;
  noFallbackDep?: boolean;
  config?: Partial<AgentConfig>;
  primary?: ProviderOpts;
  secondary?: ProviderOpts;
}) {
  const anthropic = new FakeProvider('anthropic', o.primary);
  const openai = new FakeProvider('openai', o.secondary);
  const fb = { value: o.fallback };
  const deps: ProviderRouterDeps = {
    resolveProvider: (m) => (family(m) === 'openai-compatible' ? openai : anthropic),
    providerNameForModel: family,
    resolveApiKey: () => undefined,
    ...(o.noFallbackDep ? {} : { getFallbackModel: () => fb.value }),
  };
  const outer = new QueryInputStream(() => 'sess');
  const config = { model: o.model ?? 'opus', ...o.config } as AgentConfig;
  const router = new ProviderRouter({ prompt: outer.createIterable(), config }, deps);
  const iter = router[Symbol.asyncIterator]();
  return { router, outer, iter, anthropic, openai, fb };
}

async function pullInit(iter: AsyncIterator<ProviderEvent>): Promise<void> {
  const r = await iter.next();
  expect(r.done ? undefined : r.value.type).toBe('session.init');
}

async function driveTurn(iter: AsyncIterator<ProviderEvent>, outer: QueryInputStream, msg: string): Promise<ProviderEvent[]> {
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

const shadow = (r: ProviderRouter): ResumeHistoryTurn[] => (r as unknown as { shadowHistory: ResumeHistoryTurn[] }).shadowHistory;
const armedOf = (q: FakeQuery): boolean => isModelFallbackArmed(q.config);
const firstTurnFails = { requestOn: (q: number, t: number) => q === 0 && t === 0 };
const SNAP: JournalMessage[] = [
  { role: 'user', content: [{ type: 'text', text: 'earlier' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'earlier reply' }] },
  { role: 'user', content: [{ type: 'text', text: 'hello' }] },
];

beforeEach(() => resetSlotBindings());

describe('ProviderRouter fallback: swap and replay', () => {
  it('never yields the request; notice exactly once before the fallback output; replays the turn once', async () => {
    const { router, outer, iter, openai } = makeRouter({ fallback: 'gpt-5.5', primary: { ...firstTurnFails, snapshot: () => SNAP } });
    await pullInit(iter);
    const ev = await driveTurn(iter, outer, 'hello');
    expect(ev.some((e) => e.type === 'model.fallback_request')).toBe(false);
    const notices = ev.filter((e) => e.type === 'notice');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ kind: 'model-fallback', fallback: { from: 'opus', to: 'gpt-5.5', reason: 'usage-limit' } });
    const iNotice = ev.findIndex((e) => e.type === 'notice');
    const iReply = ev.findIndex((e) => e.type === 'assistant.message');
    expect(iNotice).toBeLessThan(iReply);
    expect(ev.at(-1)?.type).toBe('turn.completed');
    const fq = openai.queries[0]!;
    expect(fq.turns).toHaveLength(1);
    expect(String(fq.turns[0])).toMatch(/opus → gpt-5\.5[\s\S]*\n\nhello$/);
    // Seeded without the failed user message; earlier context kept.
    expect(fq.config.resumeMessages).toEqual(SNAP.slice(0, 2));
    await router.close();
  });

  it('shadow history holds only the successful attempt with the real text; next turn stays on the fallback', async () => {
    const { router, outer, iter, anthropic, openai } = makeRouter({ fallback: 'gpt-5.5', primary: firstTurnFails });
    await pullInit(iter);
    await driveTurn(iter, outer, 'hello');
    const ev2 = await driveTurn(iter, outer, 'next');
    // The terminal's shadow commit runs when the lane resumes, so read it after the next turn.
    expect(shadow(router)).toEqual([{ user: 'hello', assistant: 'reply-openai#0:' + String(openai.queries[0]!.turns[0]) }]);
    expect(ev2.some((e) => e.type === 'notice')).toBe(false);
    expect(openai.queries).toHaveLength(1);
    expect(openai.queries[0]!.turns.at(-1)).toBe('next');
    expect(anthropic.queries).toHaveLength(1);
    expect(anthropic.queries[0]!.closed).toBe(true);
    await router.close();
  });

  it('no journal: replays once and seeds the prose shadow of prior turns only', async () => {
    const { router, outer, iter, openai } = makeRouter({ fallback: 'gpt-5.5', primary: { requestOn: (q, t) => q === 0 && t === 1 } });
    await pullInit(iter);
    await driveTurn(iter, outer, 'first');
    await driveTurn(iter, outer, 'second');
    const fq = openai.queries[0]!;
    expect(fq.turns).toHaveLength(1);
    expect(fq.config.resumeMessages).toBeUndefined();
    expect(fq.config.resumeHistory).toEqual([{ user: 'first', assistant: 'reply-anthropic#0:first' }]);
    await driveTurn(iter, outer, 'third');
    expect(shadow(router).map((t) => t.user)).toEqual(['first', 'second']);
    await router.close();
  });

  it('a second failure after the fallback is in use behaves as today (predicate false, plain error)', async () => {
    const { router, outer, iter, openai } = makeRouter({ fallback: 'gpt-5.5', primary: firstTurnFails, secondary: { requestOn: (_q, t) => t === 1 } });
    await pullInit(iter);
    await driveTurn(iter, outer, 'hello');
    expect(armedOf(openai.queries[0]!)).toBe(false);
    const ev = await driveTurn(iter, outer, 'again');
    expect(ev).toEqual([{ type: 'error', error: PRIMARY_ERR }]);
    await router.close();
  });
});

describe('ProviderRouter fallback: arming predicate', () => {
  it('is false when no fallback is configured, and absent when the dep is not wired', async () => {
    const a = makeRouter({ fallback: undefined });
    await pullInit(a.iter);
    expect(armedOf(a.anthropic.queries[0]!)).toBe(false);
    const b = makeRouter({ noFallbackDep: true });
    await pullInit(b.iter);
    expect(b.anthropic.queries[0]!.config.modelFallbackArmed).toBeUndefined();
    await a.router.close();
    await b.router.close();
  });

  it('is true when eligible and false once used', async () => {
    const { router, outer, iter, anthropic, openai } = makeRouter({ fallback: 'gpt-5.5', primary: firstTurnFails });
    await pullInit(iter);
    expect(armedOf(anthropic.queries[0]!)).toBe(true);
    await driveTurn(iter, outer, 'hello');
    expect(armedOf(anthropic.queries[0]!)).toBe(false);
    expect(armedOf(openai.queries[0]!)).toBe(false);
    await router.close();
  });

  it('is false when the fallback resolves to the current model (alias vs concrete id)', async () => {
    const id = resolveModelId('sonnet')!;
    expect(id).not.toBe('sonnet');
    const { router, iter, anthropic } = makeRouter({ model: 'sonnet', fallback: id });
    await pullInit(iter);
    expect(armedOf(anthropic.queries[0]!)).toBe(false);
    await router.close();
  });

  it('is false for a subagent fork', async () => {
    const { router, iter, anthropic } = makeRouter({ fallback: 'gpt-5.5', config: { isSubagentFork: true } });
    await pullInit(iter);
    expect(armedOf(anthropic.queries[0]!)).toBe(false);
    await router.close();
  });

  it('is live: /model onto the fallback forwarded into the same inner reads false', async () => {
    const { router, iter, anthropic } = makeRouter({ model: 'opus', fallback: 'sonnet' });
    await pullInit(iter);
    const q = anthropic.queries[0]!;
    expect(armedOf(q)).toBe(true);
    await router.setModel('sonnet');
    expect(q.setModelCalls).toEqual(['sonnet']);
    expect(armedOf(q)).toBe(false);
    await router.close();
  });
});

describe('ProviderRouter fallback: failure paths', () => {
  it('a request arriving when not eligible yields the original error', async () => {
    const { router, outer, iter, openai } = makeRouter({ fallback: undefined, primary: { ...firstTurnFails, forceRequest: true } });
    await pullInit(iter);
    const ev = await driveTurn(iter, outer, 'hello');
    expect(ev).toEqual([{ type: 'error', error: PRIMARY_ERR }]);
    expect(openai.queries).toHaveLength(0);
    expect((await driveTurn(iter, outer, 'next')).at(-1)?.type).toBe('turn.completed');
    await router.close();
  });

  for (const mode of ['throw', 'init'] as const) {
    it(`fallback failing at ${mode}: original error, primary restored with the unstripped snapshot, lane alive`, async () => {
      const secondary: ProviderOpts = mode === 'throw' ? { throwOnQuery: true } : { initError: true };
      const { router, outer, iter, anthropic } = makeRouter({ fallback: 'gpt-5.5', primary: { ...firstTurnFails, snapshot: () => SNAP }, secondary });
      await pullInit(iter);
      const ev = await driveTurn(iter, outer, 'hello');
      expect(ev.filter((e) => e.type === 'notice')).toHaveLength(0);
      expect(ev.at(-1)).toEqual({ type: 'error', error: PRIMARY_ERR });
      const restored = anthropic.queries[1]!;
      expect(restored.config.model).toBe('opus');
      expect(restored.config.resumeMessages).toEqual(SNAP);
      expect(armedOf(restored)).toBe(false);
      const ev2 = await driveTurn(iter, outer, 'next');
      expect(ev2.at(-1)?.type).toBe('turn.completed');
      expect(restored.turns).toEqual(['next']);
      await router.close();
    });
  }

  it('an ordinary error with no fallback configured behaves as before', async () => {
    const { router, outer, iter, anthropic } = makeRouter({ noFallbackDep: true, primary: firstTurnFails });
    await pullInit(iter);
    expect(await driveTurn(iter, outer, 'hello')).toEqual([{ type: 'error', error: PRIMARY_ERR }]);
    expect((await driveTurn(iter, outer, 'next')).at(-1)?.type).toBe('turn.completed');
    expect(shadow(router)).toEqual([{ user: 'hello', assistant: '' }]);
    expect(anthropic.queries).toHaveLength(1);
    await router.close();
  });
});

describe('ProviderRouter fallback: concurrency during the swap', () => {
  function gated() {
    let release!: () => void;
    let entered!: () => void;
    const enteredP = new Promise<void>((r) => (entered = r));
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    const closeGate = async () => {
      if (!first) return;
      first = false;
      entered();
      await gate;
    };
    return { closeGate, enteredP, release };
  }

  it('an interrupt during the swap: no replay, exactly one interrupted terminal', async () => {
    const g = gated();
    const { router, outer, iter, anthropic, openai } = makeRouter({ fallback: 'gpt-5.5', primary: { ...firstTurnFails, closeGate: g.closeGate } });
    await pullInit(iter);
    outer.pushUserMessage('hello');
    const pending = iter.next();
    await g.enteredP;
    await router.interrupt();
    g.release();
    const r = await pending;
    expect(r.done ? undefined : r.value).toMatchObject({ type: 'turn.completed', usage: { stopReason: 'interrupted' } });
    expect(openai.queries).toHaveLength(0);
    expect(anthropic.queries.every((q) => q.interrupts.length === 0)).toBe(true);
    // The next turn runs on the restored primary, and the router still serves.
    const ev = await driveTurn(iter, outer, 'next');
    expect(ev.filter((e) => e.type === 'turn.completed')).toHaveLength(1);
    expect(anthropic.queries[1]!.turns).toEqual(['next']);
    await router.close();
  });

  it('setModel during the swap is applied afterwards, not lost', async () => {
    const g = gated();
    const { router, outer, iter, anthropic, openai } = makeRouter({ fallback: 'gpt-5.5', primary: { ...firstTurnFails, closeGate: g.closeGate } });
    await pullInit(iter);
    outer.pushUserMessage('hello');
    const collected: ProviderEvent[] = [];
    const drain = (async () => {
      while (true) {
        const r = await iter.next();
        if (r.done) return;
        collected.push(r.value);
        if (r.value.type === 'turn.completed' || r.value.type === 'error') return;
      }
    })();
    await g.enteredP;
    await router.setModel('haiku');
    g.release();
    await drain;
    expect(collected.some((e) => e.type === 'notice')).toBe(true);
    expect(openai.queries[0]!.turns).toHaveLength(1);
    // The deferred /model takes effect at the next turn boundary.
    await driveTurn(iter, outer, 'next');
    const last = anthropic.queries.at(-1)!;
    expect(last.config.model).toBe('haiku');
    expect(last.turns.at(-1)).toMatch(/next$/);
    await router.close();
  });
});

describe('fallback helpers', () => {
  it('strips exactly one trailing user entry and keeps an earlier errored one', () => {
    const u = (t: string): JournalMessage => ({ role: 'user', content: [{ type: 'text', text: t }] });
    expect(stripFailedUserTurn([u('a'), u('b')])).toEqual([u('a')]);
    expect(stripFailedUserTurn([u('a'), { role: 'assistant', content: [] }])).toHaveLength(2);
    expect(stripFailedUserTurn(undefined)).toBeUndefined();
  });

  it('notice text per reason', () => {
    const resetsAt = new Date(2026, 10, 13, 18, 0);
    const err = new UsageLimitError('x', { provider: 'anthropic', kind: 'subscription', resetsAt } as never);
    const time = resetsAt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
    expect(fallbackNoticeText('opus', 'sonnet', 'usage-limit', err)).toBe(`opus hit its usage limit (resets ${time}). Continuing on sonnet. Run /model opus to switch back.`);
    expect(fallbackNoticeText('opus', 'sonnet', 'usage-limit', new Error('x'))).toBe('opus hit its usage limit. Continuing on sonnet. Run /model opus to switch back.');
    expect(fallbackNoticeText('opus', 'sonnet', 'credit-exhausted', new Error('x'))).toBe('opus is out of credit. Continuing on sonnet. Run /model opus to switch back.');
    expect(fallbackNoticeText('opus', 'sonnet', 'model-rejected', new Error('x'))).toBe('opus is not available. Continuing on sonnet. Run /model opus to switch back.');
  });
});
