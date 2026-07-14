// Contract: the afk.config.json tier of the CLI config loader (#368 split).
// This module is the SINGLE home of `jsonConfigCache`. Sibling modules and
// the `config.ts` facade must never duplicate it — the facade resets it only
// through `resetJsonConfigCache()` exported here, because ESM importers
// cannot reassign an imported binding (same pattern as `setState()` in the
// #366 plugin-skills split).

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { isValidModel } from '../../agent/session/model-resolution.js';
import {
  parseModelsConfig,
  type ModelSlotBinding,
  type SlotName,
} from '../../agent/session/model-slots.js';
import { getJsonConfigPath, getLegacyJsonConfigPath } from '../../paths.js';
import { validateBranchPrefix, validateBaseRef } from '../commands/interactive/worktree.js';
import type { RawHooksConfig } from '../../agent/hooks/config-loader.js';
import { importFromConfigPaths, parseImportFromConfig } from '../../config/import-sources.js';
import type { AutoRoutingConfig, CliConfig, ConfigFileSchema } from './types.js';

/**
 * Process-lifetime caches for the disk-backed config tiers. `afk chat` calls
 * `loadConfig()` 2× per invocation (CLI bootstrap reads `updatePolicy`, then
 * the command handler reads `systemPromptSource`) and `loadConfigSystemPrompt()`
 * walks the same JSON + AFK.md tiers a third time. The disk layout doesn't
 * change between those calls in normal operation, so we memoize the file
 * reads and serve subsequent calls in O(1).
 *
 * Tests that mutate `HOME` / `process.cwd()` / fs mocks between cases must
 * call `_resetConfigCache()` in `beforeEach` — the cache is keyed on
 * neither, so stale entries would survive otherwise. Future plugin-install
 * style hooks that mutate config files should call this too.
 */
let jsonConfigCache:
  | {
      config: Partial<CliConfig>;
      sourcePath: string | undefined;
      modelsPartial: Partial<Record<SlotName, ModelSlotBinding>>;
    }
  | undefined;

/**
 * Clear this tier's memoized JSON config. Called (only) by
 * `_resetConfigCache()` in the `config.ts` facade — the cache binding lives
 * here and cannot be reassigned by importers under ESM live-binding rules.
 */
export function resetJsonConfigCache(): void {
  jsonConfigCache = undefined;
}

/**
 * Load configuration from afk.config.json.
 *
 * `model` accepts any string — the Claude short-alias set is validated
 * only for the purpose of preserving the previous behaviour of ignoring
 * unknown short aliases ("sonnet_pro" → fall through to default). Non-
 * Claude model ids still pass through untouched because `isValidModel`
 * returns false and we only gate on it for the short-alias case.
 *
 * Returns `{ config, sourcePath }` where `sourcePath` is the absolute path
 * of the file that was actually read, or `undefined` when no config file
 * was found. Used by `loadConfig()` to populate `systemPromptSource`.
 *
 * Memoized via `jsonConfigCache` — see the cache block above for the
 * invalidation contract.
 */
export function loadJsonConfig(): {
  config: Partial<CliConfig>;
  sourcePath: string | undefined;
  modelsPartial: Partial<Record<SlotName, ModelSlotBinding>>;
} {
  if (jsonConfigCache !== undefined) return jsonConfigCache;
  const configPaths = [
    join(process.cwd(), 'afk.config.json'),
    getJsonConfigPath(),
    getLegacyJsonConfigPath(),
  ];

  // Invariant: a parse failure in an earlier tier must NOT permanently
  // memoize the fallen-through result (#501-F2). If a malformed
  // `<cwd>/afk.config.json` falls through to the user-global file and we
  // cached THAT, a later fix to the cwd file would stay invisible until
  // `_resetConfigCache()`/process restart — which bites long-lived
  // daemon/telegram processes (one-shot CLI self-heals on the next spawn).
  // So when any file in the walk fails to parse, we return the resolved
  // result transiently (uncached) and re-read disk on the next call.
  let sawParseError = false;

  for (const configPath of configPaths) {
    if (existsSync(configPath)) {
      try {
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
          const daemon: {
            task?: string;
            taskId?: string;
            worktreePrune?: {
              enabled: boolean;
              cron: string;
              maxAgeDaysClean: number;
              maxAgeDaysDirty: number;
              scope: string;
            };
            verifyDone?: boolean;
          } = {};
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
          config.telegram = telegram;
        }

        if (json.updatePolicy && ['notify', 'auto', 'off'].includes(json.updatePolicy)) {
          config.updatePolicy = json.updatePolicy as 'notify' | 'auto' | 'off';
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

        const result = { config, sourcePath: configPath, modelsPartial };
        // Only memoize when the walk was clean — see the sawParseError
        // invariant above (a fall-through past a malformed earlier tier is
        // returned but not cached, so a later fix is picked up on re-read).
        if (!sawParseError) jsonConfigCache = result;
        return result;
      } catch (error) {
        console.error(`Warning: Failed to parse ${configPath}:`, error);
        sawParseError = true;
      }
    }
  }

  const emptyResult = { config: {}, sourcePath: undefined, modelsPartial: {} };
  if (!sawParseError) jsonConfigCache = emptyResult;
  return emptyResult;
}
