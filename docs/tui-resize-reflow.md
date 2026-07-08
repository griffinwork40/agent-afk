# TUI Resize Reflow — Root Causes, Fix Architecture, and Industry Context

_Added 2026-07-02. Companion to `docs/scrollback.md` (committed-band mechanics)
and `docs/tui-invariants.md` (externally-governed constraint catalog)._

## The incident

A live REPL session inside tmux (multiple clients of different sizes; several
pane resizes mid-stream) produced three symptom classes in scrollback:

1. **Ghost duplicates** — the same assistant paragraphs appeared up to 5×,
   each copy truncated at a *different* historical width.
2. **Mid-word truncation** — lines hard-cut without hyphenation at columns
   that matched no current geometry ("…already write subage", "(st").
3. **Silent content loss** — blocks cut mid-sentence whose completion never
   re-landed; one committed block vanished from screen *and* scrollback.

Forensic captures: `tmux capture-pane` of the affected pane showed content
formatted at ≥5 distinct widths (~165/125/106/85/64 cols), proving repaints
spanned several SIGWINCH events. Both root causes below were confirmed
empirically red-first in
`src/cli/terminal-compositor.resize-stale-width.repro.test.ts` (now converted
to green regression tests).

## Root cause 1 — stale-width verbatim repaint (ghosts + truncation)

`commitAbove` hard-wraps committed text to `stdout.columns` **once, at commit
time** (`terminal-compositor.committed-band-commit.ts`, `hardWrapToWidth`).
Every downstream paint site — `repositionCommittedBand`, the
`preserveRowsBeforeFrameRender` eviction paints — then CUP-painted those
retained rows **verbatim**, regardless of how many resizes had happened since.

A row wrapped at 160 cols painted into a 64-col terminal overruns the physical
width; DECAWM autowrap (on by default; the codebase never disabled it) then
hard-wraps it *again* at the hardware level, inserting **unaccounted phantom
rows**. Every subsequent CUP/erase computation is desynced from the
compositor's row model: erases miss rows, stale frames survive above the band,
and the next scroll absorbs them into native scrollback — once per repaint
cycle, at whatever width was current at the time.

**Invariant established: strings wrapped at width W are only valid at width W.**

## Root cause 2 — stale band geometry defeats the commit safety gate (loss)

The SIGWINCH-immediate handler (`terminal-compositor.lifecycle.ts`) calls
`logUpdate.resetGeometry()` — zeroing `CupFrameRenderer.previousTopRow` — but
deliberately left `committedBandTopRow`/`committedBandBottomRow` untouched. A
commit landing in the gap before the debounced repaint computed
`prevTopRow = max(0, committedBandBottomRow + 1)`: the stale floor reproduced
the **pre-resize** row number, kept `prevTopRow > 1`, and thereby defeated the
`prevTopRow <= 1` band-hold safety fallback (BLOCKER-1, `commit-mode.ts`).

Consequence (worse than the mispaint originally hypothesized):
`fitsAboveFrame` came out spuriously true and Phase-3 merge-then-cap truncated
the prior band as "already scrolled" rows that had never scrolled — **total
loss of committed content** with no scrollback copy ever made.

