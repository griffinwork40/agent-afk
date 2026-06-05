# Specification: Readline-Style Keybindings + Multi-Line Ergonomics

**Type:** Feature
**Trigger:** User feedback — up/down arrows are no-ops with no dropdown; no cursor navigation within multi-line drafts; no cross-session history.
**Branch:** `feat/readline-keybindings`
**Worktree:** `.afk-worktrees/feat-readline-keybindings`

---

## Problem Statement

The `afk interactive` REPL prompt provides only left/right character movement, backspace, and Enter-to-submit. Up/down arrows exist **only** to navigate an open autocomplete dropdown — when no dropdown is open, they are silent no-ops. There is no way to move the cursor into a prior row of a multi-line draft. There is no session history persistence. This is the most common CLI/TUI ergonomics complaint, and it's addressable without introducing dependencies or touching the agent/turn/cleanup paths.

---

## What's Being Built

### A. POSIX readline emacs-mode bindings

| Binding | Action | Implementation note |
|---|---|---|
| `ctrl+a` | Line start (current logical line) | New `InputCore.moveLineStart` |
| `ctrl+e` | Line end (current logical line) | New `InputCore.moveLineEnd` |
| `ctrl+b` | Char backward | Alias of existing left-arrow handler |
| `ctrl+f` | Char forward | Alias of existing right-arrow handler |
| `ctrl+p` / ↑ | Up one visual row in draft; history-recall only at top of empty/unmodified buffer | New `InputCore.moveUpLine` (discriminated return) |
| `ctrl+n` / ↓ | Down one visual row; symmetric | New `InputCore.moveDownLine` (discriminated return) |
| `ctrl+k` | Kill to end of current line | Already wired — verify it's line-scoped, not buffer-scoped |
| `ctrl+u` | Kill to start of current line | Already wired — same verification |
| `ctrl+w` | Delete word backward | Wire existing `deleteWordBackward` |
| `alt+b` / `option+b` | Word backward | New `InputCore.moveWordBackward` |
| `alt+f` / `option+f` | Word forward | New `InputCore.moveWordForward` |
| `ctrl+l` | Clear screen, repaint draft | `clearScreen` + `cursorTo(0,0)` + `repaint()` |

### B. Multi-line ergonomics

