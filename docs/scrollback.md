# Scrollback push mechanics

How `TerminalCompositor.commitAbove(text)` actually pushes a line into the
terminal's scrollback buffer while the persistent compositor holds a live UI
pinned at the bottom of the screen.

This is the single hardest-to-debug mechanism in the TUI because:

- Mock-stdout unit tests can verify bytes were *written* but cannot verify
  they actually *reached scrollback* — that's a property of the real PTY's
  scroll engine, not of our code.
- Multiple prior fixes (6d7cb90, 9690b9f) were validated on byte-level tests
  that passed even though the real-terminal behavior was broken.
- The mismatch between VT100 sub-region and full-screen DECSTBM scroll
  semantics is subtle and counter-intuitive.

If you change anything in `commitAbove`, `CupFrameRenderer.clear()`, or
`StatusLine.withFullScrollRegion`, read this doc end-to-end first.

## The external constraint

VT100 / xterm semantics for LF (`\n`):

> "LF moves the cursor down one line. If the cursor was already on the last
> line of the scrolling region, the screen scrolls up by one line."

Two things follow:

1. **The scroll triggers iff the cursor is AT the bottom margin** when the
   LF is processed — not when LF would move it past the bottom.
2. **The bottom margin is determined by the active DECSTBM region**, which
   can be either the full screen `(1, rows)` or a sub-region `(top, bottom)`.

Pushing a line into the **terminal's scrollback buffer** requires a *full-screen*
scroll. Scrolls within a sub-region displace content out of the sub-region
but the displaced lines are **discarded** — they do not enter scrollback.

## The agent-afk layout

```
row 1                       ← top of screen
  ...                        (rising content area — gets scrolled to scrollback)
row newTopRow             ← top of live frame (overlay + spinner + tip + input)
  ...
row rows-1                ← bottom of live frame (input prompt)
row rows                  ← status line (reserved)
```

`StatusLine` normally arms DECSTBM at `(1, rows-1)` to reserve row `rows`
for the status line. Without this, normal scrolling would shift the status
line up out of position.

## What `commitAbove(text)` must do

1. Erase the live frame (so the scroll has no visual interference).
2. Temporarily switch DECSTBM to **full-screen** `(1, rows)` so the next LF
   can trigger a scrollback-pushing scroll.
3. Position cursor at row `rows` (the full-screen bottom margin).
4. Write `text + '\n'`. The LF fires AT the bottom margin → full-screen
   scroll → row 1 → terminal scrollback. All rows shift up by 1.
5. Restore DECSTBM to the sub-region `(1, rows-1)`.
6. Repaint the status line at row `rows` (it was just blanked by the scroll).
7. Repaint the live frame at the original `newTopRow..rows-1`.

`withFullScrollRegion` (status-line.ts) implements steps 2 and 5–6. Step 1
is `logUpdate.clear()`. Step 4 is `stdout.write(text + '\n')`. Step 3 is the
load-bearing detail that's been silently wrong twice.

## The two prior failures

### 6d7cb90 (May 26) — the log-update purge

Before this commit, the persistent compositor used `log-update`, which
appends `\n` to every rendered frame. That trailing LF, fired with cursor at
the sub-region bottom margin, was triggering **unwanted** scrolls on every
overlay repaint — the compositor visibly drifted upward.

Fix: replaced `log-update` with `CupFrameRenderer`, which positions every
frame line via absolute CUP escapes and emits no LFs for line transitions.
This stopped the drift.

Side effect: the path that previously *also* pushed legitimate scrollback
commits (when the LF happened to land at the right row) stopped working —
because no more LFs were being emitted anywhere.

`commitAbove` then took over as the only path that emits a deliberate LF.
But cursor positioning was inherited from `clear()`'s `previousTopRow`
park, which for multi-line frames sat mid-screen. The LF at mid-screen
didn't trigger any scroll.

### 9690b9f (May 27) — the rows-1 misdirection

Fix attempt: park `clear()` cursor at `rows-1` ("the DECSTBM bottom anchor")
so that the subsequent `commitAbove` write would have its LF land at the
bottom margin.

**This was wrong.** `rows-1` is the bottom anchor of the sub-region
`(1, rows-1)`, but `commitAbove` runs inside `withFullScrollRegion` which
temporarily switches DECSTBM to **full-screen** `(1, rows)`. The full-screen
bottom margin is `rows`, NOT `rows-1`.

So the LF still fired one row above the active bottom margin → still no
scroll → still nothing in scrollback. The byte-level test verified
`clear()` parked at row 23 (rows-1) of a 24-row terminal, which it did —
but that's irrelevant to whether the LF triggers a scroll under the
full-screen DECSTBM that `withFullScrollRegion` installs.

