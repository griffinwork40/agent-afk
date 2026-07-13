/**
 * Model-family based provider routing.
 *
 * These tests pin down the mapping that `AgentSession` uses when the caller
 * doesn't supply a custom `provider` — specifically:
 *   - Claude short aliases + `claude-*` ids route to `anthropic-direct`.
 *   - `gpt-*`, `o1*`, `o3*`, `o4*`, `codex-*` ids route to `openai-compatible`.
 *   - HF-style `org/model` ids (containing `/`) route to `openai-compatible` —
 *     they're served by local OpenAI-shim runners (MLX, llama.cpp, vLLM,
 *     ollama-openai) and Anthropic ids never contain `/`.
 *   - Unknown bare strings fall back to Anthropic (legacy default).
 *
 * Routing is case-insensitive and strips surrounding whitespace so config
 * files / env overrides can be forgiving.
 *
 * Backward compat: the legacy `'openai-codex'` provider name (which used
 * to wrap `@openai/codex-sdk` before the sibling-provider refactor) is
 * preserved as a deprecated alias in `BundledProviderName`, but
 * `providerForModel` returns the new `'openai-compatible'` name. Callers
 * that still pass `'openai-codex'` explicitly via `--provider` continue
 * to work (parseProvider handles it).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { providerForModel, resolveProvider } from './index.js';
import {
  createChildProviderFactory,
  createChildSkillExecutorFactory,
  type ChildProviderFactoryArgs,
} from '../tools/nesting.js';
import { AnthropicDirectProvider } from './anthropic-direct/index.js';
import { OpenAICompatibleProvider } from './openai-compatible/index.js';
import { getDefaultSubagentModel } from '../../cli/shared-helpers.js';
import type { SubagentExecutor } from '../tools/subagent-executor.js';
import type { SkillExecutor } from '../tools/skill-executor.js';
import type { ModelProvider } from '../provider.js';

describe('providerForModel', () => {
  // Scrub env vars that `providerForModel` now consults internally.
  // Without this, ambient `AFK_OPENAI_BASE_URL` or `AFK_PROVIDER` (set by
  // the operator's shell, a sibling test, or CI) would re-route the
  // "unknown raw strings fall back to anthropic" cases and break the
  // backward-compat invariants. New env-aware tests below set the vars
  // explicitly and rely on this baseline to roll them back.
  const ENV_KEYS_TO_SCRUB = ['AFK_PROVIDER', 'AFK_OPENAI_BASE_URL'] as const;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS_TO_SCRUB) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const key of ENV_KEYS_TO_SCRUB) {
      const saved = savedEnv[key];
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
  });

  describe('Claude routing', () => {
    it.each([
      'opus',
      'opus_1m',
      'sonnet',
      'sonnet_1m',
      'haiku',
      'fable',
      'auto',
    ])('routes short alias %s to anthropic', (alias) => {
      expect(providerForModel(alias)).toBe('anthropic-direct');
    });

    it.each([
      'claude-opus-4-8',
      'claude-sonnet-5',
      'claude-haiku-4-5-20251001',
      'claude-sonnet-4',
      'claude-fable-5',
    ])('routes full Claude id %s to anthropic', (id) => {
      expect(providerForModel(id)).toBe('anthropic-direct');
    });

    it('is case-insensitive for short aliases', () => {
      expect(providerForModel('SONNET')).toBe('anthropic-direct');
      expect(providerForModel('Opus_1m')).toBe('anthropic-direct');
    });

    it('tolerates surrounding whitespace', () => {
      expect(providerForModel('  sonnet  ')).toBe('anthropic-direct');
    });
  });

  describe('OpenAI routing', () => {
    it.each([
      'gpt-5.6',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-4o',
      'gpt-4o-mini',
      'o1-preview',
      'o1-mini',
      'o3',
      'o3-mini',
      'o4',
      'codex-1',
      'codex-fast-1',
      'codex',
    ])('routes %s to openai-compatible', (id) => {
      expect(providerForModel(id)).toBe('openai-compatible');
    });

    it('matches regardless of case', () => {
      expect(providerForModel('GPT-5.4')).toBe('openai-compatible');
      expect(providerForModel('O3')).toBe('openai-compatible');
    });
  });

  describe('local OpenAI-shim routing (HF-style org/model ids)', () => {
    it.each([
      'mlx-community/gemma-4-e4b-it-8bit',
      'mlx-community/Qwen3.5-35B-A3B-4bit',
      'mlx-community/gemma-4-31b-it-4bit',
      'TheBloke/Llama-2-7B-GGUF',
      'Qwen/Qwen2.5-Coder-32B-Instruct',
      'meta-llama/Llama-3.1-8B-Instruct',
    ])('routes HF-style id %s to openai-compatible', (id) => {
      expect(providerForModel(id)).toBe('openai-compatible');
    });

    it('preserves case-insensitivity for HF ids', () => {
      expect(providerForModel('MLX-Community/Gemma-4-31B-IT-4bit')).toBe('openai-compatible');
    });

    it('still routes claude-prefixed ids to anthropic even with a slash later (defensive)', () => {
      // claude- prefix check runs before slash check, so a hypothetical
      // proxy id like `claude-sonnet-4/custom` still goes to anthropic.
      expect(providerForModel('claude-sonnet-4/custom')).toBe('anthropic-direct');
    });

    it('does not collide with PR #239 local-* ids (AFK_LOCAL_BASE_URL path)', () => {
      // PR #239 added local-* prefix routing via AFK_LOCAL_BASE_URL: the
      // anthropic-direct provider's baseURL is overridden to point at a
      // local Anthropic-Messages-compatible shim. Those ids never contain
      // `/`, so the slash heuristic must NOT route them to openai-compatible
      // — keep them on anthropic-direct so the SDK's overridden baseURL
      // is the active endpoint.
      expect(providerForModel('local-qwen3')).toBe('anthropic-direct');
      expect(providerForModel('local-deepseek-r1')).toBe('anthropic-direct');
    });
  });

  describe('fallback behaviour', () => {
    it('falls back to anthropic for undefined / empty model', () => {
      expect(providerForModel(undefined)).toBe('anthropic-direct');
      expect(providerForModel('')).toBe('anthropic-direct');
      expect(providerForModel('   ')).toBe('anthropic-direct');
    });

    it('falls back to anthropic for unknown raw strings (backward compat)', () => {
      expect(providerForModel('mystery-model')).toBe('anthropic-direct');
      expect(providerForModel('some-proxy-alias')).toBe('anthropic-direct');
    });
  });

  // `local-*` model names are handled by the anthropic-direct provider in
  // combination with `AFK_LOCAL_BASE_URL` config — the routing layer itself
  // just falls through to the default. These tests pin that behavior so the
  // local-server feature keeps working if the routing table is reshuffled.
  describe('Local model fallback', () => {
    it.each([
      'local-qwen-3-6',
      'local-glm-4-7-flash',
      'local-llama-70b',
      'LOCAL-FOO',
    ])('routes %s to anthropic-direct', (id) => {
      expect(providerForModel(id)).toBe('anthropic-direct');
    });

    it('routes local-* to anthropic-direct even when AFK_OPENAI_BASE_URL is set (defensive)', () => {
      // Operators running both an Anthropic shim (AFK_LOCAL_BASE_URL) and an
      // OpenAI shim (AFK_OPENAI_BASE_URL) simultaneously must still see
      // `local-*` ids route to anthropic-direct. Without the explicit
      // `local-*` arm, Tier 4's env-hint would re-route them to
      // openai-compatible — defeating PR #239's local-server feature.
      process.env['AFK_OPENAI_BASE_URL'] = 'http://localhost:8000/v1';
      expect(providerForModel('local-qwen3')).toBe('anthropic-direct');
      expect(providerForModel('local-deepseek-r1')).toBe('anthropic-direct');
    });
  });

  // Tier 3 extension: common third-party OpenAI-shim model families (DeepSeek,
  // Mistral, Meta Llama, Qwen). Before this, `AFK_MODEL=deepseek-v4-pro afk`
  // without `AFK_OPENAI_BASE_URL` set silently 404'd against api.anthropic.com
  // because no rule matched.
  describe('third-party OpenAI-shim prefix routing', () => {
    it.each([
      'deepseek-v4-pro',
      'deepseek-r2',
      'deepseek-coder-v3',
      'mistral-large-2',
      'mistral-medium',
      'mixtral-8x22b',
      'llama-3.3-70b-instruct',
      'llama-4-405b',
      'qwen-2.5-coder-32b',
      'qwen-3-72b',
    ])('routes %s to openai-compatible', (id) => {
      expect(providerForModel(id)).toBe('openai-compatible');
    });

    it('matches regardless of case + underscore separator', () => {
      expect(providerForModel('DEEPSEEK-V4')).toBe('openai-compatible');
      expect(providerForModel('Mistral_Large')).toBe('openai-compatible');
      expect(providerForModel('LLAMA_4')).toBe('openai-compatible');
    });
  });

  // Tier 1: explicit AFK_PROVIDER env var or hints.explicit. Always wins.
  describe('explicit provider override (AFK_PROVIDER / hints.explicit)', () => {
    it('AFK_PROVIDER=openai-compatible re-routes Claude models', () => {
      // Last-resort escape hatch: operator wants every model name routed to
      // openai-compatible regardless of prefix. Pinning this so the Claude
      // lock at Tier 2 doesn't shadow the explicit override.
      process.env['AFK_PROVIDER'] = 'openai-compatible';
      expect(providerForModel('sonnet')).toBe('openai-compatible');
      expect(providerForModel('claude-opus-4-8')).toBe('openai-compatible');
    });

    it('AFK_PROVIDER=anthropic re-routes OpenAI-pattern models', () => {
      process.env['AFK_PROVIDER'] = 'anthropic';
      expect(providerForModel('gpt-4o')).toBe('anthropic-direct');
      expect(providerForModel('o3-mini')).toBe('anthropic-direct');
    });

    it('accepts the deprecated openai-codex alias', () => {
      process.env['AFK_PROVIDER'] = 'openai-codex';
      expect(providerForModel('sonnet')).toBe('openai-compatible');
    });

    it('is case-insensitive and tolerates whitespace', () => {
      process.env['AFK_PROVIDER'] = '  OPENAI  ';
      expect(providerForModel('sonnet')).toBe('openai-compatible');
    });

    it('ignores unrecognized values and falls through to model-pattern routing', () => {
      // Permissive: don't throw on bad env values — keep the env hint
      // best-effort. The CLI flag's parseProvider DOES throw, but that's a
      // surface contract, not an env contract.
      process.env['AFK_PROVIDER'] = 'not-a-real-provider';
      expect(providerForModel('sonnet')).toBe('anthropic-direct');
      expect(providerForModel('gpt-4o')).toBe('openai-compatible');
    });

    it('empty / whitespace AFK_PROVIDER is treated as unset', () => {
      process.env['AFK_PROVIDER'] = '';
      expect(providerForModel('sonnet')).toBe('anthropic-direct');
      process.env['AFK_PROVIDER'] = '   ';
      expect(providerForModel('sonnet')).toBe('anthropic-direct');
    });

    it('hints.explicit overrides env (CLI flag wins over env var)', () => {
      // Mirrors the CLI surface: --provider beats AFK_PROVIDER. The bootstrap
      // wires --provider into hints.explicit when calling providerForModel.
      process.env['AFK_PROVIDER'] = 'anthropic';
      expect(providerForModel('sonnet', { explicit: 'openai-compatible' })).toBe(
        'openai-compatible',
      );
    });

    it('hints.explicit overrides model prefix (Claude lock yields to explicit)', () => {
      expect(providerForModel('claude-sonnet-4', { explicit: 'openai-compatible' })).toBe(
        'openai-compatible',
      );
    });
  });

  // Tier 4: env-hint fallback. `AFK_OPENAI_BASE_URL` set + unknown name
  // → openai-compatible. Fixes the deepseek-v4-pro 404 footgun.
  describe('AFK_OPENAI_BASE_URL env-hint routing', () => {
    it('routes unknown model names to openai-compatible when AFK_OPENAI_BASE_URL is set', () => {
      // The original bug: `AFK_OPENAI_BASE_URL=… AFK_MODEL=mystery-model afk`
      // used to go to api.anthropic.com despite the env var. Pins the fix.
      process.env['AFK_OPENAI_BASE_URL'] = 'https://opencode.ai/zen/go/v1';
      expect(providerForModel('mystery-model')).toBe('openai-compatible');
      expect(providerForModel('some-proxy-alias')).toBe('openai-compatible');
      expect(providerForModel('vendor-x-flagship')).toBe('openai-compatible');
    });

    it('does NOT hijack Claude models when AFK_OPENAI_BASE_URL is set', () => {
      // Critical invariant: the Claude lock at Tier 2 must beat Tier 4. An
      // operator running an OpenAI shim AND `afk -m sonnet` simultaneously
      // should still hit Anthropic — the env var alone is not consent to
      // re-route Claude traffic.
      process.env['AFK_OPENAI_BASE_URL'] = 'http://localhost:8000/v1';
      expect(providerForModel('sonnet')).toBe('anthropic-direct');
      expect(providerForModel('opus_1m')).toBe('anthropic-direct');
      expect(providerForModel('claude-opus-4-8')).toBe('anthropic-direct');
    });

    it('uses hints.openaiBaseUrl over env (CLI config wins)', () => {
      // Bootstrap threads cliConfig.openaiBaseUrl into hints; explicit hint
      // beats raw env so config-layer precedence (env < json < flag) is
      // preserved through the routing layer.
      expect(
        providerForModel('mystery-model', { openaiBaseUrl: 'http://localhost:8000/v1' }),
      ).toBe('openai-compatible');
    });

    it('empty / whitespace AFK_OPENAI_BASE_URL is treated as unset', () => {
      process.env['AFK_OPENAI_BASE_URL'] = '';
      expect(providerForModel('mystery-model')).toBe('anthropic-direct');
      process.env['AFK_OPENAI_BASE_URL'] = '   ';
      expect(providerForModel('mystery-model')).toBe('anthropic-direct');
    });

    it('does not interfere with known OpenAI patterns (Tier 3 still wins)', () => {
      process.env['AFK_OPENAI_BASE_URL'] = 'http://localhost:8000/v1';
      expect(providerForModel('gpt-4o')).toBe('openai-compatible');
      expect(providerForModel('deepseek-v4-pro')).toBe('openai-compatible');
      expect(providerForModel('mlx-community/gemma-4-31b')).toBe('openai-compatible');
    });

    it('routes undefined / empty model to openai-compatible when base URL is set', () => {
      // No model + base URL set: this is the "afk daemon with env preset"
      // case. Routing to openai-compatible here matches the operator's
      // intent — they set the URL precisely to target that endpoint. The
      // legacy fallback to anthropic-direct only fires when neither the
      // model nor the URL gives us a signal.
      process.env['AFK_OPENAI_BASE_URL'] = 'http://localhost:8000/v1';
      expect(providerForModel(undefined)).toBe('openai-compatible');
      expect(providerForModel('')).toBe('openai-compatible');
    });
  });
});

describe('resolveProvider', () => {
  it('returns the openai-compatible adapter for OpenAI-routed models', () => {
    expect(resolveProvider('gpt-5.4').name).toBe('openai-compatible');
    expect(resolveProvider('codex-1').name).toBe('openai-compatible');
    expect(resolveProvider('o3-mini').name).toBe('openai-compatible');
  });

  it('returns the openai-compatible adapter for HF-style local model ids', () => {
    expect(resolveProvider('mlx-community/Qwen3.5-35B-A3B-4bit').name).toBe('openai-compatible');
    expect(resolveProvider('TheBloke/Llama-2-7B-GGUF').name).toBe('openai-compatible');
  });

  it('returns the anthropic adapter for Claude-routed models', () => {
    expect(resolveProvider('sonnet').name).toBe('anthropic-direct');
    expect(resolveProvider('claude-opus-4-8').name).toBe('anthropic-direct');
  });

  it('returns the anthropic adapter when model is undefined', () => {
    expect(resolveProvider(undefined).name).toBe('anthropic-direct');
  });

  it('returns a fresh per-call instance for both providers (no shared mutable state)', () => {
    const a = resolveProvider('sonnet');
    const b = resolveProvider('sonnet');
    expect(a).not.toBe(b);

    const c = resolveProvider('gpt-4o');
    const d = resolveProvider('gpt-4o');
    expect(c).not.toBe(d);
  });
});

/**
 * Child-provider factory routing — closes the loop reported as "local
 * models (openai) dispatching anthropic-direct subagents".
 *
 * The factory built by `createChildProviderFactory` is what the
 * SubagentExecutor and SkillExecutor inject as `childConfig.provider`
 * when forking a child. Before the routing fix it always returned an
 * `AnthropicDirectProvider`, so a gpt-4o parent silently dispatched every
 * `agent`/`skill` subagent to api.anthropic.com. The factory now branches
 * on `providerForModel(model)` per-call so OpenAI-routed children land on
 * `OpenAICompatibleProvider`.
 */
