/**
 * Claude Haiku 5.5 (released 2026-10-07) onboarding contract, and the `haiku`
 * alias bump from claude-haiku-4-5-20251001.
 *
 * Every table in the harness is keyed by exact model id, and Haiku 5.5 changes
 * profile versus Haiku 4.5 (adaptive thinking on by default, sampling params
 * forbidden, two-tier pricing). These tests pin each entry so the alias bump
 * cannot silently degrade to the 200k / 64k fallbacks or the 4.5 thinking path.
 *
 * Sources (verified 2026-10-08):
 *  - https://platform.claude.com/docs/en/models/haiku-5-5/overview
 *    (1M context, 128K output, adaptive thinking, default effort medium,
 *    pricing split at 100k-token prompts)
 *  - https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide
 *    (wire id `claude-haiku-5-5`; budget_tokens → 400; sampling params → 400)
 *  - https://platform.claude.com/docs/en/build-with-claude/thinking
 *    (`disabled` accepted at high effort or below, 400 at xhigh/max)
 */

import { describe, it, expect, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import {
  isNonDefaultSamplingForbiddenModel,
  resolveAnthropicTemperature,
  resolveEffort,
  resolveThinkingParam,
} from './resolve-params.js';
import { deriveCallCostUsd } from './pricing.js';
import { starterModels } from './query-options.js';
import { oneShotCompletion } from './oneshot.js';
import { autoCompactLimitFor, contextLimitFor, maxOutputTokensFor } from '../../model-limits.js';
import { CLAUDE_HAIKU_ID, DEFAULT_SLOT_BINDINGS, DIRECT_MODEL_ALIASES } from '../../session/model-slots.js';

const ID = 'claude-haiku-5-5';
const HAIKU_45 = 'claude-haiku-4-5-20251001';
const M = 1_000_000;

describe('haiku alias → Claude Haiku 5.5', () => {
  it('points the haiku alias and the small tier default at claude-haiku-5-5', () => {
    expect(CLAUDE_HAIKU_ID).toBe(ID);
    expect(DIRECT_MODEL_ALIASES['haiku']).toBe(ID);
    expect(DEFAULT_SLOT_BINDINGS.small.id).toBe(ID);
  });
});

describe('Claude Haiku 5.5 limits', () => {
  it('reports the native 1M window and 128K output (not the 200k / 64k fallbacks)', () => {
    expect(contextLimitFor(ID)).toBe(1_000_000);
    expect(maxOutputTokensFor(ID)).toBe(128_000);
    expect(contextLimitFor('haiku')).toBe(1_000_000);
    expect(maxOutputTokensFor('haiku')).toBe(128_000);
  });

  it('keeps a 200k auto-compact working budget on the 1M window', () => {
    expect(autoCompactLimitFor(ID)).toBe(200_000);
    expect(autoCompactLimitFor('haiku')).toBe(200_000);
  });

  it('leaves Haiku 4.5 on its own 200k / 64k limits', () => {
    expect(contextLimitFor(HAIKU_45)).toBe(200_000);
    expect(maxOutputTokensFor(HAIKU_45)).toBe(64_000);
  });
});

describe('Claude Haiku 5.5 pricing (two tiers, split at 100k prompt tokens)', () => {
  it('prices prompts up to 100k at $0.10 in / $0.50 out / $0.01 read / $0.125 5m / $0.20 1h', () => {
    expect(deriveCallCostUsd(ID, 100_000, 0, 0, 0)).toBeCloseTo(0.01, 10);
    expect(deriveCallCostUsd(ID, 1_000, M, 0, 0)).toBeCloseTo(0.0001 + 0.5, 10);
    expect(deriveCallCostUsd(ID, 0, 0, 100_000, 0)).toBeCloseTo(0.001, 10);
    expect(deriveCallCostUsd(ID, 0, 0, 0, 100_000)).toBeCloseTo(0.0125, 10);
    expect(
      deriveCallCostUsd(ID, 0, 0, 0, 100_000, { ephemeral5m: 0, ephemeral1h: 100_000 }),
    ).toBeCloseTo(0.02, 10);
  });

  it('prices every component at 5x once the total prompt exceeds 100k', () => {
    expect(deriveCallCostUsd(ID, M, 0, 0, 0)).toBeCloseTo(0.5, 10);
    // 1k plain input + 150k cache read = 151k prompt → long-prompt tier for
    // input, output, and reads alike.
    expect(deriveCallCostUsd(ID, 1_000, M, 150_000, 0)).toBeCloseTo(
      (1_000 / M) * 0.5 + 2.5 + (150_000 / M) * 0.05,
      10,
    );
    expect(deriveCallCostUsd(ID, 0, 0, 0, M)).toBeCloseTo(0.625, 10);
  });

  it('selects the tier on the total prompt, cache reads and writes included', () => {
    // 60k plain + 50k cache read = 110k prompt: the long tier, even though no
    // single component crosses 100k.
    expect(deriveCallCostUsd(ID, 60_000, 0, 50_000, 0)).toBeCloseTo(
      (60_000 / M) * 0.5 + (50_000 / M) * 0.05,
      10,
    );
  });

  it('leaves Haiku 4.5 pricing flat at $1 / $5', () => {
    expect(deriveCallCostUsd(HAIKU_45, M, 0, 0, 0)).toBeCloseTo(1.0, 8);
    expect(deriveCallCostUsd(HAIKU_45, 0, M, 0, 0)).toBeCloseTo(5.0, 8);
  });
});

describe('Claude Haiku 5.5 effort default', () => {
  it('sends no effort by default (server default `medium`)', () => {
    expect(resolveEffort(undefined, ID)).toBeUndefined();
  });

  it('passes explicit effort through unchanged', () => {
    expect(resolveEffort('high', ID)).toBe('high');
    expect(resolveEffort('low', ID)).toBe('low');
  });
});

describe('Claude Haiku 5.5 thinking', () => {
  it('promotes enabled to adaptive (enabled + budget_tokens is a 400)', () => {
    const p = resolveThinkingParam({ type: 'enabled' }, 64_000, ID) as {
      type: string;
      budget_tokens?: number;
    };
    expect(p.type).toBe('adaptive');
    expect(p.budget_tokens).toBeUndefined();
  });

  it.each(['low', 'medium', 'high', undefined])('passes disabled through at effort %s', (effort) => {
    expect(resolveThinkingParam({ type: 'disabled' }, 64_000, ID, effort)).toEqual({
      type: 'disabled',
    });
  });

  it.each(['xhigh', 'max'])('throws a legible error for disabled at effort %s', (effort) => {
    expect(() => resolveThinkingParam({ type: 'disabled' }, 64_000, ID, effort)).toThrow(
      /claude-haiku-5-5 rejects thinking.*disabled/,
    );
  });

  it('keeps Haiku 4.5 on the extended-thinking budget path', () => {
    const p = resolveThinkingParam({ type: 'enabled' }, 64_000, HAIKU_45) as { type: string };
    expect(p.type).toBe('enabled');
    expect(resolveThinkingParam({ type: 'disabled' }, 64_000, HAIKU_45, 'max')).toEqual({
      type: 'disabled',
    });
  });
});

describe('Claude Haiku 5.5 sampling', () => {
  it('drops a configured temperature (non-default sampling is a 400)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(isNonDefaultSamplingForbiddenModel(ID)).toBe(true);
    expect(resolveAnthropicTemperature(0.2, ID)).toBeUndefined();
    warn.mockRestore();
  });

  it('still forwards temperature to Haiku 4.5', () => {
    expect(isNonDefaultSamplingForbiddenModel(HAIKU_45)).toBe(false);
    expect(resolveAnthropicTemperature(0.2, HAIKU_45)).toBe(0.2);
  });
});

