# TUI UX Audit — quick-win candidates

Read-only audit of the interactive REPL across 5 dimensions (rendering, input,
feedback, errors, discoverability) via parallel subagents, then high-impact
claims verified directly. Branch: `afk/review-tui-ux-issues`. No code changed.

Confidence key: **[CONFIRMED]** = I read the code / ran a test. **[REPORTED]** =
subagent-found, plausible, not independently re-derived.

---

## Tier 1 — trivial fixes, high visibility (minutes each)

1. **[CONFIRMED] `/tasks` loading tip points to a command that doesn't exist.**
   `loading-tips.ts:51` tells users "find it later with /tasks" — the real
   command is `/bgsub` (`slash/commands/bgsub.ts`). Typing `/tasks` → "Unknown
   command (did you mean /stats?)". Dead-ends a core power feature. *Fix:* change
   tip text to `/bgsub`, or register `/tasks` as an alias.

2. **[CONFIRMED] GFM task-list checkboxes render as raw `[x]`.**
   marked v17 emits `{type:'checkbox', raw:'[x] '}`; the list renderer
   (`formatter.ts:214`) never inspects `item.task`/`item.checked`, and the
   `checkbox` token hits `default: return token.raw` (`formatter.ts:401`). A
   model checklist renders as `• [x] foo` instead of `☑ foo`. Models emit
   checklists constantly. *Fix:* handle `item.task` in the list case (render
   `☐`/`☑`) or add a `case 'checkbox'`.

3. **[CONFIRMED] Horizontal rule `---` is hardcoded to 40 columns.**
   `formatter.ts:276`: `palette.dim('─'.repeat(40))`. Looks stubby on wide
   terminals, wraps (corrupting row count) on narrow ones. `render/divider.ts`
   already does it right (`repeat(width)`). *Fix:* use terminal/content width.

