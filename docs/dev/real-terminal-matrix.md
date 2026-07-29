# Real-terminal validation matrix (compositor)

The human-in-the-loop gate #540 requires before any compositor commit-path change
lands. It exists because **two prior fixes shipped headless-green and were broken
in reality** (`docs/scrollback.md`), and a third — #665 — shipped with
`test:pty 8/8` and still fragmented real scrollback the next day (#755).

Run every row. Green tests are not a substitute; that is the whole point of this file.

## Setup

Run in a **real terminal** — iTerm2, Apple Terminal, Ghostty, or xterm. The script
refuses a non-TTY (`exit 2`), so it cannot be piped, screen-scraped, or run from an
agent shell. `tmux` is a valid extra row but not a substitute: it reflows only
*soft*-wrapped lines and never sends SIGWINCH itself.

```bash
pnpm exec tsx scripts/visual-void-repro.ts <scenario>
```

Each scenario renders, holds so you can look and scroll up, then restores the
terminal. A/B every row against the base branch:

```bash
git checkout main   && pnpm exec tsx scripts/visual-void-repro.ts <scenario>   # BEFORE
git checkout <fix>  && pnpm exec tsx scripts/visual-void-repro.ts <scenario>   # AFTER
```

## Axis 1 — void class (contiguity)

| Scenario | Command | PASS |
|---|---|---|
| Long report + table | `visual-void-repro.ts long` | one contiguous block hugging the prompt; no blank void; every row exactly once incl. `HEADER-MARKER`; nothing stranded up top |
| Short report | `visual-void-repro.ts short` | as above, `HEADER-MARKER` + `PROSE-01` + `BODY-TAIL-ROW` all present once |
| Overlay grow → collapse | `visual-void-repro.ts grow-collapse` | `BODY-TAIL-ROW` committed after the growth is present; no void where the tall overlay was |
| Width change mid-turn | `visual-void-repro.ts resize` | band reflows, stays gap-free |

**Interactive rows (cannot be scripted — run `afk interactive` for real):**

| Check | PASS |
|---|---|
| Dropdown headroom | open the slash-command menu on a *fresh* session — the prompt must NOT jump |
| Picker | open a picker mid-session — no void, no double-paint |

## Axis 2 — reflow class (fragmentation) — needs your hands

**The `resize` row above does NOT cover this axis.** It fakes the resize:

```js
(stdout as unknown as { columns: number }).columns = Math.max(40, cols - 20);
stdout.emit('resize');
```

The real terminal never resizes, so it never reflows its own scrollback — and
terminal-owned reflow is the entire mechanism of the fragmentation bug. It also
only ever *narrows*, and it commits under a tall overlay, so it drives the
band-hold archive (already fixed by #665) rather than grow-eviction. Only a
**real OS window resize** exercises this axis.

| Scenario | Command | PASS |
|---|---|---|
| Grow-eviction → widen | `visual-void-repro.ts widen-evict` | see below |

Procedure: start the pane **narrow (48–70 cols)**, run it, and during the 45s hold
**drag the window wider** (or `cmd`-`-` to shrink the font — same effect). Then
scroll up:

- `LONGLINE-MARKER … END-OF-LONGLINE` — **PASS** it rejoined into one soft-wrapped
  paragraph. **FAIL** it is split across rows that break **mid-word**, with
  continuations at column 0.
- `CARD-BOTTOM` — **must still be present.** The previous attempt at converting
  eviction to logical archival dropped exactly that closing border on a growth
  eviction (`terminal-compositor.frame-preserve.ts:10-30`). This is the specific
  regression to watch, not a nice-to-have.
- No block appears twice, and no box borders are spliced at two different indents.

Also worth one manual pass in a real session, since it is the reported sequence:
let a turn finish with a Done card on screen, start another turn so the thinking
lane grows the frame, then widen the window and scroll up.

## Confirm which write site you actually drove

The failure that produced #755 was **aim**, not capability: every prior width-resize
guard drove the one already-fixed write site. Verify, do not assume — compositor
phase traces go to **stderr**, so redirect it and leave stdout (the visual output)
alone:

```bash
AFK_DEBUG_COMPOSITOR=1 pnpm exec tsx scripts/visual-void-repro.ts widen-evict 2>/tmp/comp.log
grep -E 'commitAbove:phase1|evict:enter' /tmp/comp.log
```

- `commitAbove:phase1` carries `fitsAboveFrame`, `bandOverflow`, `archiveCount`,
  `rawGenuineOverflow`, `maxBandModel`. **`archiveCount > 0` means you drove the
  band-hold archive** (the fixed path).
- `evict:enter { rows }` means you drove **grow-eviction** in `frame-preserve.ts`
  — the path that still emits physical rows.

A reflow-axis run that never logs `evict:enter` proved nothing about this axis.

## Recording the result

#540 requires the matrix be **documented in the PR**. Paste the table with a
per-row verdict, name the terminal(s) and the before/after commits, and state
which write sites the traces showed you hit.
