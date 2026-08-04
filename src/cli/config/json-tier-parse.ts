// Contract: parse + validate ONE afk.config.json file.
//
// Extracted from json-tier.ts so the tier WALK (which file wins, caching,
// fall-through) and the per-file PARSE (what a file's contents mean) are
// separate concerns. Two consumers share this parser and they must never
// disagree about what a file resolves to:
//   - `loadJsonConfig()` (json-tier.ts)      — the real loader.
//   - `resolveConfigProvenance()` (provenance.ts) — reports the value `/config`
//     rows should display and whether a write will actually take effect.
// Before the split, provenance re-read the same files with a bare `JSON.parse`
// and reported RAW values, so it disagreed with the loader on every validated
// key (an invalid `permissionMode` the loader ignores, a lowercased model
// alias, a clamped `maxSummaryCallsPerSession`). Re-deriving validation is the
// bug; delegating to this module is the fix. Add a key here, never at a
// consumer.
//
// @module cli/config/json-tier-parse

import { readFileSync, existsSync } from 'fs';
import { isValidModel } from '../../agent/session/model-resolution.js';
import {
  parseModelsConfig,
  type ModelSlotBinding,
  type SlotName,
} from '../../agent/session/model-slots.js';
import { validateBranchPrefix, validateBaseRef } from '../commands/interactive/worktree.js';
import type { RawHooksConfig } from '../../agent/hooks/config-loader.js';
import { importFromConfigPaths, parseImportFromConfig } from '../../config/import-sources.js';
import type { AutoRoutingConfig, CliConfig, ConfigFileSchema } from './types.js';

/** One afk.config.json file's validated contents. */
export interface ParsedJsonConfigFile {
  readonly config: Partial<CliConfig>;
  /**
   * Slot bindings, kept separate from `config` because `CliConfig.models` is the
   * fully-resolved `ModelSlots` (defaults ← file ← env) that only `loadConfig()`
   * can compute. See {@link validatedValueView} for the dotted-path form.
   */
  readonly modelsPartial: Partial<Record<SlotName, ModelSlotBinding>>;
}

/**
 * Read, parse, and validate a single afk.config.json.
 *
 * Three outcomes, deliberately distinct — the tier walk treats them differently:
 *   - file absent          → returns `undefined` (NOT an error; skip the tier)
 *   - malformed / rejected → THROWS (the caller falls through to the next tier
 *                            and, in the loader, suppresses caching)
 *   - valid                → returns the validated values
 *
 * `model` accepts any non-empty string. Known aliases are normalized to lowercase;
 * provider-qualified and otherwise unknown model ids pass through unchanged.
 *
 * Throwing validators (`validateBranchPrefix`, `validateBaseRef`) are called
 * here on purpose: a config file whose worktree refs would be parsed by git as
 * flags is not a usable file, and the tier walk must skip it wholesale rather
 * than honour its other keys.
 */