The fix passed CI and shipped because **no test verifies actual scrollback
contents end-to-end on a real PTY.** The only ground truth is running
agent-afk in iTerm2 / Apple Terminal / xterm and visually scrolling up to
see what's there.

### CUP-to-rows: makes the scroll fire, but pushes the WRONG row

A first attempt at the fix: position the cursor at row `rows`, then
`text + '\n'`:

```ts
writeWithGuard(() => {
  const rows = (this.stdout.rows ?? 24);
  this.stdout.write(`\x1b[${Math.max(1, rows)};1H${text}\n`);
});
```

This DID make the scroll fire — the LF at row `rows` triggers a full-screen
scroll, pushing row 1 to scrollback. But row 1 contains the *banner top*
or *blank space*, NOT our text. Our text was at row `rows`, scrolls up to
`rows-1`, and is immediately overwritten by the live frame's bottom row
(input prompt) on the next `repaint()`.

So the scroll fires, scrollback gains a row, but the user never sees the
committed text in scrollback — only banner-residue and blanks.

### CUP-to-1 + multi-LF: gets text into scrollback, but no visible accumulation

A subsequent attempt: write the text at row 1 (where it WILL be the row
that gets displaced by scrolls), then issue one LF per line of text at
row `rows`:

```ts
writeWithGuard(() => {
  this.stdout.write(`\x1b[1;1H${stripped}\x1b[${rows};1H${scrolls}`);
});
```

This pushes the text into the terminal's scrollback buffer correctly (the
LF at row `rows` triggers a full-screen scroll, displacing the row containing
our text). But the text only appears AFTER the user scrolls up in the
terminal — it's never visible in the live viewport above the live frame.

Worse: each commit clears the live frame, scrolls 1 row to scrollback,
and the cleared-frame area shifts up as N blank rows. Over many commits,
those blank rows accumulate as a growing gap between older content (banner
at top) and the live frame at the bottom.

### The current fix: scrollback push (phase 1) + visible above-frame write (phase 3)

`commitAbove` now does THREE phases:

```ts
this.committing = true;
try {
  this.logUpdate.clear();
  // Phase 1: push text into scrollback.
  writeWithGuard(() => {
    this.stdout.write(`\x1b[1;1H${stripped}\x1b[${rows};1H${scrolls}`);
  });
} finally {
  this.committing = false;
}
// Phase 2: repaint the live frame at its normal position.
this.repaint();
// Phase 3: ALSO write the text just above the new live frame for
// visible accumulation.
const newTopRow = this.logUpdate.topRow ?? 0;
if (newTopRow > 1) {
  const textStartRow = Math.max(1, newTopRow - lineCount);
  let out = '';
  for (let i = 0; i < textLines.length; i++) {
    const row = textStartRow + i;
    if (row >= newTopRow) break;
    out += `\x1b[${row};1H\x1b[2K${textLines[i] ?? ''}`;
  }
  if (out.length > 0) {
    writeWithGuard(() => { this.stdout.write(out); });
  }
}
```

Mechanics:

**Phase 1 — scrollback push:**
1. CUP to (1, 1).
2. Write text at row 1.
3. CUP to (`rows`, 1) — bottom margin under full-screen DECSTBM.
4. Emit `\n` × lineCount. Each LF at the bottom margin triggers one
   full-screen scroll. After N scrolls, all N lines of text have been
   displaced into the terminal's scrollback buffer.

**Phase 2 — repaint:** the live frame paints at its normal
`newTopRow..rows-1` position. The renderer (CupFrameRenderer) handles
erase + paint via absolute CUP positioning; no scrolls fire here.

**Phase 3 — visible above-frame write:** after phase 2 lands the new
frame, `topRow` (a getter on CupFrameRenderer) reveals where the new
frame starts. We write the committed text at rows `newTopRow -
lineCount..newTopRow - 1` — immediately above the live frame. Each line
gets its own CUP positioning so they start at column 1 regardless of
whether the terminal driver expands LF to CR+LF.

The text now appears in TWO places:
- Terminal scrollback (from phase 1) — accessible by scrolling up.
- Just above the live frame (from phase 3) — visible without scrolling.

The two copies serve different roles: scrollback is the authoritative
archive (never lost, even if the visible copy gets overwritten by a
frame grow event); the above-frame copy is the UX bonus that lets users
see recent commits without scrolling.

`clear()` is left parking at `rows-1` because other callers depend on
that for sub-region-scoped operations (disarm path, mid-resize redraws,
spinner stop). `commitAbove` is the only path that uses the three-phase
scroll+repaint+visible-write sequence, so the orchestration is scoped
there.

### What ends up where after a commit

Visible screen after a single `commitAbove("X")`:

- Row `newTopRow - 1`: "X" — newly written by phase 3.
- Rows above: previous content (banner, prior commits, blanks) shifted
  up by 1 from phase 1's scroll.
- Rows `newTopRow..rows-1`: live frame (repainted by phase 2).
- Row `rows`: status line.

In scrollback (accessible by scrolling up in the terminal):
- "X" — newly added by phase 1's scroll.
- Older committed text from prior turns — pushed there by earlier
  commits' phase-1 scrolls.

Over many commits, the visible above-frame area fills with recent
committed text (newest just above the frame, older above that). Even
older content scrolls off the top of the viewport into terminal
scrollback. The banner reaches row 1 and exits to scrollback after
enough commits.

### Fixed: shrink gap (committed-band re-pin)

**Symptom.** When the overlay shrinks (e.g., a streaming/tool overlay ends and
the frame collapses to just a thinking spinner + input), `setOverlay` triggers a
`repaint` with a smaller line count. `CupFrameRenderer.render()` erases the OLD
frame's rows and paints the new (short) frame at `newTopRow..rows-1`. The phase-3
committed text written by an EARLIER `commitAbove` sits ABOVE the old (tall)
frame top — outside the renderer's erase footprint — so it is left stranded at
its old high rows while the frame re-anchors to the bottom. The blank rows
between them are the visible "weird gap in scrollback" users reported. This was a
residual of PR #557 (which let the frame visually shrink in the first place).

**Why the existing guards missed it.** `CupFrameRenderer.clear()`/`render()`
only ever erase the frame's own footprint, never rows above `previousTopRow`.
`preserveRowsBeforeFrameRender`'s evict-on-growth only fires when the frame grows
UPWARD (`growthDeficit = max(0, prevTopRow - desiredTopRow)`); on a shrink the
top moves DOWN, the deficit is 0, and nothing repositions the stranded text.

**The fix (committed-band re-pin).** `TerminalCompositor` retains the most-recent
above-frame committed block and the rows it occupies (`committedBand`,
`committedBandTopRow/BottomRow`, set by Phase 3). After every `repaint()`,
`repositionCommittedBand()` re-pins that block so its bottom line stays
immediately above the frame's true top (`desiredTopRow - 1`): it erases the rows
the block vacated and repaints it adjacent to the collapsed frame. It fires only
when the frame stayed put or shrank (never paints into a frame that grew up over
it), and is idempotent on a stable frame (no per-tick churn). When an intervening
growth-evict scrolls the band, its tracked rows are shifted up by the same
deficit (and lines that crossed above the anchor floor are dropped, since they
are now genuinely in terminal scrollback — re-painting them would duplicate what
the terminal already holds). This is the "buffer committed lines + re-pin"
option, scoped to shrink events rather than a full every-render refactor, so the
"live frame pinned to bottom" invariant is preserved.

**Tracking.** Only the most-recent block is retained: when the frame is tall
enough for a commit to strand on shrink, the in-viewport above-frame band holds
at most a few rows and older blocks have already scrolled to scrollback. A
multi-distinct-block band collapsing in one shrink is not fully handled (rare);
older blocks remain visible in scrollback regardless.

**Regression test.** `src/cli/terminal-compositor.shrink-gap.test.ts` drives the
exact sequence (tall overlay → `commitAbove` → spinner appears → overlay
collapses) through `@xterm/headless` and asserts the committed line ends up
adjacent to the frame with no blank gap. It fails on the pre-fix code (~12-row
gap) and passes after.

### Fixed: lost commits + massive scrollback gap under tall overlays

**Symptom.** During a long investigation — repeated `commitAbove` calls while a
tall streaming "thought" overlay is up — early committed lines VANISHED from
scrollback entirely, and/or a multi-row blank gap opened between committed
clusters *in scrollback history*. Reproduced through `@xterm/headless` at the
production footer geometry (`extraRows=2`: StatusLine + LoopStageBar +
VerdictLedger), which earlier tests missed (they used `extraRows=1` and asserted
only on the live viewport, never on scrollback).

**Two interacting root causes.**

1. *Band wipe → lost commits.* `commitAbove` sets `commitInFlight=true` for the
   whole commit, which makes its Phase-2 `repaint()` skip
   `repositionCommittedBand` (guarded on `commitInFlight`). But Phase 2's
   `CupFrameRenderer.render()` erase pass runs with a stale-tall `previousTopRow`
   after a shrink-pad collapse and wipes the OLDER band rows. Phase 3 then
   repainted ONLY the newest line — so the older band lines were gone from the
   screen but still counted in the model, and the next cap dropped them on the
   false premise they had reached scrollback (the cap comment literally claimed
   "the lines the cap drops are exactly the ones Phase 1 scrolled into
   scrollback"). They had not: only blanks had. Net result: silently lost
   commits.

2. *Blank eviction → massive scrollback gap.* `preserveRowsBeforeFrameRender`
   scrolled the FULL frame-growth deficit (`prevTopRow - desiredTopRow`) into
   scrollback on every upward growth. The band hugs the frame with blank rows
   above it (a small band under a growing tall overlay), so it was those BLANK
   rows that scrolled into scrollback — opening the multi-row gap between
   committed clusters.

**The fix.**

- *Phase 3 repaints the FULL capped band*, not just the new block, so the
  physical screen always matches the model (`committedBand`). Scroll-eviction
  then carries real content into scrollback instead of blanks, and the cap drops
  exactly the lines that genuinely scrolled off. Single-copy still holds: band
  rows live only in the viewport until a later scroll moves them once into
  scrollback. The overflow (`!fitsAboveFrame`) path is unchanged.
- *Eviction-on-growth scrolls only the band OVERFLOW as real content* (no-banner
  case, `floor === 1`). On growth the band moves up into the blank space it
  already had above it (no scrollback write when it fits); only the oldest lines
  that overflow `[1, desiredTopRow-1]` are scrolled in — top-aligned first so the
  scroll evicts band rows, never blanks. Because `room === desiredTopRow - 1`,
  the survivors land already hugging the new frame top, contiguous with
  scrollback. The banner case (`anchorRow > 1`) keeps the legacy deficit scroll.
- `repositionCommittedBand` re-pins the band above the new frame top on upward
  growth too (its old "defer to evict-on-growth" early-return is removed — the
  survivors belong at `[targetBottom - fit + 1, targetBottom]`, always above the
  frame top).

**Regression test.** `src/cli/terminal-compositor.scrollback-gap.test.ts` drives
7 thought/tool commit pairs under a tall overlay at `extraRows=2`, replays
through `@xterm/headless`, and asserts every committed line survives exactly once
in commit order and that committed lines in scrollback have no >1-row blank gap.
It fails hard on the pre-fix code (early markers found 0 times) and passes after.

**Known residuals (NOT fixed here).** (a) Phase 1 still emits one `\n` per commit
(unchanged), so a band that has not yet filled the viewport leaves at most a
single blank row between some scrollback entries — cosmetic line-spacing, not a
massive gap. (b) When content scrolled into scrollback during a tall phase and
the frame later collapses, the bottom-anchored band can sit below the
scrolled-off content with blank viewport rows between them. That live-viewport
"boundary gap" is the bottom-anchored-frame design tension (the frame does not
float up to meet sparse content) and is a separate, larger item.

## What is and isn't in scrollback after a commit

After a single `commitAbove(text)`:

- **In scrollback:** whatever was at row 1 of the visible screen BEFORE the
  call. Could be banner content, prior committed text that has climbed the
  screen, or blank.
- **Visible at row rows-1:** the just-committed `text` (shifted up from row
  `rows` by the scroll). This is immediately overwritten by the live
  frame's bottom row (input prompt) when `repaint()` runs.

So a single commit doesn't visibly persist the new text — it pushes
*something else* (whatever was at row 1) into scrollback. Over a sequence
of commits, the committed text climbs the screen one row at a time as more
commits scroll, eventually reaching row 1 itself and entering scrollback.

For most operator-visible cases — a long streaming response, a completed
subagent's done block — there are enough commits in quick succession that
text reliably reaches scrollback within a fraction of a second.

## Empirical verification

`/tmp/scroll-test.cjs` (created by the diagnostic subagent during this fix)
is the empirical ground-truth check. Run in a real terminal:

```
node /tmp/scroll-test.cjs
```

It writes `SCROLLBACK_TEST_A` with cursor at `rows-1` (pre-fix behavior)
and `SCROLLBACK_TEST_B` with cursor at `rows` (post-fix behavior). Scroll
up after the script exits. Only `SCROLLBACK_TEST_B` should appear in
scrollback.

For future regression-detection in CI: a `node-pty` + `xterm.js`-headless
integration test could pipe agent-afk output through a real terminal
emulator and assert that committed lines appear in the emulator's
scrollback buffer. None exists today.

## Don't change without reading this

The pattern card filed for this is in
`~/.claude/agent-framework/pattern-cards/`. It enforces:

> Before generating sequences of terminal writes, async state mutations, or
> persistence-then-UI ops: name the external constraint governing the
> sequence (protocol / event-loop boundary / semantic invariant); emit the
> constraint as a code comment, not just in reasoning.

Both 6d7cb90 and 9690b9f failed this pattern card. The constraint
(VT100 LF-at-bottom-margin) was always there in the spec; it was just
mis-stated in the code comments.
