/**
 * Effective-value + provenance resolution for afk config keys.
 *
 * Why this exists: `/config` writes to ONE file — `$AFK_HOME/config/afk.config.json`
 * (mutate.ts `jsonPath()`) — but the loader resolves a key across four tiers:
 * env > project afk.config.json > user afk.config.json > legacy. So a user could
 * set `model` in the settings menu, watch it save, restart, and still run the old
 * model, because `AFK_MODEL` or a project-local config outranks the file that was
 * written. No signal was surfaced anywhere. This module computes what the loader
 * will ACTUALLY use and which tier supplied it, so the menu can render the truth
 * and warn at write time when a write lands beneath a shadowing tier.
 *
 * Two semantics are load-bearing and are NOT re-derived here — both come from
 * the loader's own code so the report cannot drift from what will actually load:
 *   - FILE-level selection. `loadJsonConfig()` stops at the first file that
 *     parses and validates; that file alone supplies config. A key it omits
 *     resolves to its DEFAULT, not to a lower file. So a project config holding
 *     one unrelated key silently neutralises the entire user config, and this
 *     module must say so.
 *   - Validated values. An invalid `permissionMode` is ignored, a model alias is
 *     lowercased, `maxSummaryCallsPerSession` is clamped, and a bad worktree ref
 *     makes the whole file fall through. Reporting the RAW JSON would misstate
 *     every one of those. `json-tier-parse.ts` is the single parser.
 *
 * Read-only: nothing here mutates config. Writes stay in `src/config/mutate.ts`.
 *
 * @module cli/config/provenance
 */

import { readFileSync, existsSync } from 'fs';
import { getEnvVarMeta, getEnvVarValue, isEnvVarSet } from '../../config/env.js';
import { getAtPath } from '../../config/settable-keys.js';
import { maskSecret } from '../../config/mutate.js';
import { parseJsonConfigFile, validatedValueView } from './json-tier-parse.js';
import { jsonConfigTierPaths, TIER_LABELS, type JsonConfigTier } from './json-tier-paths.js';
import { NO_PROVENANCE_CACHE, type ProvenanceCache } from './provenance-cache.js';

// ── The env-shadow map ───────────────────────────────────────────────────────

/**
 * Invariant: config path → the env var(s) that override it, highest precedence
 * first. Every entry is verified against the actual override site; a key absent
 * from this map has NO env override and its config value always wins.
 *
 * Sites (do not edit this map without re-reading them):
 *   model                  cli/config/env-tier.ts:206-212  (AFK_MODEL ?? CLAUDE_MODEL)
 *   maxTokens              cli/config/env-tier.ts:254-265  (gated: Number.isInteger)
 *   temperature            cli/config/env-tier.ts:268-272  (gated: Number.isFinite)
 *   systemPrompt           cli/config/env-tier.ts:275-276
 *   autoRouting.*          cli/config/env-tier.ts:279-281  (sets ALL FOUR at once)
 *   theme                  cli/theme.ts:136-146            (resolveTheme)
 *   interactive.thinkingUi cli/commands/interactive.ts:158 (resolveThinkingUi)
 *   interactive.suggestGhost cli/commands/interactive/repl-loop.ts:85
 *   models.<tier>          agent/session/model-slots.ts:220-223
 *
 * Deliberately NOT here: `permissionMode` has no env override — it resolves
 * JSON-only via `resolveCliPermissionMode()` (cli/config.ts), so listing an env
 * twin would be wrong.
 */
export const CONFIG_ENV_SHADOWS: Readonly<Record<string, readonly string[]>> = {
  model: ['AFK_MODEL', 'CLAUDE_MODEL'],
  maxTokens: ['AFK_MAX_TOKENS'],
  temperature: ['AFK_TEMPERATURE'],
  systemPrompt: ['AFK_SYSTEM_PROMPT'],
  'autoRouting.interactive': ['AFK_AUTO_ROUTING'],
  'autoRouting.chat': ['AFK_AUTO_ROUTING'],
  'autoRouting.telegram': ['AFK_AUTO_ROUTING'],
  'autoRouting.daemon': ['AFK_AUTO_ROUTING'],
  theme: ['AFK_THEME'],
  'interactive.thinkingUi': ['AFK_THINKING_UI'],
  'interactive.suggestGhost': ['AFK_SUGGEST_GHOST'],
  'models.local': ['AFK_MODEL_LOCAL'],
  'models.small': ['AFK_MODEL_SMALL'],
  'models.medium': ['AFK_MODEL_MEDIUM'],
  'models.large': ['AFK_MODEL_LARGE'],
};

