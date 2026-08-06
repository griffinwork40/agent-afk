import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { coerceCrossProviderChildModel } from './child-model-fallback.js';
import {
  CLAUDE_SONNET_ID,
  DEFAULT_SLOT_BINDINGS,
  resetSlotBindings,
  setSlotBindings,
} from '../session/model-slots.js';

/**
 * `coerceCrossProviderChildModel` reads `AFK_PROVIDER` (and `AFK_OPENAI_BASE_URL`)
 * transitively via `providerForModel`, so scrub them to a known baseline and set
 * them explicitly per-case — mirroring providers/routing.test.ts.
 */
describe('coerceCrossProviderChildModel (#652)', () => {
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

  describe('no global force (normal Anthropic routing)', () => {
    it('leaves a Claude-family child untouched — it routes to anthropic-direct', () => {
      expect(coerceCrossProviderChildModel('sonnet', 'gpt-5.5')).toEqual({ model: 'sonnet' });
      expect(coerceCrossProviderChildModel('claude-sonnet-5', 'gpt-5.5')).toEqual({
        model: 'claude-sonnet-5',
      });
    });

    it('leaves a local-* Anthropic-shim child untouched (Tier-2 → anthropic-direct)', () => {
      // The local-shim protection case: local-* routes to anthropic-direct
      // without a force, so it must never be coerced onto the parent's model.
      expect(coerceCrossProviderChildModel('local-qwen-3-6', 'gpt-5.5')).toEqual({
        model: 'local-qwen-3-6',
      });
    });
  });

  describe('AFK_PROVIDER=openai-compatible force (the #652 trigger)', () => {
    beforeEach(() => {
      process.env['AFK_PROVIDER'] = 'openai-compatible';
    });

    it('coerces a defaulted sonnet child onto the parent gpt model', () => {
      expect(coerceCrossProviderChildModel('sonnet', 'gpt-5.5')).toEqual({
        model: 'gpt-5.5',
        coercedFrom: 'sonnet',
      });
    });

    it.each(['opus', 'haiku', 'claude-sonnet-5', 'local-qwen-3-6'])(
      'coerces Claude-family / shim pin %s (all rejected by the ChatGPT backend under force)',
      (child) => {
        expect(coerceCrossProviderChildModel(child, 'gpt-5.5')).toEqual({
          model: 'gpt-5.5',
          coercedFrom: child,
        });
      },
    );

    it('leaves a gpt child untouched (not Claude-family)', () => {
      expect(coerceCrossProviderChildModel('gpt-5.5', 'gpt-5.5')).toEqual({ model: 'gpt-5.5' });
    });

    it('does NOT coerce when the parent is not a usable substitute (undefined)', () => {
      expect(coerceCrossProviderChildModel('sonnet', undefined)).toEqual({ model: 'sonnet' });
    });

    it('does NOT coerce when the parent is itself Claude-family (misconfigured parent)', () => {
      // A claude parent under force is broken on its own; let the provider's
      // actionable error fire rather than substituting one broken model for another.
      expect(coerceCrossProviderChildModel('sonnet', 'opus')).toEqual({ model: 'sonnet' });
    });
  });

  it('passes an undefined child through unchanged', () => {
    expect(coerceCrossProviderChildModel(undefined, 'gpt-5.5')).toEqual({ model: undefined });
  });

  /**
   * #869: a bare capability-tier pin (`small`/`medium`/`large`/`local`, or a
   * custom tier name — e.g. an agent definition's `model: medium`) must be
   * resolved to its bound concrete id before the Claude-family check, not
   * checked as a literal string. `resetSlotBindings()` in `afterEach` prevents
   * the explicit `setSlotBindings` calls below from leaking into other tests.
   */
  describe('bare tier-name pins (#869)', () => {
    afterEach(() => {
      resetSlotBindings();
    });

    describe('no global force (normal Anthropic routing)', () => {
      it.each(['small', 'medium', 'large'])(
        'leaves tier %s untouched — its default binding routes anthropic-direct',
        (tier) => {
          expect(coerceCrossProviderChildModel(tier, 'gpt-5.5')).toEqual({ model: tier });
        },
      );
    });

    describe('AFK_PROVIDER=openai-compatible force', () => {
      beforeEach(() => {
        process.env['AFK_PROVIDER'] = 'openai-compatible';
      });

      it.each(['small', 'medium', 'large'])(
        'coerces bare tier %s — default-bound to a Claude id, so it would otherwise hard-error',
        (tier) => {
          expect(coerceCrossProviderChildModel(tier, 'gpt-5.5')).toEqual({
            model: 'gpt-5.5',
            coercedFrom: tier,
          });
        },
      );

      it('does NOT coerce the bare "local" tier when unconfigured (empty id — nothing to protect)', () => {
        expect(coerceCrossProviderChildModel('local', 'gpt-5.5')).toEqual({ model: 'local' });
      });

      it('does NOT coerce a tier explicitly rebound to a non-Claude id', () => {
        setSlotBindings({ ...DEFAULT_SLOT_BINDINGS, small: { id: 'gpt-4o-mini' } });
        expect(coerceCrossProviderChildModel('small', 'gpt-5.5')).toEqual({ model: 'small' });
      });

      it('coerces a custom tier NAME that resolves onto a Claude-bound slot', () => {
        setSlotBindings({
          ...DEFAULT_SLOT_BINDINGS,
          medium: { id: CLAUDE_SONNET_ID, name: 'general' },
        });
        expect(coerceCrossProviderChildModel('general', 'gpt-5.5')).toEqual({
          model: 'gpt-5.5',
          coercedFrom: 'general',
        });
      });
    });
  });
});
