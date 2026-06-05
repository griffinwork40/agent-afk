# AFK Dark

Editor theme for Cursor & VS Code — companion to the agent-afk Ghostty terminal theme.

GitHub-Dark structural skeleton with the AFK warm-orange accent (`#E67E4C`) on cursor, focus borders, badges, the active activity-bar marker, and language constants. Slightly desaturated palette (matched 1:1 to the Ghostty theme so terminals and editor share an identity).

## Palette

| Role | Hex |
|------|-----|
| Background | `#0D1117` |
| Foreground | `#C9D1D9` |
| **AFK accent** (cursor, focus, badges, constants) | `#E67E4C` |
| Success / lime | `#A8E060` |
| Red / error | `#F85149` |
| Yellow / warning | `#E5C07B` |
| Blue / functions | `#5BA8FF` |
| Magenta / keywords | `#F08AC4` |
| Lavender / storage | `#9F7CE0` |
| Mint / types | `#5FE0C0` |
| Muted teal / regex / ops | `#56B5A8` |
| Olive / strings | `#9CB04A` |
| Muted / comments | `#484F58` |

Identical to `~/.config/ghostty/themes/agent-afk`.

## Install (local, no marketplace)

### Option A — symlink into the extensions dir (recommended, live reload)

```bash
# Cursor
ln -sfn "$PWD" ~/.cursor/extensions/agent-afk.agent-afk-theme-0.1.0

# VS Code
ln -sfn "$PWD" ~/.vscode/extensions/agent-afk.agent-afk-theme-0.1.0
```

Reload the editor (⌘⇧P → "Developer: Reload Window"), then **⌘K ⌘T → "AFK Dark"**.

Edits to `themes/agent-afk-color-theme.json` reload instantly on save without needing to re-package.

### Option B — package as VSIX and `code --install-extension`

```bash
npm i -g @vscode/vsce        # one-time
vsce package                  # produces agent-afk-theme-0.1.0.vsix
cursor --install-extension agent-afk-theme-0.1.0.vsix
# or
code --install-extension agent-afk-theme-0.1.0.vsix
```

### Option C — drop into settings.json (no install, overrides current theme inline)

If you'd rather not touch the extensions dir, paste the contents of
`themes/agent-afk-color-theme.json` into your `settings.json` under
`workbench.colorCustomizations` and `editor.tokenColorCustomizations.textMateRules`.
Loses semantic token colors and doesn't show in the theme picker, but works
without packaging.

## Iterating

Tweak `themes/agent-afk-color-theme.json` and save. With Option A above, the editor reloads the theme live — no reinstall needed. Use **⌘⇧P → "Developer: Inspect Editor Tokens and Scopes"** to find the scope of any token you want to recolor.

The full VS Code color reference: <https://code.visualstudio.com/api/references/theme-color>

## Notes on choices

- **Function parameters use the AFK orange.** This is a deliberate departure from GH-Dark (which leaves params at default fg) — it makes function signatures pop and ties syntax to brand. Disable by setting `variable.parameter` back to `#C9D1D9` in `tokenColors`.
- **`focusBorder` is the full orange.** GH-Dark uses blue. If it feels too loud on focused panels, drop to `#E67E4C99` (60% alpha).
- **Strings are olive (`#9CB04A`), not lime.** Lime (`#A8E060`) is reserved for additions / success / "fresh" signals (untracked files, diff insertions). Keeps strings calm.
- **Selection is neutral gray (`#363B45`), not orange-tint.** Translucent orange over green strings looks muddy; gray layers cleanly over everything.