/**
 * Env vars whose presence overrides config only when the value parses. An
 * unparseable `AFK_MAX_TOKENS=abc` is skipped by the loader
 * (env-tier.ts:264-265), so config still wins and we must not claim otherwise.
 */
const PARSE_GATED: Readonly<Record<string, (raw: string) => boolean>> = {
  AFK_MAX_TOKENS: (raw) => Number.isInteger(Number(raw)),
  AFK_TEMPERATURE: (raw) => Number.isFinite(Number(raw)),
};

// ── Result shape ─────────────────────────────────────────────────────────────

export type ConfigSource =
  | { readonly kind: 'env'; readonly via: string }
  | { readonly kind: JsonConfigTier; readonly path: string }
  | { readonly kind: 'default' };

export interface ConfigProvenance {
  readonly path: string;
  /** The value the loader will actually use. */
  readonly effective: unknown;
  /** Which tier supplied `effective` (`default` when no tier sets the key). */
  readonly source: ConfigSource;
  /**
   * Set when a tier ABOVE the user-global file wins the load — i.e. a `/config`
   * write would persist but not take effect. This is the warning the menu
   * surfaces at write time.
   *
   * Because selection is FILE-level, this fires even when the shadowing file
   * does not mention the key: a project config that loads at all suppresses the
   * user file entirely, so the write is inert either way. `source.kind` tells
   * the two apart (`project` = it sets the key; `default` = it merely blocks).
   */
  readonly shadowedBy?: ConfigSource;
  /** The raw value in the user-global file `/config` writes to (may differ). */
  readonly userValue: unknown;
}

/** One-line human label for a source, e.g. `env AFK_MODEL` or `user afk.config.json`. */
export function describeSource(src: ConfigSource): string {
  if (src.kind === 'env') return `env ${src.via}`;
  if (src.kind === 'default') return 'default';
  return TIER_LABELS[src.kind];
}

// ── Display helpers (plain strings — the caller applies colour) ───────────────

/**
 * Row suffix naming the tier in effect, or undefined when the value comes from
 * the same file `/config` writes to (the unsurprising case, left unannotated to
 * keep the menu quiet).
 *
 * The one noisy `default` is a shadowed one: a higher tier won the load but
 * omits this key, so the row shows `(unset)` while a write to the user file
 * would still be inert. Unannotated, that row is indistinguishable from a key
 * the menu genuinely controls, and the user only discovers the shadow one
 * screen deeper in the edit header — the misattribution this suffix exists to
 * prevent.
 */
export function sourceSuffix(prov: ConfigProvenance): string | undefined {
  if (prov.source.kind === 'default') {
    return prov.shadowedBy
      ? `← default (${describeSource(prov.shadowedBy)} active — see ⚠)`
      : undefined;
  }
  if (prov.source.kind === 'user') return undefined;
  return `← ${describeSource(prov.source)}`;
}

/**
 * The warning shown when a write to the user-global file will NOT take effect
 * because a higher-precedence tier wins the load. Undefined when the write is
 * the winning tier.
 */
export function shadowNote(prov: ConfigProvenance): string | undefined {
  const s = prov.shadowedBy;
  if (!s) return undefined;
  if (s.kind === 'env') {
    return `${s.via} is set in the environment and overrides this file — unset it for this change to take effect.`;
  }
  if (s.kind === 'project') {
    // File-level selection: when the effective source is `default`, the project
    // file won but omitted this key; otherwise the project file supplied it.
    return prov.source.kind === 'default'
      ? `${s.path} outranks the user config and is loaded INSTEAD of it (config files are not merged), so this key falls back to its default — set it in that file for this change to take effect.`
      : `${s.path} sets this key and outranks the user config — edit that file for this change to take effect.`;
  }
  return `${describeSource(s)} overrides this file.`;
}

// ── Resolution ───────────────────────────────────────────────────────────────

/**
 * The RAW contents of the file `/config` writes to — used only for `userValue`,
 * which describes what an edit would replace. Deliberately unvalidated: it
 * answers "what is literally in my file", not "what will load".
 */
function readRawJsonFile(file: string): Record<string, unknown> | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf-8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    // A malformed file is skipped by the loader too (json-tier.ts falls through
    // on parse error), so skipping it here keeps provenance consistent with
    // what will actually load rather than throwing into the menu render.
    return undefined;
  }
}

/**
 * The VALIDATED contents of a tier, or undefined when the loader would skip it
 * (absent, malformed, or rejected by a throwing validator). Same parser the
 * loader uses, so the two cannot disagree.
 */
