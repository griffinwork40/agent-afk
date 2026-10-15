/**
 * Tool schemas for worktree management and configuration built-ins:
 * worktree, terminal_font_size, config_get, config_set.
 *
 * Extracted into its own file to satisfy the 350-code-line ratchet on
 * `schemas.ts` (baselined files may shrink, never grow). Imported and
 * re-exported from `schemas.ts` so callers import from the primary module.
 *
 * @module agent/tools/schemas.worktree-tools
 */

import type { AnthropicToolDef } from './types.js';

export const worktreeTool: AnthropicToolDef = {
  name: 'worktree',
  category: 'other',
  concurrencySafe: false,
  riskClass: 'caution',
  description:
    'Manage afk-managed git worktrees under `<repoRoot>/.afk-worktrees/`. This is the sanctioned ' +
    'lifecycle for agent-created worktrees — prefer it over raw `git worktree` bash commands, because ' +
    'it writes the `.afk-worktree-meta.json` the background sweep engine uses to know a worktree is ' +
    'owned and alive. Worktrees created via bare `bash: git worktree add` have no meta and are ' +
    'eventually reaped as ghosts (or leak forever if created outside `.afk-worktrees/`).\n\n' +
    'Actions:\n' +
    '- `create` — new worktree + branch under `.afk-worktrees/<name>` with proper meta. `base` picks ' +
    'the start ref (default HEAD). Returns { path, branch, base, note }, where `note` warns that the ' +
    'fresh worktree has no installed dependencies (no shared node_modules) and gives the install ' +
    'command to run before building/testing. Pass the returned path as `cwd` when dispatching ' +
    'subagents into it.\n' +
    '- `keep` — lock the worktree (`git worktree lock`) so the sweep engine NEVER removes it, ' +
    'regardless of age or cleanliness. Use this to save a worktree holding work in progress that ' +
    'must survive across sessions. Provide a `reason` naming why.\n' +
    '- `release` — unlock a previously kept worktree, returning it to normal sweep lifecycle.\n' +
    '- `list` — dry-run sweep report: every afk-managed worktree with its verdict ' +
    '(active | empty | stale-clean | stale-dirty | locked | dead-owner | orphaned-*), owner, and age ' +
    'in days. `stale-dirty` also covers a tree that `git status` calls clean but which holds ' +
    'non-rebuildable ignored files (e.g. `.env`). Verdicts empty/dead-owner/orphaned-* are removal ' +
    'candidates on the next sweep.\n' +
    '- `remove` — remove a worktree checkout you no longer need (branch ref is always preserved). ' +
    'Refuses dirty trees, locked trees, trees with commits ahead of base, and trees holding ' +
    'non-rebuildable ignored files (e.g. `.env`) unless `force: true`. Never removes the main ' +
    'worktree or paths outside `.afk-worktrees/`.\n\n' +
    'Finishing with a worktree: a worktree is scaffolding, not an artifact — once its work has landed ' +
    'somewhere durable (pushed branch, open PR, merged commit), remove it in the same turn instead of ' +
    'leaving it for the sweep. Two cases differ:\n' +
    '- A worktree you created for a subagent, or one an `isolation: "worktree"` child left behind: ' +
    'after its commits are pushed, the branch ref holds the work, so the checkout is dead weight. If ' +
    'it was preserved with commits-ahead it is LOCKED, and a locked worktree is never reaped — call ' +
    '`release` first, then `remove` (remove refuses a locked tree, so the order is mandatory). ' +
    '`remove` also refuses a tree with commits ahead of base unless `force: true`; once the branch is ' +
    'pushed that force is safe for COMMITS specifically, because remove never deletes the branch ref ' +
    '— they stay on the branch and on the remote. `force` is NOT safe for local state, though: it also ' +
    'deletes untracked/ignored files (`.env`, a gitignored plan) that never made it into a commit, so ' +
    'confirm nothing irreplaceable is sitting there first — removal now refuses such a tree unless ' +
    'forced.\n' +
    '- The worktree you are RUNNING IN (your own cwd): never remove it mid-session. Deleting your own ' +
    'working directory strands every later tool call on a path that no longer exists. Session-end ' +
    'cleanup already removes it when the tree is clean — just tell the operator it will be reclaimed ' +
    'on exit, and name the branch holding the work.',
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'keep', 'release', 'list', 'remove'],
        description: 'The lifecycle operation to perform.',
      },
      name: {
        type: 'string',
        description:
          'create only: worktree slug (kebab-case; sanitized). Becomes `.afk-worktrees/<name>` and ' +
          'branch `afk/<name>` (prefix configurable via AFK_WORKTREE_BRANCH_PREFIX).',
      },
      base: {
        type: 'string',
        description: 'create only: git ref to base the new branch on. Default: HEAD.',
      },
      path: {
        type: 'string',
        description:
          'keep/release/remove: the worktree to operate on. Pass the slug from a prior `create` or ' +
          '`list` result (e.g. "my-worktree"), or the repo-relative `.afk-worktrees/<slug>` path returned by ' +
          'those actions. Do not pass absolute paths outside `.afk-worktrees/`.',
      },
      reason: {
        type: 'string',
        description: 'keep only: why this worktree must survive (stored as the git lock reason).',
      },
      force: {
        type: 'boolean',
        description:
          'remove only: also remove when dirty or with commits ahead of base. Default false. ' +
          'The branch ref is preserved either way.',
      },
    },
    required: ['action'],
  },
};