describe('Claude Haiku 5.5 one-shot completions', () => {
  type Params = { model: string; thinking?: unknown };
  const capture = async (model: string): Promise<Params> => {
    let captured: Params | undefined;
    await oneShotCompletion({
      token: 'sk-ant-api03-test',
      model,
      system: 'sys',
      user: 'msg',
      clientFactory: () =>
        ({
          messages: {
            create: async (params: Params) => {
              captured = params;
              return { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' };
            },
          },
        }) as unknown as Anthropic,
    });
    if (captured === undefined) throw new Error('create was not called');
    return captured;
  };

  it('turns thinking off so slug-sized budgets are not spent on a thinking block', async () => {
    const viaAlias = await capture('haiku');
    expect(viaAlias.model).toBe(ID);
    expect(viaAlias.thinking).toEqual({ type: 'disabled' });
    expect((await capture(ID)).thinking).toEqual({ type: 'disabled' });
  });

  it('sends no thinking field for other models', async () => {
    expect((await capture(HAIKU_45)).thinking).toBeUndefined();
    expect((await capture('sonnet')).thinking).toBeUndefined();
  });
});

describe('Claude Haiku 5.5 model picker', () => {
  it('is listed in the starter models', () => {
    expect(starterModels().map((m) => m.value)).toContain(ID);
  });
});