function readValidatedTier(file: string): Record<string, unknown> | undefined {
  try {
    const parsed = parseJsonConfigFile(file);
    return parsed === undefined ? undefined : validatedValueView(parsed);
  } catch {
    // Malformed JSON or a validator that threw: `loadJsonConfig()` warns and
    // falls through to the next tier, so we skip it too. Never throws into the
    // menu render.
    return undefined;
  }
}

/**
 * The env var currently overriding `path`, if any (honors the parse gates).
 *
 * Invariant: a SET-but-empty var STOPS the walk instead of falling through to
 * a lower-precedence alias. The loader binds multi-var chains with `??`
 * (env-tier.ts:206, `env.AFK_MODEL ?? env.CLAUDE_MODEL`), and `??` does not
 * fall through on '' — the truthiness gate then skips the override entirely.
 * Falling through here would report a shadow (e.g. CLAUDE_MODEL) that the
 * loader never applies. Unset vars, by contrast, DO fall through in both
 * layers. Single-var entries are unaffected: stop and continue agree when no
 * alias remains.
 */
export function activeEnvShadow(path: string): string | undefined {
  for (const name of CONFIG_ENV_SHADOWS[path] ?? []) {
    if (!isEnvVarSet(name)) continue; // unset → the loader's `??` falls to the next alias
    const raw = getEnvVarValue(name);
    // Set-but-empty: the loader binds '' and its truthiness gate skips the
    // override — no shadow, and no fall-through to a lower-precedence alias.
    if (raw === undefined) return undefined;
    const gate = PARSE_GATED[name];
    if (gate && !gate(raw)) continue;
    return name;
  }
  return undefined;
}

/**
 * Resolve a config key to the value the loader will use, plus its origin.
 *
 * Precedence mirrors the loader exactly: env > (first loadable JSON file) >
 * default. Note the middle term: the JSON tiers are NOT merged per key. The
 * first tier whose file loads WINS THE WHOLE FILE, so a key it omits reports
 * `default` rather than a lower tier's value — which is exactly what
 * `loadJsonConfig()` does, and the reason a project config with one unrelated
 * key makes every user-config value inert.
 *
 * `cache` deduplicates the file reads across a batch of keys — pass one shared
 * cache per render pass and drop it after (see provenance-cache.ts: it must not
 * survive an `await`, or a write made mid-session would render stale). Omit it
 * for one-shot resolution; every read then hits disk, as before.
 */
export function resolveConfigProvenance(
  path: string,
  cache: ProvenanceCache = NO_PROVENANCE_CACHE,
): ConfigProvenance {
  const tiers = jsonConfigTierPaths();
  const userTier = tiers.find((t) => t.tier === 'user');
  // `userValue` is the RAW value in the write-target file: it describes what a
  // `/config` edit replaces, independent of whether that file wins the walk.
  const userValue = userTier
    ? getAtPath(
        (cache.raw(userTier.path, () => readRawJsonFile(userTier.path)) ?? {}) as never,
        path,
      )
    : undefined;

  const envVar = activeEnvShadow(path);
  if (envVar !== undefined) {
    const meta = getEnvVarMeta(envVar);
    const raw = getEnvVarValue(envVar);
    const shown = meta?.secret === true ? maskSecret(raw) : raw;
    const source: ConfigSource = { kind: 'env', via: envVar };
    return { path, effective: shown, source, shadowedBy: source, userValue };
  }

  for (const tier of tiers) {
    const obj = cache.validated(tier.path, () => readValidatedTier(tier.path));
    if (obj === undefined) continue; // absent / malformed / rejected → next tier
    // FILE-level selection: this tier wins even if it omits `path`. An absent
    // key here resolves to the default, so `effective` is undefined and the
    // source is 'default' — but a tier above 'user' still shadows the write,
    // because the write cannot take effect while that file is the one loading.
    const value = getAtPath(obj as never, path);
    const source: ConfigSource = { kind: tier.tier, path: tier.path };
    // Only a tier ABOVE 'user' shadows what `/config` writes. 'user' is the
    // write target itself, and 'legacy' ranks below it (and can only be reached
    // when the user file is absent or unloadable, in which case a write to the
    // user file creates the higher-precedence tier and does take effect).
    const shadowedBy = tier.tier === 'project' ? { shadowedBy: source } : {};
    return {
      path,
      effective: value,
      source: value === undefined ? { kind: 'default' } : source,
      ...shadowedBy,
      userValue,
    };
  }

  return { path, effective: undefined, source: { kind: 'default' }, userValue };
}
