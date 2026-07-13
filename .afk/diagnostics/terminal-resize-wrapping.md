# Diagnosis: "text wrapping gets wonky when the terminal resizes"

_Session 2026-07-10. Investigated via `/diagnose` (its verifier fan-out timed out;
validation redone by hand from source + git + build state)._

## Answer (root cause of the bug class)

The symptom is the **soft-wrap ↔ hard-wrap-at-paint desync** on unbreakable tokens.
When a rendered line contains a token wider than the content width with no break
opportunity — a bare **file path, URL, or long inline-code identifier** (which afk
prints constantly) — a *soft* word-wrap (`wrapToWidth(hard:false)`) leaves that token
overflowing past the right edge. The terminal's own autowrap (DECAWM) then hard-wraps
it **again at the hardware level**, inserting phantom rows the compositor never counted.
Every subsequent cursor-addressed (CUP) erase/repaint is one row off, and on **resize**
the reflow re-splits the stored over-wide line at a *different* width — the visible
"all wonky" wrapping.

This is documented in the codebase verbatim as **"the persistent-wrap / fucky-on-resize
bug"** (commit `227a99e`, PR #470, `src/cli/markdown-stream-format.ts` comments).

## Status on your build: already fixed at every interactive surface

You are running `agent-afk@5.25.11` (`/opt/homebrew/bin/afk`), and `dist/` (built
2026-07-10 09:08) contains the fix. Three independent layers now protect against this
class:

| Layer | Mechanism | Where | Landed |
|---|---|---|---|
| 1. Source formatting | `breakLongWords: true` at the 3 assistant-stream sinks (`renderTextBlock`, `formatPendingBuffer`, `formatBlockForCommit`) | `src/cli/markdown-stream-format.ts:34,70,110` | #470, 2026-07-07 |
| 2. Overlay emission | `clampLineToTerminal` → `truncateDisplayWidth` clamps every tool-lane / subagent overlay line to *current* width, per frame (~30 sites) | `src/cli/commands/interactive/tool-lane-render*.ts` | — |
| 3. Committed scrollback | `hardWrapToWidth` breaks long tokens at commit **and** re-wraps the retained band at paint-time width on resize | `terminal-compositor.committed-band-commit.ts:162`, `terminal-compositor.band-reflow.ts:73` | #386, 2026-07-02 |

Verification done this session:
- `#470` is an ancestor of `HEAD` (15 commits back) and present in the built `dist/`.
- Full test suite green: **597 files / 11172 tests, 0 failures**, incl. both resize
  regression suites (`terminal-compositor.resize-stale-width.repro.test.ts`,
  `terminal-compositor.resize-ghost.test.ts`).
- No commit *after* #470 touched `wrap.ts` / `markdown-stream*` / `terminal-compositor*`
  / `tool-lane*` / `stream-renderer*` — the wrap machinery is at its most-fixed state.

Hypotheses the `/diagnose` run raised, and their disposition:
- **h2** (committed-band verbatim-repaint) → **ruled out**, fix #386 present.
- **h1** (tool-lane / subagent rows bake in width, never re-run bracket-aware) →
  **refuted**: `tool-lane.ts:331` reads `getTerminalWidth()` fresh per frame; the
  subagent stream subscribes to `ResizeBus` (`stream-renderer-lifecycle.ts:168`); the
  `?? 100` fallbacks only bite on a non-TTY (undefined columns), not on resize.
- **h3** (unguarded `wrapToWidth` sites) → **this was the real class**, and #470 fixed
  the primary sinks. Remaining unguarded sites are either self-truncating box
  components (`card.ts:158-179`) or the **non-TTY-only** `formatSubagentTextLines`
  (`emitSubagentTextLines` early-returns on TTY, `stream-renderer-subagent-helpers.ts:72`)
  — neither is a live-resize exposure.
- **h4** (native scrollback beyond the tracked band can't reflow) → **the only thing
  that can still look wonky on your build** (see below).

## What you are most likely still seeing

Because the live/current rendering is fixed, a "wonky on resize" today is almost
certainly **already-emitted history**, not new output:

1. **Native-scrollback architectural limit (h4).** Content that has scrolled *past* the
   compositor's tracked committed-band window into the terminal's own scrollback can
   never be reflowed — this is inherent to the cursor-relative paint model (no DECSTBM
   scroll-region insertion). It matches how **tmux** treats hard-wrapped lines (only
   soft-wrapped lines reflow, primary screen only). Documented as a known limitation and
   the long-horizon direction in `docs/tui-resize-reflow.md:115-121, 129-141`.

2. **Frozen pre-update render.** If you updated to 5.25.11 recently, any output painted
   by the *older* binary (before #470, 2026-07-07) is frozen in scrollback at its old
   width; resizing cannot retroactively fix it. A fresh session renders clean.

### Self-check (distinguishes fixable bug from known limitation)

Resize the window, then look at **newly streamed output** (ask the agent something so
fresh text prints *after* the resize):
- **New output wraps correctly** → you are seeing (1) or (2): old history that the app
  cannot retroactively reflow. Expected, matches tmux; not a code defect. Start a fresh
  session for clean history.
- **New output *also* wraps wrong** → a genuine residual defect not covered above.
  Capture `tmux capture-pane -p` (or a screenshot) of the broken region + your terminal
  emulator + `$COLUMNS`, and reopen — that gives a reproducible surface to fix.

## Recommendation

No code change is warranted right now: the interactive TTY path is fixed and green, and
every suspected residual is ruled out. The remaining cause is the documented scrollback
architectural limit. If the self-check shows *new* output wrapping wrong, that's a fresh
bug — capture the artifacts above and it becomes fixable.
