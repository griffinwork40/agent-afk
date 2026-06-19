# Default permission mode → bypass (for new installs, changeable, sticky)

## Goal
Make `bypassPermissions` the default permission mode for the human-driven CLI
surfaces. A fresh install (no `permissionMode` in `afk.config.json`) runs
`afk chat` / `afk interactive` in bypass — path containment + the path-approval
prompt are off — and stays that way every session until the operator changes it.
Keep it changeable everywhere it already is, and add a sanctioned config-set path.

## History that constrains this
`git` comments reference "the default flip in C2 (from 'bypassPermissions' to
'default')" — bypass *was* the session-layer default and was deliberately
flipped to `'default'` for safety. The daemon (`scheduler.ts:442`) and Telegram
(`telegram.ts:348,391`) explicitly depend on the post-C2 `'default'`
session-layer fallback. So the re-flip must NOT touch the deep session layer —
only the CLI config-resolution layer.

## Layered default model (precise)
- `afk chat`, `afk interactive` (REPL): **bypassPermissions** (NEW) — both read
  `loadConfig().permissionMode`.
- Telegram: **default** (unchanged) — omits `permissionMode`; hook-enforced.
- Daemon: **bypassPermissions** (unchanged) — set explicitly.
- Library `new AgentSession(...)` + subagents inheriting nothing: **default**
  (unchanged) — deep `?? 'default'` fallback in `session-setup.ts:48`.

## Changes
1. `src/cli/config.ts`
   - Add `export const DEFAULT_CLI_PERMISSION_MODE: PermissionMode = 'bypassPermissions'`.
   - `loadConfig()` merge: `permissionMode: merged.permissionMode ?? DEFAULT_CLI_PERMISSION_MODE`
     (was a conditional spread that left it undefined).
   - Add `export function resolveCliPermissionMode()` — reads
     `loadJsonConfig().config.permissionMode ?? DEFAULT_CLI_PERMISSION_MODE`
     (no throw risk; for display surfaces).
2. `src/config/settable-keys.ts` — add `permissionMode` to `CONFIG_KEY_SPECS`
   (tier `human`, type `enum`: default|plan|autonomous|bypassPermissions). Human-tier
   ⇒ `afk config set` works; the `config_set` agent tool is refused (no self-escalation).
3. Honest displays (drop hardcoded bypass-on; read resolved mode):
   - `src/cli/commands/status.ts` (JSON `bypass` + `permissionMode`; text panel).
   - `src/cli/commands/config-command.ts` (JSON `bypass` + `permissionMode`; text line).
   - `src/cli/slash/commands/config-doctor.ts` (`bypass perms` line).
4. Help/docs accuracy: `chat.ts` + `interactive.ts` flag help; README.md
   "A note on permissions"; docs/architecture.md "Bypass permissions"; docs/reference.md.
5. Tests: config default + override; permissionMode settable-key tier/validation;
   display reflects mode.

## Verification
`pnpm lint` clean; `pnpm test` green (only the 2 known pre-existing env fails).