- `shift+enter` and `alt+enter` insert `\n` without submitting.
- Detection via `key.shift === true` (Node readline) and `key.sequence === '\x1b[13;2u'` (kitty protocol) as fallback.
- Trailing-`\` continuation preserved exactly for backwards compatibility.

### C. History ring buffer — disk-persistent

- In-session ring of non-empty, non-slash submitted prompts.
- Stored at `~/.afk/state/repl-history.jsonl` — a new `getReplHistoryPath()` in `src/paths.ts`, matching the `getAfkStateDir()` → `sessions/`, `todos/`, `memory/` convention.
- Format: newline-delimited JSON objects `{ text: string, ts: number }`. Append-only until the 1 000-entry cap is exceeded; then compacted and rewritten.
- Load on REPL bootstrap; append on submit; skip malformed lines silently.
- Recall: only when draft is empty (or matches the last-recalled entry) and cursor is at the visual top row — exact bash behavior.

### D. `/keys` slash command

- Registered in `src/cli/slash/commands/keys.ts`, pulled in at the same site as `coreCommands`.
- Prints a formatted binding reference grouped by category: Navigation, Editing, History, Multi-line, Misc.
- Uses existing `palette` + `divider` conventions from `core.ts`.

---

## Architecture

**New pure operations in `InputCore`** (`src/cli/input-core.ts`):
- `moveLineStart(state)` → `InputCoreState` — uses existing private `lineStart` helper
- `moveLineEnd(state)` → `InputCoreState` — uses existing private `lineEnd` helper
- `moveWordBackward(state)` → `InputCoreState` — uses existing private `wordStartBefore`
- `moveWordForward(state)` → `InputCoreState` — uses existing private `wordEndAfter`
- `moveUpLine(state, terminalWidth, promptVisibleLen)` → `{ moved: true; state } | { moved: false }` — calls `visualCursorPos` (already exported from `echo.ts`) to find the current visual row/col, navigates to the same column on the row above
- `moveDownLine(state, terminalWidth, promptVisibleLen)` → discriminated union, symmetric

**New `src/cli/input/history.ts`:** `ReplHistory` class + `loadHistory()` factory. Async fire-and-forget disk writes; errors swallowed.

**`ReadWithAutocompleteOpts`** extended with `history?: ReplHistory` — optional so existing callers are unaffected.

**`reader.ts`** gets all new key handlers. Up/down disambiguation: (1) dropdown open → existing behavior; (2) `moveUpLine` moved → repaint; (3) `moveUpLine` didn't move + buffer empty/pristine → recall history.

**`repl-loop.ts`:** load history before the loop; pass to `readWithAutocomplete`; append on non-slash submit.

---

## Key Constraints

1. **Strict TypeScript** (`noUncheckedIndexedAccess`, `strict`). Discriminated returns for `moveUpLine`/`moveDownLine` — no optionals.
2. **`InputCore` stays pure.** Terminal width and prompt length injected by caller.
3. **One repaint per keypress** — existing `repaint()` / `schedulePaint()` pattern.
4. **History disk I/O is async and non-blocking.** Errors must never crash the REPL.
5. **JSONL resilience.** Loader skips malformed lines; partial writes are ignored.
6. **Ordered-operation invariant.** History loads at bootstrap, not inside turn/cleanup.
7. **Slash dispatcher preserved.** `/keys` is a normal `SlashCommand`; Levenshtein suggester and autocomplete pick it up automatically.
8. **Backwards compatibility.** Trailing-`\` continuation unchanged. `shift+enter`/`alt+enter` are additive.

---

## Files Touched

| File | Change |
|---|---|
| `src/paths.ts` | `getReplHistoryPath()` |
| `src/cli/input-core.ts` | 6 new pure operations |
| `src/cli/input-core.test.ts` | Tests for new ops, boundary cases |
| `src/cli/input/history.ts` | New — `ReplHistory`, `loadHistory()` |
| `src/cli/input/history.test.ts` | New — FIFO, disk roundtrip, dedup, bad-line resilience |
| `src/cli/input/types.ts` | `history?` field on opts |
| `src/cli/input/reader.ts` | All new bindings; up/down disambiguation |
| `src/cli/commands/interactive/repl-loop.ts` | Load/thread/append history |
| `src/cli/slash/commands/keys.ts` | New `/keys` command |
| `src/cli/slash/commands/keys.test.ts` | Registration + output shape |
| `src/cli/slash/builtin-skills.ts` (or `index.ts`) | Register `/keys` |

---

## Acceptance Criteria

1. With a 3-line draft (`"line1\nline2\nline3"`, cursor at end), ↑ moves to line 2, then line 1; one more ↑ at top of empty/unmodified buffer recalls history.
2. `ctrl+a` / `ctrl+e` move to start/end of *current* logical line in a multi-line draft.
3. `ctrl+k`, `ctrl+u`, `ctrl+w` modify draft and repaint.
4. `alt+b` / `alt+f` move by word.
5. `ctrl+l` clears screen and repaints current draft.
6. `shift+enter` / `alt+enter` insert newline; plain `enter` submits.
7. History persists across `afk interactive` invocations (disk roundtrip verified).
8. `/keys` renders a readable bindings reference; existing slash behavior unbroken.
9. All existing behaviors preserved.
10. Vitest coverage: new `InputCore` ops, `moveUpLine`/`moveDownLine` sentinel, up-arrow disambiguation, history FIFO + disk roundtrip, `/keys` registration + output shape.
11. `pnpm lint && pnpm test` clean.

---

## Implementation Notes (from research pass)

- **`ctrl+k` and `ctrl+u` are already wired** — but to `deleteToLineEnd` and `deleteToLineStart` which use the private `lineEnd`/`lineStart` helpers. Those helpers are already line-scoped (they find the nearest `\n`), so these bindings likely already behave correctly for multi-line buffers. The implementation pass should verify and add a test to confirm before wiring anything new.
- **`visualCursorPos` is the linchpin for `moveUpLine`/`moveDownLine`** — already exported from `echo.ts` and does the right row/col arithmetic. The new `InputCore` ops just need to import it and do a column-seeking scan.
- **The history path convention is clear** — `getAfkStateDir()` returns `~/.afk/state/`; `sessions/`, `todos/`, and `memory/` all live there. `repl-history.jsonl` is a natural peer.
- **`shift+enter` detection is the trickiest part** — Node's keypress events report `shift: true` on `return` in most terminals, but iTerm2 under certain profiles may require matching `key.sequence` directly. Detect both and document the known gap for exotic configs.
