# AFK Dark — Terax theme

Terax custom theme ported 1:1 from `themes/cursor/themes/agent-afk-color-theme.json`
(the AFK Dark Cursor/VS Code theme) and its companion Ghostty palette. Same
background (`#0D1117`), foreground (`#C9D1D9`), and AFK orange accent
(`#E67E4C`) across the app UI, sidebar, and terminal ANSI palette.

## File

- `afk-dark.terax-theme` — a Terax custom theme file (JSON), ready to import.

## Schema verification (no guessing)

Verified directly against the Terax source (`crynta/terax-ai`, `main` branch)
rather than assumed:

- **Theme shape** — `src/modules/theme/types.ts`: `Theme { id, name, author?,
  description?, variants: { light?, dark? }, editorTheme?: { light?, dark? } }`,
  each variant has `colors: ThemeColors` (shadcn-style tokens: background,
  foreground, card, popover, primary, secondary, muted, accent, destructive,
  border, input, ring, sidebar*, radius) and `terminal: TerminalPalette`
  (background, foreground, cursor, cursorAccent, selection, `ansi[16]`).
- **Validator** — `src/modules/theme/validateTheme.ts`: enforces `id` matches
  `^[a-z0-9][a-z0-9-]{1,63}$`, rejects unknown color keys, requires `ansi` to
  be exactly 16 strings. `afk-dark.terax-theme` was checked against these
  exact rules programmatically (id regex, color-key allowlist, ansi length)
  — all pass.
- **File format / extension** — `src/modules/theme/themeFiles.ts`:
  `THEME_FILE_EXT = ".terax-theme"`, `writeThemeFile()` serializes the same
  `Theme` object as pretty JSON. The shipped file matches this exactly.
- **Storage location (app-wide)** — `themeFilePath()` resolves to
  `join(await appConfigDir(), "themes", "<id>.terax-theme")`. Per the Tauri v2
  path API (`configDir()` macOS → `$HOME/Library/Application Support`,
  `appConfigDir()` → `${configDir}/${bundleIdentifier}`) and the bundle id
  `app.crynta.terax` (confirmed in `TERAX.md`), this resolves on macOS to:
  `~/Library/Application Support/app.crynta.terax/themes/afk-dark.terax-theme`.
- **Custom-theme registry (what the picker actually reads)** —
  `src/modules/theme/customThemes.ts`: a `tauri-plugin-store` `LazyStore` at
  `terax-custom-themes.json` (i.e.
  `~/Library/Application Support/app.crynta.terax/terax-custom-themes.json`),
  under key `"themes"` → `Theme[]`.
- **Active-theme selector** — `src/modules/settings/store.ts`:
  `terax-settings.json`, key `"themeId"` (`KEY_THEME_ID`), a plain string
  equal to the theme's `id`.
- **Editor syntax highlighting is a separate, fixed-enum system** —
  `src/modules/settings/store.ts` `EDITOR_THEMES` is a closed list of 22
  bundled CodeMirror themes (Kanagawa, Tokyo Night, Catppuccin, Rosé Pine,
  Everforest, Dracula, Solarized, Nord, Gruvbox, Atom One, Aura, Copilot,
  GitHub Dark/Light, Xcode Dark/Light). **Terax's custom-theme JSON has no
  field for arbitrary token/scope colors** — `editorTheme.dark`/`.light` only
  *selects* one of these fixed ids (`resolveEditorTheme.ts` falls back to
  `atomone` if the string isn't a recognized id). We selected **`github-dark`**
  as the closest built-in match: its bundled defaults
  (`@uiw/codemirror-theme-github`) use `background: '#0d1117'`,
  `foreground: '#c9d1d9'` — identical to AFK Dark's editor background/
  foreground. This is a real limitation, not an oversight: full syntax-token
  parity with the Cursor/VS Code AFK Dark theme (custom scopes for keywords,
  types, JSX, etc.) is not achievable in Terax today.

## Import (safe, in-app — recommended)

1. Open Terax → Settings → **Themes**.
2. Click **"Import .terax-theme"** (or drag the file onto the Theme section).
3. Select `themes/terax/afk-dark.terax-theme` from this worktree.
4. Terax auto-selects the imported theme immediately
   (`ThemesSection.tsx`: `saveCustomTheme(theme); setThemeId(theme.id)`).
5. Optional: Settings → Themes → "Editor theme" → pick **GitHub Dark**
   explicitly, or leave on "Auto" — the theme's `editorTheme.dark: "github-dark"`
   pairing makes Auto resolve to GitHub Dark whenever AFK Dark is active.

## Not performed by this task

Writing directly into
`~/Library/Application Support/app.crynta.terax/terax-custom-themes.json`
and `terax-settings.json` was **not** done, for two reasons:
1. This subagent's file tools are sandboxed to the two repo roots (the
   worktree and the main `agent-afk` checkout) — reads/writes to
   `~/Library/Application Support/...` were rejected outright
   (`outside the allowed read/write roots`), independent of the schema
   verification above.
2. Terax was observed running during this session (live process). Hand-editing
   its `tauri-plugin-store` JSON files while the app holds them open risks a
   lost write if the app's own 200ms auto-save debounce (`autoSave: 200` in
   both stores) flushes its in-memory cache back over an external edit.

The in-app Import flow above avoids both problems and is the shipped,
supported mechanism for exactly this use case.