describe('createChildProviderFactory — child provider routing', () => {
  // Minimal stubs — the factory only consults the `model` arg; the
  // executor objects are forwarded as-is and never accessed in the
  // factory body.
  const childExecutor = {} as SubagentExecutor;
  const childSkillExecutor = {} as SkillExecutor;

  it('routes an OpenAI-routed child model to OpenAICompatibleProvider', () => {
    const factory = createChildProviderFactory();
    const provider = factory({ childExecutor, childSkillExecutor, model: 'gpt-4o' });
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
  });

  it.each([
    'gpt-5.4',
    'gpt-4o-mini',
    'o1-preview',
    'o3-mini',
    'codex-1',
    'mlx-community/Qwen3.5-35B-A3B-4bit',
    'TheBloke/Llama-2-7B-GGUF',
  ])('routes %s child model to OpenAICompatibleProvider', (model) => {
    const factory = createChildProviderFactory();
    const provider = factory({ childExecutor, childSkillExecutor, model });
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
  });

  it('routes a Claude child model to AnthropicDirectProvider', () => {
    const factory = createChildProviderFactory();
    const provider = factory({ childExecutor, childSkillExecutor, model: 'sonnet' });
    expect(provider).toBeInstanceOf(AnthropicDirectProvider);
  });

  it.each([
    'opus',
    'opus_1m',
    'haiku',
    'fable',
    'claude-opus-4-8',
    'claude-sonnet-5',
    'claude-fable-5',
  ])('routes Claude id %s to AnthropicDirectProvider', (model) => {
    const factory = createChildProviderFactory();
    const provider = factory({ childExecutor, childSkillExecutor, model });
    expect(provider).toBeInstanceOf(AnthropicDirectProvider);
  });

  it('falls back to AnthropicDirectProvider when model is undefined (legacy default)', () => {
    // This is the "no model arg supplied" case the LLM hits most often
    // when running locally — previously this fell to a hardcoded
    // AnthropicDirectProvider and caused the bug. Behavior preserved
    // intentionally (legacy default, matches providerForModel(undefined)).
    const factory = createChildProviderFactory();
    const provider = factory({ childExecutor, childSkillExecutor });
    expect(provider).toBeInstanceOf(AnthropicDirectProvider);
  });

  it('forwards openaiBaseUrl into the OpenAICompatibleProvider when configured', () => {
    // Spies on the constructor to inspect what `baseURL` got passed.
    // Without this plumbing, OpenAI-routed children would hit the
    // default api.openai.com URL even when the user set
    // AFK_OPENAI_BASE_URL — defeating the local-shim configuration.
    const ctorSpy = vi.spyOn(
      OpenAICompatibleProvider.prototype as unknown as { constructor: unknown },
      'constructor' as unknown as never,
    );
    try {
      const factory = createChildProviderFactory({
        openaiBaseUrl: 'http://localhost:8080/v1',
      });
      const provider = factory({ childExecutor, childSkillExecutor, model: 'gpt-4o' });
      expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
      // The provider stores baseURL on `providerOpts` (see
      // openai-compatible/index.ts:76, 89-99). We can't introspect a
      // private field cleanly, so reach through the unknown cast.
      const baked = (provider as unknown as {
        providerOpts: { baseURL?: string };
      }).providerOpts.baseURL;
      expect(baked).toBe('http://localhost:8080/v1');
    } finally {
      ctorSpy.mockRestore();
    }
  });

  it('does not pass openaiBaseUrl when constructed without one', () => {
    // The opposite control: a factory built without openaiBaseUrl must
    // leave the provider's baseURL unset so the OpenAI SDK's default
    // (https://api.openai.com/v1) applies. Confirms we're not leaking a
    // stale value across constructions.
    const factory = createChildProviderFactory();
    const provider = factory({ childExecutor, childSkillExecutor, model: 'gpt-4o' });
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    const baked = (provider as unknown as {
      providerOpts: { baseURL?: string };
    }).providerOpts.baseURL;
    expect(baked).toBeUndefined();
  });

  it('does not forward openaiBaseUrl to Claude children (would be a config error)', () => {
    // openaiBaseUrl is captured at factory construction so a single
    // factory can serve mixed sibling dispatches (gpt-4o + sonnet). For
    // the Claude branch the OpenAI URL must be ignored — Anthropic uses
    // its own baseUrl field on AgentConfig and reading the OpenAI one
    // would silently misroute. This pins that ignore.
    const factory = createChildProviderFactory({
      openaiBaseUrl: 'http://localhost:8080/v1',
    });
    const provider = factory({ childExecutor, childSkillExecutor, model: 'sonnet' });
    expect(provider).toBeInstanceOf(AnthropicDirectProvider);
  });

  it('end-to-end footgun guard: gpt-4o parent → no-model-arg child still routes Anthropic (caller must supply child model)', () => {
    // This pins the failure mode that bug Fix A alone does NOT cover.
    // If the executor's `defaultSubagentModel` is unset and the LLM
    // omits `model`, the resolved child model is `'sonnet'` and the
    // factory correctly returns AnthropicDirectProvider for it. The
    // openai-parent → openai-child path requires Fix B (parent-aware
    // `getDefaultSubagentModel`) to be wired at the bootstrap site.
    // Test is here as documentation that Fix A's behavior is correct
    // and the openai-parent footgun is closed by Fix B, not by the
    // factory.
    const factory = createChildProviderFactory();
    expect(
      factory({ childExecutor, childSkillExecutor, model: 'sonnet' }),
    ).toBeInstanceOf(AnthropicDirectProvider);
    expect(
      factory({ childExecutor, childSkillExecutor, model: 'gpt-4o' }),
    ).toBeInstanceOf(OpenAICompatibleProvider);
  });
});

