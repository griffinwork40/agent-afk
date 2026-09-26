/**
 * Shared CLI option definitions for `afk chat` and `afk interactive`.
 *
 * Both commands expose a nearly-identical set of options: model selection,
 * thinking/effort/budget knobs, provider/MCP wiring, worktree isolation, and
 * session-resume flags.  This helper centralises those option registrations so
 * each command only lists its own unique flags, keeping both files under the
 * 350-line CI ceiling while ensuring option parity without copy-paste drift.
 *
 * Usage:
 *   applySharedChatOptions(cmd, { maxTurnsDefault: '10' })
 *     .option('--format <format>', '...')  // chat-only
 *
 * The `overrides` argument lets each command tweak shared defaults (e.g.
 * --max-turns default differs: 10 for chat, 100 for interactive).
 */

import type { Command } from 'commander';
import { getModel } from '../shared-helpers.js';
import { parseThemeFlag } from '../theme.js';

export interface SharedChatOptionOverrides {
  /** Default value for --max-turns. Chat uses '10', interactive uses '100'. */
  maxTurnsDefault?: string;
  /**
   * Override description suffix for --theme.
   * Interactive appends 'Toggle live with /theme.' to the shared base text.
   */
  themeDescriptionSuffix?: string;
  /**
   * Override description for -w, --worktree.
   * Chat and interactive describe the on-exit behaviour differently.
   */
  worktreeDescription?: string;
  /**
   * Override description suffix for --worktree-base.
   * Interactive notes the config-file precedence; chat omits it.
   */
  worktreeBaseDescriptionSuffix?: string;
  /**
   * Override description for --dangerously-skip-permissions.
   * Interactive mentions the live Shift+Tab toggle; chat omits it.
   */
  dangerouslySkipPermissionsDescription?: string;
}

const THEME_BASE =
  'TUI color palette: dark|light|umber|auto. Default dark. umber matches the Umber terminal (dark-only). Also: AFK_THEME env, or theme in afk.config.json.';

const WORKTREE_BASE_BASE =
  "Base git ref for the worktree created by --worktree. Default: the remote's default branch (origin/main), fetched fresh. Pass HEAD to base on your local checkout instead. Also: AFK_WORKTREE_BASE";

const DSP_BASE =
  'Force bypass mode (already the default for new installs): skip path-approval prompts; read/write ANY path with no confirmation';

/**
 * Register the options shared by `afk chat` and `afk interactive` onto `cmd`.
 *
 * Returns `cmd` so callers can chain additional command-specific options:
 *
 *   applySharedChatOptions(program.command('chat'), { maxTurnsDefault: '10' })
 *     .option('--format <format>', 'Output format (text|json|stream-json)', 'text')
 *     .action(async (rawMessage, options) => { … });
 */
export function applySharedChatOptions(
  cmd: Command,
  overrides: SharedChatOptionOverrides = {},
): Command {
  const {
    maxTurnsDefault = '10',
    themeDescriptionSuffix = '',
    worktreeDescription =
      'Create a git worktree for an isolated one-shot. Optional value sets the branch name; ' +
      'otherwise auto-named. On clean exit (no uncommitted changes) the worktree and branch ' +
      'are auto-removed; on dirty exit the worktree is preserved.',
    worktreeBaseDescriptionSuffix = '.',
    dangerouslySkipPermissionsDescription =
      DSP_BASE +
      ' (permissionMode=bypassPermissions). Disable persistently with `afk config set permissionMode default`. Does not affect ask_question.',
  } = overrides;

  return cmd
    .option(
      '-m, --model <model>',
      'Model to use. Short aliases: opus|opus_1m|opus-5.5|opus-5.5_1m|sonnet|sonnet_1m|haiku. ' +
        'Any other value (e.g. `auto` for cursor-api-proxy, or a full `claude-*` ID) passes through to the SDK/proxy untouched.',
      getModel(),
    )
    .option('--max-turns <number>', 'Maximum conversation turns', maxTurnsDefault)
    .option('--thinking <mode>', "Thinking mode: 'adaptive' | 'disabled' | 'max' | 'enabled:<N>'", 'enabled:max')
    .option('--effort <level>', 'Effort level: low|medium|high|xhigh|max')
    .option(
      '--theme <mode>',
      (THEME_BASE + (themeDescriptionSuffix ? ' ' + themeDescriptionSuffix : '')).trimEnd(),
      parseThemeFlag,
    )
    .option('--max-output-tokens <n|max>', "Per-response output cap ('max' = model ceiling). Env: AFK_MAX_OUTPUT_TOKENS")
    .option('--provider <name>', 'Provider to use: anthropic|anthropic-direct|openai|openai-compatible|xai|xai-oauth. Default: auto-selected by model')
    .option('--dump-prompt [path]', 'Dump resolved SDK prompt+options+provenance to file (default: ~/.afk/logs/prompt-dump-<ISO>.json) or "stderr"')
    .option(
      '-w, --worktree [branch]',
      worktreeDescription,
    )
    .option(
      '--worktree-base <ref>',
      WORKTREE_BASE_BASE + worktreeBaseDescriptionSuffix,
    )
    .option(
      '--mcp-config <path>',
      'Path to an additional MCP config file (highest priority — merges over ~/.afk/config/mcp.json, project-local .mcp.json, and plugin-contributed configs). File format identical to mcp.json.',
    )
    .option('--resume <id>', 'Resume a persisted session by id')
    .option('--continue', 'Continue the most recent persisted session in cwd')
    .option('--dangerously-skip-permissions', dangerouslySkipPermissionsDescription);
}
