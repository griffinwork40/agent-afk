import { describe, it, expect, afterEach } from 'vitest';
import { env, ENV_REGISTRY, getEnvVarMeta, getMissingRequiredEnvVars } from './env.js';

describe('env / ENV_REGISTRY consistency', () => {
  it('every own property in env has a matching ENV_REGISTRY entry', () => {
    // getOwnPropertyNames — not Object.keys — because secret getters are
    // intentionally non-enumerable (see applySecretHardening in env.ts).
    const envKeys = Object.getOwnPropertyNames(env);
    const registryNames = new Set(ENV_REGISTRY.map((e) => e.name));
    const missing = envKeys.filter((k) => !registryNames.has(k));
    expect(missing).toEqual([]);
  });

  it('every ENV_REGISTRY entry has a matching getter in env', () => {
    const envKeys = new Set(Object.getOwnPropertyNames(env));
    const orphaned = ENV_REGISTRY.filter((e) => !envKeys.has(e.name));
    expect(orphaned.map((e) => e.name)).toEqual([]);
  });

  it('ENV_REGISTRY has no duplicate names', () => {
    const names = ENV_REGISTRY.map((e) => e.name);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    expect(dupes).toEqual([]);
  });

  it('every ENV_REGISTRY entry has a non-empty description', () => {
    const blank = ENV_REGISTRY.filter((e) => !e.description || e.description.trim() === '');
    expect(blank.map((e) => e.name)).toEqual([]);
  });

  it('registers the terminal-title (OSC 2) and completion-notify (OSC 9) vars', () => {
    for (const name of ['AFK_TERM_TITLE', 'AFK_NOTIFY']) {
      const meta = getEnvVarMeta(name);
      expect(meta, `${name} must be in ENV_REGISTRY`).toBeDefined();
      expect(meta?.type).toBe('boolean');
      expect(meta?.required).toBe(false);
      // Both have a matching lazy getter (bidirectional parity also checks
      // this, but assert here so a missing getter fails with a clear name).
      expect(Object.getOwnPropertyNames(env)).toContain(name);
    }
  });
});