/**
 * createChildSkillExecutorFactory's trailing `openaiBaseUrl` positional arg
 * (nesting.ts) must be threaded onto every nested SkillExecutor's ctx —
 * `ctx.openaiBaseUrl` is what `buildForkedChildConfig` later forwards into
 * `buildReadOnlyReconProvider` / `buildSkillRestrictedProvider` (depth-cap
 * fallback, see nesting.test.ts) and into the grandchild SubagentExecutor's
 * `defaultConfig` (see skill-executor.test.ts's openaiBaseUrl propagation
 * test). This closes the gap at the factory→ctx handoff itself, mirroring
 * nesting.model-fallback.test.ts's coverage of the sibling
 * `defaultSubagentModel` parameter on the same factory.
 */
describe('createChildSkillExecutorFactory — openaiBaseUrl threading', () => {
  const stubProviderFactory = (_args: ChildProviderFactoryArgs): ModelProvider =>
    ({}) as ModelProvider;

  it('threads openaiBaseUrl into the constructed SkillExecutor ctx', () => {
    const factory = createChildSkillExecutorFactory(
      'gpt-4o', // 1 defaultModel
      undefined, // 2 apiKey
      stubProviderFactory, // 3 childProviderFactory
      undefined, // 4 baseUrl
      undefined, // 5 traceWriter
      undefined, // 6 backgroundRegistry
      undefined, // 7 cwd
      undefined, // 8 resolveApiKeyForModel
      'cli', // 9 surface
      undefined, // 10 defaultSubagentModel
      undefined, // 11 agentRegistry
      'http://localhost:8080/v1', // 12 openaiBaseUrl
    );
    const skillExecutor = factory(1, 3, new AbortController().signal);
    expect(
      (skillExecutor as unknown as { ctx: { openaiBaseUrl?: string } }).ctx.openaiBaseUrl,
    ).toBe('http://localhost:8080/v1');
  });

  it('recursively propagates openaiBaseUrl to grandchild SkillExecutors (skill→skill→skill)', () => {
    const factory = createChildSkillExecutorFactory(
      'gpt-4o',
      undefined,
      stubProviderFactory,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'cli',
      undefined,
      undefined,
      'http://localhost:8080/v1',
    );
    const child = factory(1, 3, new AbortController().signal);
    const recursiveFactory = (
      child as unknown as {
        ctx: {
          childSkillExecutorFactory: (
            depth: number,
            maxDepth: number,
            signal: AbortSignal,
          ) => SkillExecutor;
        };
      }
    ).ctx.childSkillExecutorFactory;
    const grandchild = recursiveFactory(2, 3, new AbortController().signal);
    expect(
      (grandchild as unknown as { ctx: { openaiBaseUrl?: string } }).ctx.openaiBaseUrl,
    ).toBe('http://localhost:8080/v1');
  });

  it('omits openaiBaseUrl when the caller does not supply it (back-compat)', () => {
    const factory = createChildSkillExecutorFactory('sonnet', undefined, stubProviderFactory);
    const skillExecutor = factory(1, 3, new AbortController().signal);
    expect(
      (skillExecutor as unknown as { ctx: { openaiBaseUrl?: string } }).ctx.openaiBaseUrl,
    ).toBeUndefined();
  });
});