Historical note: commit `002bcd1` (PR #351) fixed a *different* trigger of the
same class (frame-height shrink at stable width). Its floor remains correct
for that case; the resize trigger needed its own invalidation.

## Fix architecture (landed 2026-07-02)

Module: `src/cli/terminal-compositor.band-reflow.ts`; wired through
`committed-band-commit.ts`, `frame.ts`, `committed-band-repin.ts`,
`frame-preserve.ts`, `lifecycle.ts`, `commit-mode.ts`, `reset.ts`.

**F1 — reflow-before-read.** `reflowCommittedBandToWidth(self, width)` re-wraps
the retained band at the *current* width before any consumer reads it, at both
band-read entry points: top of `commitAbove` (before merge/contiguity math)
and top of `repaint()` (before eviction paints and re-pin). The
pending/painted boundary (`committedBandPaintedRows`) is split-preserved
through the re-wrap — naive whole-array re-wrapping would desync it the moment
a row count changes. A `{band-ref, paintedRows, width}` memo makes steady-width
repaints a no-op. Mirrors the industry-standard reflow-from-model approach
(ratatui/Codex `insert_history` + reflow; see comparison below). Note the
band re-wraps its retained *rows* (already wrapped once at commit time), so a
narrowing resize splits correctly, while a widening resize keeps the earlier
wrap points — content-preserving and geometry-correct in both directions,
cosmetically identical to how tmux treats hard-wrapped lines.

**F1b — DECAWM bracket (defense-in-depth).** All physical band paints run
inside `withAutowrapDisabled()` (`?7l` … `?7h`, restore in `finally`). Reflow
guarantees fit *by our own measurement*; the bracket guarantees that a ±1
ambiguous-width disagreement (×, —, ╭ …) between `displayWidth()` and the
actual terminal can only **clip** a row, never spawn a phantom row.

**F2 — geometry-stale gate.** The resize-immediate handler now sets
`bandGeometryStale` alongside `resetGeometry()`. While stale,
`decideCommitMode` forces `fitsAboveFrame = false` (routing commits through
the same safe band-hold deferral BLOCKER-1 uses) and relaxes
`overflowPriorContiguous`'s exact-row match to the band's frame-adjacency
invariant (the row *numbers* are stale; the adjacency *fact* is not). The flag
clears only when `repositionCommittedBand` re-pins against real post-resize
geometry. Hard rule: **content preservation beats placement precision** — a
commit may land at a slightly conservative position during the stale window,
but committed content is never silently truncated.

**Regression tests** (`terminal-compositor.resize-stale-width.repro.test.ts`):
H1 narrow-resize reflow (no row wider than the new terminal), H2 commit-during-
stale-window (both blocks fully present), a multi-resize storm (160→100→64,
every marker present exactly once — the no-ghost assertion), and the 002bcd1
baseline re-derivation.

## Industry context (researched 2026-07-02)

| CLI | Screen mode | Scrollback strategy | On resize |
|---|---|---|---|
| Claude Code | main-screen inline | custom differential renderer (ex-Ink `<Static>`) | cursor-walk overshoots → known dup-frame spill (issues #46834, #60069) |
| Codex CLI (ratatui) | main-screen inline | `insert_history_lines` via DECSTBM scroll-region | **reflows scrollback from retained model** (PR #18575) |
| Gemini CLI (Ink) | main-screen inline | Ink `<Static>` commits at safe split points | multiple fixes; new isolated TerminalBuffer mode (#24512) |
| aider (rich.Live) | main-screen inline | stable/unstable-tail split, full re-render per tick | no structural fix; scrambles on resize (#457) |
| Ink core | main-screen inline | `<Static>` write-once + erase-N-lines dynamic region | reflow ghosting ruled **undetectable/unfixable** (#916) |

The load-bearing conclusion across all of them: **cursor-relative erase math is
unrecoverable once the terminal has reflowed under you.** The only sound
patterns are (a) making native scrollback authoritative via scroll-region
insertion, and (b) re-deriving painted rows from retained content at
paint-time width — never from previously wrapped strings. afk now does (b)
for the committed band; (a) remains the long-horizon direction if the band
model is ever replaced.

tmux specifics that shaped the fix: tmux reflows only *soft*-wrapped lines
(and only on the primary screen), so app-side hard wraps never rejoin on
widen; tmux never sends SIGWINCH itself (`TIOCSWINSZ` → kernel), and resizes
are debounced; multi-client `window-size latest` (default since 3.2) makes
mid-stream width flapping a normal condition, not an edge case.

## Follow-ups (deliberately out of scope here)

- `cup-frame-renderer.ts` reimplements `hardWrapToWidth` inline (~:40,:93) —
  consolidate on `wrap.ts`.
- Five independent home-grown ANSI-strip regexes exist (`display.ts`,
  `terminal-sanitize.ts`, `_lib/sanitize.ts`, `input/history.ts`,
  `input/suggest.ts`); consolidate.
- `stream-renderer-subagent.ts` width fallback is `?? 100` vs the canonical
  helper's `?? 80`.
- `docs/scrollback.md:108-111` still names the deepest gap: no end-to-end
  PTY test verifies actual scrollback contents. A real-PTY (or
  `@xterm/headless`-driven, real-timer) harness would catch the class this
  incident belongs to before release.
