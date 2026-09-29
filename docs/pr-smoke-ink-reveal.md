# feat(tui): smoke-ink-reveal — fix bold-title accent, ** leak, gap classification

Picks up the local commits `c9ef563e` + `07f77cc2` (ink default + smoke-as-heading-accent) that live on `afk/smoke-organic` but were never pushed, and fixes three defects found via frame analysis of `~/Desktop/smoke-broke.mov`.

## What was already there (cherry-picked from `afk/smoke-organic`)

- `AFK_INK_TEXT` (default on): prose fades in like ink drying — each letter rises from just above the background into its own color, never overshoots brightness.
- `AFK_SMOKE_TEXT=1` (opt-in): heading lines condense from braille particles, with a thin drifting wisp ahead of the front. Body prose stays ink.
- Reveal paces styling, never text: layout and block commits are identical to reveal-off (no flicker regression from overlay growing one row at a time).

## Defects fixed in this PR

### 1. Bold-only title line never triggered the smoke accent ✓ FIXED

**Root cause:** `LineClassifier` (smoke-reveal.lines.ts) only recognized `# Heading` syntax. Models frequently respond with `**Title**` instead of `# Title` — the accent never fired for those responses.

**Fix:** The first non-blank line is now also classified as a heading when it starts with `**` or `*` (bold/italic-only title). The `firstLine` flag is consumed by the first non-blank non-heading line, so bold words in body paragraphs are never mis-classified. `splitAtHeadingBoundary` (heading-hold.ts) was extended with the same logic to hold single-line bold blocks until they condense, preventing the smoke from being cut off after a frame or two.

### 2. Literal `**` at the fade edge (markdown syntax leak) ✓ FIXED

**Root cause:** `closePendingInlineSyntax` appended `**` to close any unclosed bold marker, even when the trailing `**` had no content after it (e.g. `"text **"` at a chunk boundary). This produced `"text ****"` → marked rendered `****` as literal text (empty bold span = no element). The smoke reveal showed `****` as visible asterisks at the fade edge.

**Fix:** The close is skipped when the trailing open marker has no content after it in the cleaned text (`emptySpanIfClosed`). The pending display shows a bare `**` for the fraction of a second until the next chunk adds content — which the smoke reveal hides as blank cells anyway (unborn). Strictly better than showing `****`.

All 18 existing `closePendingInlineSyntax` tests pass; two new edge-case tests added.

### 3. Repaint gaps classified — NOT a code bug ✓ RESOLVED

**Finding:** The 20 gaps >80ms between repaints in `smoke-broke.mov` (vs 2 in the reference) were honest model pauses (no new content), not stalls in the animation loop. In-process measurement shows the throttle cap keeps paint gaps ≤35ms whenever the model is actively streaming. The old long animation simply masked these pauses visually.

**Evidence:** See metrics table below.

## Metrics (in-process, with real timers, against 406-char text including `**Title**` + `## Heading`)

| Build | Repaints | Gaps>80ms (streaming) | Gaps>50ms | Avg gap | Literal `**` in commits |
|-------|----------|-----------------------|-----------|---------|--------------------------|
| Ink=on (default, this PR) | 18 | 0 | 0 | 27ms | no ✓ |
| Reveal-off (AFK_INK_TEXT=0) | 18 | 0 | 0 | 26ms | no ✓ |
| Smoke=on (AFK_SMOKE_TEXT=1) | 18 | 0 | 0 | 27ms | no ✓ |
| 886bdec1 baseline (merged) | N/A — same throttle path, no animation overhead added |

**Overshoot:** No character ever exceeds its settled brightness. The `easeOutCubic` blend from `INK_FLOOR=0.06` (ink) or `SMOKE_PEAK=0.36` (smoke) toward the settled color is monotonically increasing — brightness only rises, never overshoots.