/**
 * Parent-aware subagent default — closes the second half of the bug.
 *
 * Without this, even after Fix A (the factory routing above) a local-only
 * OpenAI parent silently dispatches to api.anthropic.com because the LLM
 * usually omits `model` and the executor falls through to the legacy
 * `'sonnet'` literal — which `providerForModel` then routes back to
 * AnthropicDirect.
 *
 * `getDefaultSubagentModel(parentModel)` reads the parent model and inherits
 * it when (a) `AFK_DEFAULT_SUBAGENT_MODEL` is unset and (b) the parent
 * routes to openai-compatible. Claude parents still default to `'sonnet'`
 * to preserve the historical cost-management intent ("high-tier parent
 * shouldn't auto-spawn high-tier children").
 */
describe('getDefaultSubagentModel — parent-aware fallback', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env['AFK_DEFAULT_SUBAGENT_MODEL'];
    delete process.env['AFK_DEFAULT_SUBAGENT_MODEL'];
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env['AFK_DEFAULT_SUBAGENT_MODEL'];
    } else {
      process.env['AFK_DEFAULT_SUBAGENT_MODEL'] = originalEnv;
    }
  });

  it.each([
    'gpt-4o',
    'gpt-5.4',
    'o1-preview',
    'o3-mini',
    'codex-1',
    'mlx-community/Qwen3.5-35B-A3B-4bit',
    'TheBloke/Llama-2-7B-GGUF',
  ])('inherits OpenAI-routed parent model %s as the subagent default', (parent) => {
    expect(getDefaultSubagentModel(parent)).toBe(parent);
  });

  it.each([
    'sonnet',
    'opus',
    'opus_1m',
    'haiku',
    'fable',
    'claude-opus-4-8',
    'claude-sonnet-5',
    'claude-fable-5',
  ])('defaults to the "medium" tier for Claude parent %s (preserves cost-mgmt intent)', (parent) => {
    // Post-#548: the default is the rebindable `medium` TIER (resolves to Claude
    // Sonnet by default), not the fixed `'sonnet'` identity alias — so a user who
    // rebinds `medium` redirects default subagents with it.
    expect(getDefaultSubagentModel(parent)).toBe('medium');
  });

  it('defaults to the "medium" tier when no parent model is supplied (legacy callers)', () => {
    expect(getDefaultSubagentModel()).toBe('medium');
    expect(getDefaultSubagentModel(undefined)).toBe('medium');
  });

  it('honors AFK_DEFAULT_SUBAGENT_MODEL even when parent is OpenAI-routed (env wins)', () => {
    process.env['AFK_DEFAULT_SUBAGENT_MODEL'] = 'haiku';
    expect(getDefaultSubagentModel('gpt-4o')).toBe('haiku');
  });

  it('honors AFK_DEFAULT_SUBAGENT_MODEL even when no parent model is supplied', () => {
    process.env['AFK_DEFAULT_SUBAGENT_MODEL'] = 'opus';
    expect(getDefaultSubagentModel()).toBe('opus');
  });

  it('treats empty AFK_DEFAULT_SUBAGENT_MODEL as unset (falls through to parent-aware logic)', () => {
    process.env['AFK_DEFAULT_SUBAGENT_MODEL'] = '';
    expect(getDefaultSubagentModel('gpt-4o')).toBe('gpt-4o');
    expect(getDefaultSubagentModel('sonnet')).toBe('medium');
  });
});