4. **[CONFIRMED] Context-OVER warning uses unsafe `console.log`, races the overlay.**
   `turn-handler.ts:777` prints the *most severe* message ("model output may be
   silently truncated") via raw `console.log`, while every sibling line uses the
   compositor-safe `write`. The comment at line 755 explicitly warns this strands
   output above the live overlay → the warning can be invisible exactly when it
   matters. *Fix:* `console.log` → `write` (1 line).

5. **[CONFIRMED] Autocomplete dropdown height miscounts CJK/emoji width.**
   `terminal-compositor.render.ts:169` uses `stripAnsi(rowStr).length` (UTF-16
   code units) to count soft-wraps, but `cols` is display columns. `displayWidth`
   is already imported (line 12) but unused here. Wide-char candidates (CJK
   filenames via `@`, emoji) under-count → ghost/clipped dropdown rows. *Fix:*
   `displayWidth(stripAnsi(rowStr))`.

---

## Tier 2 — confirmed, slightly larger but still quick

6. **[CONFIRMED] Ctrl+D and Ctrl+L are silent no-ops in the live REPL.**
   The active compositor dispatch (`terminal-compositor.input-dispatch.ts`) binds
   c/v/p/n/a/e/w/u/k/b/arrows but has no `d` or `l`; line 882 swallows all other
   ctrl combos. Ctrl+D (EOF-to-exit on empty) and Ctrl+L (clear screen) are
   strong muscle-memory. The legacy `input/reader.ts` had both. *Fix:* add Ctrl+L
   → repaint, Ctrl+D → exit-on-empty / forward-delete.

7. **[CONFIRMED] Home/End jump to buffer start/end, not line start/end.**
   In multi-line input, `InputCore.moveHome` always goes to position 0
   (`input-core.ts:220`) though `moveLineStart` exists (line 233). Every editor
   does line-relative. *Fix:* route Home/End to `moveLineStart`/`moveLineEnd`.

8. **[CONFIRMED] Context-window visibility is stale + late for AFK users.**
   Status-bar context refresh is throttled to 15s (`turn-handler.ts:89`) and only
   on `tool_result`; color thresholds first react at 50%/80% (`context-bar.ts`).
   A user returning mid-turn can submit into a nearly-full window with no warning.
   *Fix:* shorten interval to ~3s and/or fire a one-time notice crossing 90%.

9. **[CONFIRMED] Elapsed clock hidden for first 5s.**
   `ELAPSED_GRACE_MS = 5_000` (`terminal-compositor.types.ts:66`) — 1–4s turns
   (the common case) show only a verb, no time signal. *Fix:* lower to ~2000ms.

---

## Tier 3 — reported (plausible, verify before fixing)

- **[REPORTED] Error messages aren't actionable.** `unknown`-kind fallback dumps
  raw `err.message` with `hint: undefined` (classifier ~165); `hook_blocked` names
  the event but not how to unblock; autosave-failure warning gives no fix path
  (`loop-iteration.ts:425`). *Fix:* add a generic hint + billing/doctor pointers.
- **[REPORTED] `@file` token not matched when followed by punctuation** (`,`/`.`)
  — `at-file-inject.ts:75` lookahead is `(?=\s|$)`; silent non-injection.
- **[REPORTED] Inline `image`/`br` tokens render raw** (same `default: token.raw`
  path in `renderInlineTokens`). Lower frequency in a terminal.
- **[REPORTED] Multi-paragraph blockquote splits into two boxes** at interior
  blank line (`markdown-stream-format.ts` `findBlockBoundary` has no blockquote
  guard).
- **[REPORTED] `formatPendingBuffer` double-wraps** the streaming overlay
  (`markdown-stream-format.ts:58-61`) — transient flicker only.
- **[REPORTED] Paste-placeholder atomic delete only at token boundary** — cursor
  inside `[Pasted text …]` → char-by-char backspace.
- **[REPORTED] No feedback at history boundary** (repeated ↑ at oldest entry).
- **[REPORTED] ↑ on type-ahead queue is LIFO** (`pop()`); may be intentional
  (undo mental model) — verify intent.

## Discoverability polish (cheap, batchable)
- `/help` never mentions `/keys`, `@`-file, `!cmd`, or Shift+Tab.
- Welcome-banner hint omits `@`-file and Shift+Tab.
- `/bgsub*`, `/worktree`, `/changelog`, `/stats`, `/allow-dir`, `/keys` lack a
  `hint:` → never surface as loading tips.
- Inventory: EXIST — /help /clear /compact /model /mcp /exit /quit /cost /resume
  /history /keys. MISSING — /undo, /tasks (tip references it).

## Not a bug (taste)
- Spinner verbs are an intentional detective/noir theme ("Stalking", "Tailing",
  "Wiretapping" — `constants.ts:5`). Only substantive note: the verb carries no
  info about the active operation; could append the live tool name when known.

## Not checked
Non-TTY/capture-mode feedback; Telegram surface; mouse/IME; Ctrl+Z suspend;
MCP connection-error surfacing; daemon error propagation; palette contrast in
non-256-color terminals; full SIGWINCH repaint timing beyond committed tests.

---

# `/simplify` targets (complexity / duplication / dead code)

Scoping probe over `src/cli` (~51k LOC non-test). No dead-code tooling
(knip/ts-prune) is configured — adding one is itself a durable win.

## A. Input layer — two parallel input stacks, manually kept in sync (HIGH value)
The live REPL runs **two** input implementations: the between-turn reader
(`input/reader.ts` 900 LOC → `input-box.ts`/`readWithAutocomplete`) and the
persistent compositor (`terminal-compositor.input-dispatch.ts` 897 LOC). The
compositor is a hand-maintained PORT of the reader — 10+ self-documented sync
points:
- `input-dispatch.ts:202` "Ported from reader.ts:380-430"
- `input-dispatch.ts:355` "Ported from reader.ts:464-479"
- `input-dispatch.ts:481` "Ported from reader.ts:697-732"
- `input-dispatch.ts:523` "Mirrors reader.ts:734-748"
- `input-dispatch.ts:635` "Mirrors reader.ts:677"
- `input-dispatch.ts:663` "Ported from reader.ts:668"
- `input-dispatch.ts:844` "matches reader.ts:769-772"
- `input-surface.ts:251` "**parity bug** vs. reader.ts:329-330"
- `input-surface.ts:452,460` more "same constraint / mirrors reader.ts"

This manual mirroring is the root cause of the audit's divergence findings
(Ctrl+D/Ctrl+L exist in reader.ts but not the compositor; Home/End drift).
*Target:* `/simplify` clone + wrong-abstraction lenses over `src/cli/input/` +
`reader.ts` + `input-box.ts` + `multi-line-reader.ts` +
`terminal-compositor.input-dispatch.ts` + `terminal-compositor.autocomplete.ts`.
Acting on the plan is a `/refactor` (both paths live; well-tested → verifiable).
Effort: medium–large. **Highest leverage in the TUI.**

## B. Mechanical dead code (knip, 100s run) — LOW effort, immediate
- **`src/cli/interactive.ts` (273 LOC) is dead** — old readline REPL importing
  `Anthropic` directly; nothing imports it (live entry is
  `commands/interactive.ts` via `index.ts:51`). Clean deletion (+ its test).
- **24 unused files** flagged (e.g. `utils/CircularBuffer.ts`, `utils/envUtils.ts`,
  `utils/json.ts`, `utils/memoize.ts`, `telemetry/schemas.ts`, `web/index.ts`,
  `telegram/example.ts`, `agent/facets/index.ts`). Verify each (some may be
  entry/barrel false positives) then prune.
- **84 unused exports** (60 in `src/cli`) — mix of real dead exports + barrel
  re-exports; needs case-by-case triage.
- **Dead devDeps: `jest`, `ts-jest`, `memfs`** (repo is vitest; grep hits are
  runner-*detection* code, not usage). `tsx` is a false positive (used by
  `pnpm dev`). Removing the 3 is safe.
- *Meta-win:* wire `knip` into CI so this doesn't re-accumulate.

## C. Skip for `/simplify` (deliberate, test-locked → low ROI / high risk)
- `terminal-compositor.*` — 13 files / 4101 LOC + **20 test files**. Fragmentation
  is intentional (each edge case isolated); behavior is locked by tests.
- `tool-lane*` — 10 files / 3255 LOC, same story.
Touching these risks regressions for cosmetic LOC reduction.