describe('env lazy getters', () => {
  const original: Record<string, string | undefined> = {};

  afterEach(() => {
    // Restore mutated keys
    for (const [k, v] of Object.entries(original)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const k of Object.keys(original)) delete original[k];
  });

  function setEnv(key: string, value: string | undefined): void {
    if (!(key in original)) {
      original[key] = process.env[key];
    }
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  it('re-reads process.env on every access (lazy semantics)', () => {
    setEnv('AFK_MODEL', 'sonnet');
    expect(env.AFK_MODEL).toBe('sonnet');
    setEnv('AFK_MODEL', 'opus');
    expect(env.AFK_MODEL).toBe('opus');
  });

  it('returns undefined when the env var is unset', () => {
    setEnv('AFK_MAX_TOKENS', undefined);
    expect(env.AFK_MAX_TOKENS).toBeUndefined();
  });

  it('returns the raw string (no parsing applied)', () => {
    setEnv('AFK_MAX_TOKENS', '8192');
    expect(env.AFK_MAX_TOKENS).toBe('8192');
    expect(typeof env.AFK_MAX_TOKENS).toBe('string');
  });
});

describe('getEnvVarMeta', () => {
  it('returns the meta entry for a known var', () => {
    const meta = getEnvVarMeta('AFK_MODEL');
    expect(meta).toBeDefined();
    expect(meta?.name).toBe('AFK_MODEL');
    expect(meta?.category).toBe('model');
  });

  it('returns undefined for unknown var names', () => {
    expect(getEnvVarMeta('AFK_NOT_A_REAL_VAR_XYZ')).toBeUndefined();
  });
});

describe('getMissingRequiredEnvVars', () => {
  // Note: as of initial registry, no vars are marked required: true. This is
  // intentional — surfaces like Telegram surface their own startup checks. The
  // test still validates the helper's behavior with a synthetic registry filter.

  it('returns empty when no required vars exist (initial registry state)', () => {
    const missing = getMissingRequiredEnvVars();
    expect(missing).toEqual([]);
  });

  it('accepts a category filter', () => {
    // Should not throw even when no entries in that category are required.
    const missing = getMissingRequiredEnvVars('telegram');
    expect(Array.isArray(missing)).toBe(true);
  });
});
describe('secret hardening', () => {
  // Defends against the C1/C2 leak surfaces from PR #429 review:
  //   C1 — accidental serialization (JSON.stringify(env), console.log(env))
  //   C2 — credential-format example strings committed to git
  const SECRET_NAMES = ENV_REGISTRY.filter((e) => e.secret).map((e) => e.name);

  it('marks all auth-category entries as secret', () => {
    const authNotSecret = ENV_REGISTRY.filter((e) => e.category === 'auth' && !e.secret);
    expect(authNotSecret.map((e) => e.name)).toEqual([]);
  });

  it('marks the Telegram bot tokens as secret', () => {
    const tokens = ENV_REGISTRY.filter(
      (e) => e.name === 'TELEGRAM_BOT_TOKEN' || e.name === 'AFK_TELEGRAM_BOT_TOKEN',
    );
    expect(tokens.length).toBe(2);
    for (const t of tokens) expect(t.secret).toBe(true);
  });

  it('does not surface secret keys via Object.keys(env)', () => {
    const enumerableKeys = new Set(Object.keys(env));
    for (const name of SECRET_NAMES) {
      expect(enumerableKeys.has(name)).toBe(false);
    }
  });

  it('does not surface secret values via JSON.stringify(env)', () => {
    const sentinel = 'sk-test-XXXXXXXXXXXXXXXXXXXXXX-leakcheck';
    const original = process.env['ANTHROPIC_API_KEY'];
    try {
      process.env['ANTHROPIC_API_KEY'] = sentinel;
      const serialized = JSON.stringify(env);
      expect(serialized).not.toContain(sentinel);
      expect(serialized).not.toContain('ANTHROPIC_API_KEY');
    } finally {
      if (original === undefined) delete process.env['ANTHROPIC_API_KEY'];
      else process.env['ANTHROPIC_API_KEY'] = original;
    }
  });

  it('does not surface secret values via for...in iteration', () => {
    const sentinel = 'tg-test-XXXXXXXXXXXXXXX-leakcheck';
    const original = process.env['TELEGRAM_BOT_TOKEN'];
    try {
      process.env['TELEGRAM_BOT_TOKEN'] = sentinel;
      const seen: string[] = [];
      for (const k in env) seen.push(k);
      expect(seen).not.toContain('TELEGRAM_BOT_TOKEN');
    } finally {
      if (original === undefined) delete process.env['TELEGRAM_BOT_TOKEN'];
      else process.env['TELEGRAM_BOT_TOKEN'] = original;
    }
  });

  it('still allows direct property access on secret getters', () => {
    // Non-enumerable does NOT mean inaccessible. Direct reads must still work,
    // otherwise the runtime breaks for any code that legitimately needs the key.
    const original = process.env['ANTHROPIC_API_KEY'];
    try {
      process.env['ANTHROPIC_API_KEY'] = 'sentinel-value-direct-access';
      expect(env.ANTHROPIC_API_KEY).toBe('sentinel-value-direct-access');
    } finally {
      if (original === undefined) delete process.env['ANTHROPIC_API_KEY'];
      else process.env['ANTHROPIC_API_KEY'] = original;
    }
  });

  it('does not publish recognizable credential-format example strings', () => {
    // C2 — credential formats committed to git survive history forever and
    // trigger downstream secret-scanning false positives.
    const credentialPatterns: RegExp[] = [
      /^sk-ant-/, // Anthropic
      /^sk-proj-/, // OpenAI project keys
      /^\d{6,}:[A-Za-z0-9_-]{5,}/, // Telegram bot token shape (digits:chars)
    ];
    const leaks: { name: string; example: string }[] = [];
    for (const entry of ENV_REGISTRY) {
      if (!entry.example) continue;
      for (const pat of credentialPatterns) {
        if (pat.test(entry.example)) {
          leaks.push({ name: entry.name, example: entry.example });
        }
      }
    }
    expect(leaks).toEqual([]);
  });

  it('does not declare an example on any secret-tagged entry', () => {
    // Even non-credential-format examples (e.g. `local`) are forbidden on
    // secret entries — the constraint is "no published shape at all" so the
    // rule survives future credential-format changes.
    // AFK_LOCAL_API_KEY is the documented exception: its `default` and
    // `example` are both the literal placeholder string `local`, which the
    // user replaces when configuring a real local server.
    const ALLOWED_SECRET_EXAMPLES: Record<string, string> = {
      AFK_LOCAL_API_KEY: 'local',
    };
    const violations = ENV_REGISTRY.filter(
      (e) =>
        e.secret && e.example !== undefined && ALLOWED_SECRET_EXAMPLES[e.name] !== e.example,
    );
    expect(violations.map((e) => e.name)).toEqual([]);
  });
});
