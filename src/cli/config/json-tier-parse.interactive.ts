/**
 * Parse the `interactive` block from an afk.config.json file.
 *
 * Extracted from {@link parseJsonConfigFile} to keep that function within the
 * 200-line function ceiling. All validation rules are identical to the original
 * inline block.
 *
 * @module cli/config/json-tier-parse.interactive
 */
import type { CliConfig, ConfigFileSchema } from './types.js';
import { validateBranchPrefix, validateBaseRef } from '../commands/interactive/worktree.js';

type InteractiveConfig = NonNullable<CliConfig['interactive']>;

/**
 * Parse and validate the `interactive` section of a raw config file schema.
 * Returns `undefined` when the section is absent, not an object, or yields no
 * recognised keys.
 *
 * @param raw       The raw `json.interactive` value from the config file.
 * @param configPath The config file path — used in validation error messages so
 *                  the user can locate the offending file.
 */
export function parseInteractiveBlock(
  raw: ConfigFileSchema['interactive'],
  configPath: string,
): InteractiveConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;

  const interactive: InteractiveConfig = {};

  if (typeof raw.worktreeAutoname === 'boolean') {
    interactive.worktreeAutoname = raw.worktreeAutoname;
  }
  if (typeof raw.worktreeBranchPrefix === 'string') {
    // Validate at config-read time — the value is concatenated into
    // a `git worktree add -b <prefix><slug>` invocation, so a value
    // starting with `--` or containing shell metacharacters would
    // turn an attacker-writable JSON file into a CLI-flag injection.
    // Allowlist matches `AFK_WORKTREE_BRANCH_PREFIX` env handling.
    interactive.worktreeBranchPrefix = validateBranchPrefix(
      raw.worktreeBranchPrefix,
      `${configPath}#/interactive/worktreeBranchPrefix`,
    );
  }
  if (
    typeof raw.worktreeBase === 'string' &&
    raw.worktreeBase.trim().length > 0
  ) {
    // Validate at config-read time — the value is spliced into
    // `git fetch` / `git rev-parse` / `git worktree add` invocations,
    // so a value starting with `-` could be parsed by git as a flag.
    validateBaseRef(
      raw.worktreeBase,
      `${configPath}#/interactive/worktreeBase`,
    );
    interactive.worktreeBase = raw.worktreeBase;
  }
  if (
    raw.worktreeOnExit === 'ask' ||
    raw.worktreeOnExit === 'keep' ||
    raw.worktreeOnExit === 'remove'
  ) {
    interactive.worktreeOnExit = raw.worktreeOnExit;
  }
  if (typeof raw.suggestGhost === 'boolean') {
    interactive.suggestGhost = raw.suggestGhost;
  }
  // Display-only enum; silently ignore anything outside the allowlist
  // rather than throwing — a stray value shouldn't fail config load.
  if (
    raw.thinkingUi === 'summary' ||
    raw.thinkingUi === 'live' ||
    raw.thinkingUi === 'digest' ||
    raw.thinkingUi === 'off'
  ) {
    interactive.thinkingUi = raw.thinkingUi;
  }

  return Object.keys(interactive).length > 0 ? interactive : undefined;
}