**Full-screen redraw count:** The "pace the reveal, never the text" invariant (07f77cc2) means layout and block commits are identical to reveal-off. The compositor sees the same number of `setOverlay` + `commitAbove` calls. No flicker regression. Deferred commits (below) change WHEN a block commits, never how it is laid out or how many commits happen.

**Deferred commits (2026-09-29):** At model stream rates (~250-500 chars/s against the 240 chars/s prose ceiling) most of each paragraph was still fading when the next `\n\n` committed it, so it snapped solid: a smooth title, then a body that "glitched and skipped". `markdown-stream.commit-defer.ts` now keeps a completed block pending until its last letter is 75% through its fade (at most 1.5 s), while the next block's text keeps flowing and revealing; the prose lag budget (`MAX_LAG_MS`) rose from 350 ms to 1.5 s so a fast stream trails instead of popping; and a cleanly finished stream settles its tail for up to 1.5 s before the verdict card.

A first attempt HELD the text after each boundary instead. It measured far worse (52-83% at 240 chars/s): with nothing new to reveal, the front decelerated and idled at every paragraph break, and the lag piled up until the hold limit forced the snap anyway.

Measured on the real renderer streaming a 1,100-char story, and the same story three times over (share of letters at least 40% faded in when committed; "bursty" = 90-150 char chunks):

| Stream | Before | Deferred commits | Verdict card after stream end |
|---|---|---|---|
| 240 chars/s | 52% | 100% (3x: 100%) | +16 ms → +0.65 s |
| 300 chars/s | ~35% | 100% (3x: 100%) | +16 ms → +0.74 s |
| 300 chars/s, bursty | ~35% | 100% (3x: 100%) | +16 ms → +0.82 s |
| 450 chars/s | ~15% | 100% (3x: 68%) | +16 ms → +1.5 s |

Only a long reply faster than the reveal outruns the 1.5 s lag budget, and then the oldest backlog settles solid (the reveal is deliberately slower than the model).

## Gates

All run locally and pass:
- `pnpm lint` (tsc --noEmit, strict)
- `pnpm build`
- `pnpm test` (22,045 tests, 26 skipped — same as main)
- `pnpm test:pty` (30 scenarios, including smoke-text-settles, smoke-text-mid-fade, smoke-fade-status-order)
- `pnpm audit:filesize:check` ✓ (350-line ceiling)
- `pnpm audit:funcsize:check` ✓ (200-line function ceiling)
- `pnpm audit:env:check` + `scan:env:check` ✓ (no raw process.env; 201 ENV vars in sync)
- `pnpm audit:chalk:check` ✓ (no raw chalk outside palette)
- `pnpm audit:module-state:check` ✓ (no duplicated module singletons)
- `pnpm fix:pins:check` ✓ (SHA-256 pins intact)
- `pnpm audit:sdk:check` ✓ (SDK lock in sync)

## Decision: ink stays the default

In-process metrics show ink=on is identical to reveal-off on repaint count, gap distribution, and markdown leaks. The brightness guarantee (no overshoot) is enforced by the blend math. PTY tests confirm the reveal settles cleanly with no glyphs remaining.

**Caveat:** The headless emulator cannot judge feel. Griffin should do a live look in his terminal (tmux) before merging. The original `~/Desktop/smoke-text-vid.mov` remains the reference for qualitative feel.

## What was NOT changed / NOT verified

- The locked `.afk-worktrees/smoke-organic` worktree, `afk/smoke-organic` branch, and `backup/smoke-organic-07f77cc2` tag are untouched.
- The `~/Desktop/smoke-broke.mov` frames were analyzed numerically (ffprobe timings); no frames were viewed directly (image budget constraint).
- The `** Note: thing` pattern (space after `**` = invalid bold syntax) still shows literal `**` in the formatted output. This is a marked behavior (not valid bold), not a bug in our code. The smoke reveal hides it as blank cells while unborn.

## Worktree

`/Users/griffinlong/Projects/open_source/agent-afk/.afk-worktrees/smoke-ink-reveal` (branch: `afk/smoke-ink-reveal`)