export const terminalFontSizeTool: AnthropicToolDef = {
  name: 'terminal_font_size',
  category: 'write',
  concurrencySafe: false,
  description:
    'Get or set the terminal font size in VS Code and Cursor settings. ' +
    'Use "action": "get" to read the current font size across all detected editors. ' +
    'Use "action": "set" with "size": <number> to update it (range: 6–60). ' +
    'Optionally filter to a single editor with "editor": "cursor" or "editor": "vscode". ' +
    'Writes are atomic (temp-file + rename) and safe to use while the editor is open. ' +
    'If the settings file contains comments (JSONC), the set action is aborted for that ' +
    'editor to avoid corrupting the file — use "get" to check, then edit manually if needed.',
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['get', 'set'],
        description:
          '"get" reads the current terminal.integrated.fontSize from each detected editor. ' +
          '"set" writes the supplied size value.',
      },
      size: {
        type: 'number',
        description:
          `Font size to set. Required when action is "set". Must be between 6 and 60.`,
      },
      editor: {
        type: 'string',
        description:
          'Optional: restrict to a single editor. ' +
          'Accepted values: "cursor", "vscode", "vscodeinsiders" (case-insensitive). ' +
          'Omit to apply to all detected editors.',
      },
    },
    required: ['action'],
  },
};

export const configGetTool: AnthropicToolDef = {
  name: 'config_get',
  category: 'read',
  concurrencySafe: true,
  description:
    "Read your own AFK configuration from ~/.afk/config/. Use target 'config' for afk.config.json " +
    "(behavioural settings: model, temperature, autoRouting, telegram.notify, …) or target 'env' for " +
    'afk.env (environment variables). Omit `key` to list everything; pass a dotted `key` ' +
    '(e.g. "telegram.notify.mode" for config, or "AFK_EFFORT" for env) to read one value. ' +
    'Secret values (API keys, tokens) are ALWAYS masked — you will see "set (****1234)" or "<unset>", ' +
    'never the raw credential. Read-only; safe in any phase.',
  input_schema: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        enum: ['env', 'config'],
        description: "'config' = afk.config.json settings; 'env' = afk.env environment variables.",
      },
      key: {
        type: 'string',
        description:
          'Optional. A dotted config path (e.g. "models.large", "telegram.notify.mode") or an env var ' +
          'name (e.g. "AFK_MODEL"). Omit to list all values for the target.',
      },
      all: {
        type: 'boolean',
        description:
          'env only: when true, list every known env var (not just those currently set). Default false.',
      },
    },
    required: ['target'],
  },
};

export const configSetTool: AnthropicToolDef = {
  name: 'config_set',
  category: 'write',
  concurrencySafe: false,
  description:
    'Edit your own AFK configuration in ~/.afk/config/ — persists for FUTURE sessions. ' +
    "Use target 'config' (afk.config.json) or 'env' (afk.env). action 'set' (default) writes `value`; " +
    "action 'unset' removes the key. You may set non-secret behavioural settings freely (e.g. model, " +
    'temperature, AFK_EFFORT, autoRouting.chat). You CANNOT set credentials (API keys, tokens) or ' +
    'human-gated control keys: system prompt (systemPrompt / AFK_SYSTEM_PROMPT), hooks, daemon task, ' +
    'API endpoints (*_BASE_URL), browser-domain policy, Telegram routing/allowlist, MCP/tier gates, ' +
    'and state-dir paths — those are refused with instructions for the human to run the `afk config` ' +
    'CLI. IMPORTANT: changes take effect on the next ' +
    'session/daemon restart; the CURRENT session is unchanged, so do not re-set a key expecting a live effect.',
  input_schema: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        enum: ['env', 'config'],
        description: "'config' = afk.config.json settings; 'env' = afk.env environment variables.",
      },
      action: {
        type: 'string',
        enum: ['set', 'unset'],
        description: "'set' (default) writes `value`; 'unset' removes the key.",
      },
      key: {
        type: 'string',
        description:
          'The dotted config path (e.g. "model", "telegram.notify.mode") or env var name (e.g. "AFK_EFFORT").',
      },
      value: {
        description:
          'Required for action "set". A string, number, or boolean (config keys also accept arrays where ' +
          'the schema expects one, e.g. telegram.notify.targets). Coerced to the key\'s declared type. ' +
          'Model-slot keys (models.local/small/medium/large) also accept a { id, provider, name } object; ' +
          'baseUrl/apiKey are human-gated — set them per-tier via the AFK_MODEL_<TIER>_BASE_URL / _API_KEY env vars, not here.',
      },
    },
    required: ['target', 'key'],
  },
};
