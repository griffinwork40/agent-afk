/**
 * Tests for prompt-experiment helpers.
 * @module agent/prompt-experiment.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { isPromptExperimentActive, getPromptVariant } from './prompt-experiment.js';

// vi.stubEnv restores automatically after each test when used with vi.restoreAllMocks,
// but we call vi.unstubAllEnvs() explicitly so each test is fully isolated.
afterEach(() => {
  vi.unstubAllEnvs();
});

const EXPERIMENT = 'explore-rewrite';

// ── isPromptExperimentActive ─────────────────────────────────────────────────

describe('isPromptExperimentActive', () => {
  it('returns true when env matches name exactly', () => {
    vi.stubEnv('AFK_PROMPT_EXPERIMENT', EXPERIMENT);
    expect(isPromptExperimentActive(EXPERIMENT)).toBe(true);
  });

  it('returns false when AFK_PROMPT_EXPERIMENT is unset', () => {
    vi.stubEnv('AFK_PROMPT_EXPERIMENT', undefined);
    expect(isPromptExperimentActive(EXPERIMENT)).toBe(false);
  });

  it('returns false when env names a different experiment', () => {
    vi.stubEnv('AFK_PROMPT_EXPERIMENT', 'other-experiment');
    expect(isPromptExperimentActive(EXPERIMENT)).toBe(false);
  });

  it('trims whitespace from the env value', () => {
    vi.stubEnv('AFK_PROMPT_EXPERIMENT', `  ${EXPERIMENT}  `);
    expect(isPromptExperimentActive(EXPERIMENT)).toBe(true);
  });

  it('trims whitespace from the name param', () => {
    vi.stubEnv('AFK_PROMPT_EXPERIMENT', EXPERIMENT);
    expect(isPromptExperimentActive(`  ${EXPERIMENT}  `)).toBe(true);
  });

  it('trims both env value and name param', () => {
    vi.stubEnv('AFK_PROMPT_EXPERIMENT', `  ${EXPERIMENT}  `);
    expect(isPromptExperimentActive(`  ${EXPERIMENT}  `)).toBe(true);
  });

  it('returns false for empty name param (empty-name guard)', () => {
    vi.stubEnv('AFK_PROMPT_EXPERIMENT', EXPERIMENT);
    expect(isPromptExperimentActive('')).toBe(false);
  });

  it('returns false for whitespace-only name param', () => {
    vi.stubEnv('AFK_PROMPT_EXPERIMENT', EXPERIMENT);
    expect(isPromptExperimentActive('   ')).toBe(false);
  });

  it('returns false when env is empty string', () => {
    vi.stubEnv('AFK_PROMPT_EXPERIMENT', '');
    expect(isPromptExperimentActive(EXPERIMENT)).toBe(false);
  });

  it('is case-sensitive — mismatched case returns false', () => {
    vi.stubEnv('AFK_PROMPT_EXPERIMENT', 'Explore-Rewrite');
    expect(isPromptExperimentActive(EXPERIMENT)).toBe(false);
  });

  it('is case-sensitive — uppercase env does not match lowercase name', () => {
    vi.stubEnv('AFK_PROMPT_EXPERIMENT', 'EXPLORE-REWRITE');
    expect(isPromptExperimentActive(EXPERIMENT)).toBe(false);
  });
});

// ── getPromptVariant ──────────────────────────────────────────────────────────

describe('getPromptVariant', () => {
  it('returns "control" when experiment is not active', () => {
    vi.stubEnv('AFK_PROMPT_EXPERIMENT', undefined);
    expect(getPromptVariant(EXPERIMENT)).toBe('control');
  });

  it('returns "control" when arm is unset', () => {
    vi.stubEnv('AFK_PROMPT_EXPERIMENT', EXPERIMENT);
    vi.stubEnv('AFK_PROMPT_EXPERIMENT_ARM', undefined);
    expect(getPromptVariant(EXPERIMENT)).toBe('control');
  });

  it('returns "control" when arm is empty string', () => {
    vi.stubEnv('AFK_PROMPT_EXPERIMENT', EXPERIMENT);
    vi.stubEnv('AFK_PROMPT_EXPERIMENT_ARM', '');
    expect(getPromptVariant(EXPERIMENT)).toBe('control');
  });

  it('returns "control" when arm is "control"', () => {
    vi.stubEnv('AFK_PROMPT_EXPERIMENT', EXPERIMENT);
    vi.stubEnv('AFK_PROMPT_EXPERIMENT_ARM', 'control');
    expect(getPromptVariant(EXPERIMENT)).toBe('control');
  });

  it('returns "treatment" when arm is "treatment"', () => {
    vi.stubEnv('AFK_PROMPT_EXPERIMENT', EXPERIMENT);
    vi.stubEnv('AFK_PROMPT_EXPERIMENT_ARM', 'treatment');
    expect(getPromptVariant(EXPERIMENT)).toBe('treatment');
  });

  it('normalises arm case — "Treatment" -> treatment', () => {
    vi.stubEnv('AFK_PROMPT_EXPERIMENT', EXPERIMENT);
    vi.stubEnv('AFK_PROMPT_EXPERIMENT_ARM', 'Treatment');
    expect(getPromptVariant(EXPERIMENT)).toBe('treatment');
  });

  it('normalises arm case — "TREATMENT" -> treatment', () => {
    vi.stubEnv('AFK_PROMPT_EXPERIMENT', EXPERIMENT);
    vi.stubEnv('AFK_PROMPT_EXPERIMENT_ARM', 'TREATMENT');
    expect(getPromptVariant(EXPERIMENT)).toBe('treatment');
  });

  it('trims arm whitespace before comparison', () => {
    vi.stubEnv('AFK_PROMPT_EXPERIMENT', EXPERIMENT);
    vi.stubEnv('AFK_PROMPT_EXPERIMENT_ARM', '  treatment  ');
    expect(getPromptVariant(EXPERIMENT)).toBe('treatment');
  });

  it('trims and lowercases arm — "  TREATMENT  " -> treatment', () => {
    vi.stubEnv('AFK_PROMPT_EXPERIMENT', EXPERIMENT);
    vi.stubEnv('AFK_PROMPT_EXPERIMENT_ARM', '  TREATMENT  ');
    expect(getPromptVariant(EXPERIMENT)).toBe('treatment');
  });

  it('returns "control" for an unrecognised arm value', () => {
    vi.stubEnv('AFK_PROMPT_EXPERIMENT', EXPERIMENT);
    vi.stubEnv('AFK_PROMPT_EXPERIMENT_ARM', 'experimental');
    expect(getPromptVariant(EXPERIMENT)).toBe('control');
  });

  it('returns "control" when name is empty (guard via isPromptExperimentActive)', () => {
    vi.stubEnv('AFK_PROMPT_EXPERIMENT', EXPERIMENT);
    vi.stubEnv('AFK_PROMPT_EXPERIMENT_ARM', 'treatment');
    expect(getPromptVariant('')).toBe('control');
  });
});

// ── PROTECTED_ENV_KEYS (settable-keys) ────────────────────────────────────────

import { classifyEnvKey } from '../config/settable-keys.js';

describe('PROTECTED_ENV_KEYS contains experiment vars', () => {
  it('classifies AFK_PROMPT_EXPERIMENT as protected', () => {
    expect(classifyEnvKey('AFK_PROMPT_EXPERIMENT')).toBe('protected');
  });

  it('classifies AFK_PROMPT_EXPERIMENT_ARM as protected', () => {
    expect(classifyEnvKey('AFK_PROMPT_EXPERIMENT_ARM')).toBe('protected');
  });
});
