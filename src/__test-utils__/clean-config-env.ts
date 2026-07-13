// Global test setup: neutralize the developer's ambient AFK_*/provider config
// so tests assert framework DEFAULTS, not whatever is configured on the machine
// running them.
//
// History: this started as a hand-maintained allowlist of ~22 config-override
// var names. A devils-advocate review found the list was already incomplete
// (it omitted AFK_TEMPERATURE, AFK_THINKING, AFK_TIMEOUT_MS, AFK_MODEL_MEDIUM,
// AFK_TELEGRAM_*, and the tier-2 model slots) and would rot silently as new
// vars were added. It is now DERIVED from ENV_REGISTRY — see the Invariant
// below. Full rationale: docs/test-env-isolation.md (add on next touch).
//
// Bleed vector — inherited shell env: the vitest process inherits every
// exported AFK_* / provider var (AFK_MODEL, AFK_COMPACT_MODEL, AFK_TELEGRAM_*,
// …), and src/config/env.ts reads each one LIVE from process.env. A test
// exercising production code that reads one of those getters WITHOUT stubbing
// it picks up the dev's value — e.g. an exported AFK_COMPACT_MODEL once flipped
// the compact() summarizer assertion. The beforeEach below deletes every
// registry-known config-override var so each test starts from a known baseline;
// a test that needs a value sets it explicitly (process.env / vi.stubEnv).
//
// Invariant: the clear-list is DERIVED from ENV_REGISTRY, never hand-listed.
// Every env getter in src/config/env.ts must have a matching ENV_REGISTRY entry
// (enforced by the env.ts header contract + `pnpm scan:env`), so a newly-added
// config var is covered automatically — no second place to update, no silent
// allowlist rot.
//
// Invariant: categories 'paths' and 'process' are NEVER cleared. 'paths'
// (AFK_HOME, AFK_STATE_DIR, AFK_FRAMEWORK_DIR) is BOTH the redirect surface ~11
// test files assign at module-eval time (before any beforeEach runs) AND the
// subject of ~44 tests that assert the UNSET fallback (getAfkHome() → ~/.afk,
// AFK.md → ~/.afk/AFK.md, hot-memory/session-store paths). Clearing or sealing
// it breaks both groups. 'process' carries runtime/system vars (PATH, NODE_ENV,
// VITEST, CI) and the bash/path security guards — clearing those would break
// vitest itself and any subprocess-spawning test.
//
// Residual: the OTHER bleed vector — loadConfig() dotenv-loading the real
// ~/.afk/config/afk.env (override:false) and repopulating deleted vars — is NOT
// closed here. Sealing AFK_HOME to a temp dir would close it but breaks the ~44
// unset-fallback tests above (verified). It is instead handled per-test: the
// few suites that call loadConfig() mock dotenv or reset the config cache. No
// test currently exhibits repopulation bleed (full-suite verified green with a
// hostile real afk.env present).
import { beforeEach, afterEach, vi } from 'vitest';
import { ENV_REGISTRY } from '../config/env.js';

/**
 * Registry categories that must NOT be cleared between tests. See module header.
 */
const NON_OVERRIDE_CATEGORIES: ReadonlySet<string> = new Set(['paths', 'process']);

/**
 * Config-override env vars cleared before every test, derived from ENV_REGISTRY
 * (the single source of truth). A test needing a specific value sets it itself.
 */
const CONFIG_OVERRIDE_VARS: readonly string[] = ENV_REGISTRY.filter(
  (entry) => !NON_OVERRIDE_CATEGORIES.has(entry.category),
).map((entry) => entry.name);

beforeEach(() => {
  for (const key of CONFIG_OVERRIDE_VARS) {
    delete process.env[key]; // audit-env-access: allow — dynamic delete of registry-derived config keys
  }
});

afterEach(() => {
  // Revert any vi.stubEnv overrides a test installed. The raw deletes above are
  // re-applied every beforeEach, so they need no explicit restore.
  vi.unstubAllEnvs();
});