export function parseJsonConfigFile(configPath: string): ParsedJsonConfigFile | undefined {
  if (!existsSync(configPath)) return undefined;

  const content = readFileSync(configPath, 'utf-8');
  const json: ConfigFileSchema = JSON.parse(content);

  const config: Partial<CliConfig> = {};
  const modelsPartial = parseModelsConfig(json.models);

  if (typeof json.model === 'string' && json.model.length > 0) {
    const loweredModel = json.model.toLowerCase();
    config.model = isValidModel(loweredModel) ? loweredModel : json.model;
  }

  if (typeof json.maxTokens === 'number') {
    config.maxTokens = json.maxTokens;
  }

  if (typeof json.temperature === 'number') {
    config.temperature = json.temperature;
  }

  if (typeof json.systemPrompt === 'string' && json.systemPrompt.length > 0) {
    config.systemPrompt = json.systemPrompt;
  }

  if (typeof json.permissionMode === 'string') {
    // Validate against the known modes; ignore garbage so a typo can't
    // silently land the session in an unexpected (or dangerous) mode.
    const pm = json.permissionMode;
    if (pm === 'default' || pm === 'plan' || pm === 'autonomous' || pm === 'bypassPermissions') {
      config.permissionMode = pm;
    }
  }

  if (json.autoRouting && typeof json.autoRouting === 'object') {
    const ar: AutoRoutingConfig = {};
    if (typeof json.autoRouting.interactive === 'boolean') ar.interactive = json.autoRouting.interactive;
    if (typeof json.autoRouting.chat === 'boolean') ar.chat = json.autoRouting.chat;
    if (typeof json.autoRouting.telegram === 'boolean') ar.telegram = json.autoRouting.telegram;
    if (typeof json.autoRouting.daemon === 'boolean') ar.daemon = json.autoRouting.daemon;
    config.autoRouting = ar;
  }

  if (json.daemon && typeof json.daemon === 'object') {
    const daemon: NonNullable<CliConfig['daemon']> = {};
    if (typeof json.daemon.task === 'string') {
      daemon.task = json.daemon.task;
    }
    if (typeof json.daemon.taskId === 'string') {
      daemon.taskId = json.daemon.taskId;
    }
    const wp = json.daemon.worktreePrune;
    if (wp && typeof wp === 'object') {
      daemon.worktreePrune = {
        enabled: typeof wp.enabled === 'boolean' ? wp.enabled : true,
        cron: typeof wp.cron === 'string' ? wp.cron : '0 4 * * *',
        maxAgeDaysClean: typeof wp.maxAgeDaysClean === 'number' ? wp.maxAgeDaysClean : 14,
        maxAgeDaysDirty: typeof wp.maxAgeDaysDirty === 'number' ? wp.maxAgeDaysDirty : 30,
        scope: typeof wp.scope === 'string' ? wp.scope : 'all',
      };
    }
    if (typeof json.daemon.verifyDone === 'boolean') {
      daemon.verifyDone = json.daemon.verifyDone;
    }
    config.daemon = daemon;
  }

  if (json.telegram && typeof json.telegram === 'object') {
    const telegram: NonNullable<ConfigFileSchema['telegram']> = {};
    const notify = json.telegram.notify;
    if (notify && typeof notify === 'object') {
      const parsed: NonNullable<NonNullable<ConfigFileSchema['telegram']>['notify']> = {};
      if (notify.mode === 'primary' || notify.mode === 'broadcast' || notify.mode === 'custom') {
        parsed.mode = notify.mode;
      }
      if (typeof notify.primaryChatId === 'number' && Number.isFinite(notify.primaryChatId)) {
        parsed.primaryChatId = notify.primaryChatId;
      }
      if (Array.isArray(notify.targets)) {
        const targets = notify.targets.filter(
          (t): t is number => typeof t === 'number' && Number.isFinite(t),
        );
        if (targets.length > 0) parsed.targets = targets;
      }
      telegram.notify = parsed;
    }
    if (typeof json.telegram.verifyDone === 'boolean') {
      telegram.verifyDone = json.telegram.verifyDone;
    }
    if (Array.isArray(json.telegram.tagOnlyChats)) {
      const tagOnly = json.telegram.tagOnlyChats.filter(
        (t): t is number => typeof t === 'number' && Number.isFinite(t),
      );
      if (tagOnly.length > 0) telegram.tagOnlyChats = tagOnly;
    }
    // chatAliases: name → chat-id map. Drop non-numeric, non-finite, and
    // zero values (0 is the sentinel for "no chat" throughout routing).
    if (
      json.telegram.chatAliases &&
      typeof json.telegram.chatAliases === 'object' &&
      !Array.isArray(json.telegram.chatAliases)
    ) {
      const aliases: Record<string, number> = {};
      for (const [name, id] of Object.entries(
        json.telegram.chatAliases as Record<string, unknown>,
      )) {
        if (typeof id === 'number' && Number.isFinite(id) && id !== 0) {
          aliases[name] = id;
        }
      }
      if (Object.keys(aliases).length > 0) telegram.chatAliases = aliases;
    }
    config.telegram = telegram;
  }

  if (json.updatePolicy && ['notify', 'auto', 'off'].includes(json.updatePolicy)) {
    config.updatePolicy = json.updatePolicy as 'notify' | 'auto' | 'off';
  }

  if (json.theme && ['dark', 'light', 'umber', 'auto'].includes(json.theme)) {
    config.theme = json.theme as 'dark' | 'light' | 'umber' | 'auto';
  }

  if (typeof json.autoResumeOnUsageLimit === 'boolean') {
    config.autoResumeOnUsageLimit = json.autoResumeOnUsageLimit;
  }

  if (typeof json.enforceDoneEvidence === 'boolean') {
    config.enforceDoneEvidence = json.enforceDoneEvidence;
  }

  if (typeof json.bgSummaries === 'boolean') {
    config.bgSummaries = json.bgSummaries;
  }

  if (typeof json.maxSummaryCallsPerSession === 'number') {
    // Clamp to [1, 500] — prevents runaway API spend from misconfigured values.
    config.maxSummaryCallsPerSession = Math.min(500, Math.max(1, json.maxSummaryCallsPerSession));
  }

  // Pass hooks through as-is (the hooks loader validates it fully).
  if (json.hooks !== null && typeof json.hooks === 'object' && !Array.isArray(json.hooks)) {
    config.hooks = json.hooks as RawHooksConfig;
  }

  if (typeof json.enableShellHooks === 'boolean') {
    config.enableShellHooks = json.enableShellHooks;
  }

  if (typeof json.enablePluginHooks === 'boolean') {
    config.enablePluginHooks = json.enablePluginHooks;
  }

  // Security: `importFrom` is a user-global-only trust grant — it lets AFK
  // live-read/execute another tool's assets (see loadImportFromConfig). A
  // project-local afk.config.json must NOT be able to set it, so honor it
  // only from the user-global / legacy config, never `<cwd>/afk.config.json`.
  //
  // Gate via an ALLOWLIST of the user-global + legacy paths
  // (`importFromConfigPaths()`, the same set the real gate reads) rather
  // than a cwd denylist. An allowlist fails closed: any path that isn't
  // provably one of those two files — including a symlinked or case-variant
  // `<cwd>/afk.config.json` — is denied, closing the exact-string-compare
  // gap the old `configPath !== join(cwd, ...)` check left open (#501-F5).
  //
  // Note: `config.importFrom` is exposed on `CliConfig` for completeness and
  // inspection (e.g. `--dump-prompt` tooling), but runtime asset scanners
  // deliberately call `loadImportFromConfig()` directly — the agent layer
  // cannot import from `src/cli/` without a circular-dependency violation.
  // This guard is intentional defense-in-depth mirroring that real gate.
  if (importFromConfigPaths().includes(configPath)) {
    const importFrom = parseImportFromConfig(json.importFrom);
    if (importFrom !== undefined) {
      config.importFrom = importFrom;
    }
  }

  if (json.interactive && typeof json.interactive === 'object') {
    const interactive: NonNullable<CliConfig['interactive']> = {};
    if (typeof json.interactive.worktreeAutoname === 'boolean') {
      interactive.worktreeAutoname = json.interactive.worktreeAutoname;
    }
    if (typeof json.interactive.worktreeBranchPrefix === 'string') {
      // Validate at config-read time — the value is concatenated into
      // a `git worktree add -b <prefix><slug>` invocation, so a value
      // starting with `--` or containing shell metacharacters would
      // turn an attacker-writable JSON file into a CLI-flag injection.
      // Allowlist matches `AFK_WORKTREE_BRANCH_PREFIX` env handling.
      interactive.worktreeBranchPrefix = validateBranchPrefix(
        json.interactive.worktreeBranchPrefix,
        `${configPath}#/interactive/worktreeBranchPrefix`,
      );
    }
    if (
      typeof json.interactive.worktreeBase === 'string' &&
      json.interactive.worktreeBase.trim().length > 0
    ) {
      // Validate at config-read time — the value is spliced into
      // `git fetch` / `git rev-parse` / `git worktree add` invocations,
      // so a value starting with `-` could be parsed by git as a flag.
      validateBaseRef(
        json.interactive.worktreeBase,
        `${configPath}#/interactive/worktreeBase`,
      );
      interactive.worktreeBase = json.interactive.worktreeBase;
    }
    if (
      json.interactive.worktreeOnExit === 'ask' ||
      json.interactive.worktreeOnExit === 'keep' ||
      json.interactive.worktreeOnExit === 'remove'
    ) {
      interactive.worktreeOnExit = json.interactive.worktreeOnExit;
    }
    if (typeof json.interactive.suggestGhost === 'boolean') {
      interactive.suggestGhost = json.interactive.suggestGhost;
    }
    // Display-only enum; silently ignore anything outside the allowlist
    // rather than throwing — a stray value shouldn't fail config load.
    if (
      json.interactive.thinkingUi === 'summary' ||
      json.interactive.thinkingUi === 'live' ||
      json.interactive.thinkingUi === 'digest' ||
      json.interactive.thinkingUi === 'off'
    ) {
      interactive.thinkingUi = json.interactive.thinkingUi;
    }
    if (Object.keys(interactive).length > 0) {
      config.interactive = interactive;
    }
  }

  return { config, modelsPartial };
}

/**
 * A parsed file's values as one dotted-path-walkable record, for consumers that
 * ask "what does this file resolve `<path>` to?" (`/config` provenance).
 *
 * Splices `modelsPartial` back under `models` so `models.large` resolves to the
 * binding the loader built (`"gpt-4o"` → `{ id: 'gpt-4o' }`), not the raw JSON.
 */
export function validatedValueView(parsed: ParsedJsonConfigFile): Record<string, unknown> {
  const view: Record<string, unknown> = { ...parsed.config };
  if (Object.keys(parsed.modelsPartial).length > 0) view['models'] = parsed.modelsPartial;
  return view;
}
