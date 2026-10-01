# Streamed-text reveal for READ-ALONG users (2026-09-29)

Follow-up to `reveal-rewrite-research.md`. New constraint from the operator:
he often reads the text live while it streams, and the smoke and ink reveals
get in the way. The goal is reading comfort, not visual effect.

## Why per-character reveals hurt live reading

- [measured] Reading fixations last 200-250 ms, and the eye moves by words
  (7-9 letters per saccade). Silent reading averages ~238 wpm (Brysbaert 2019).
- [measured] Abrupt onsets pull attention involuntarily (Yantis & Jonides
  1984; Abrams & Christ 2003). Jerky onsets capture attention and smooth
  motion does not (https://link.springer.com/article/10.3758/s13414-013-0587-x).
- [code] Today's front moves at 60-180 cps (`MIN_CPS`/`MAX_CPS`,
  `src/cli/smoke-reveal.playhead.ts:33-35`). That puts over a hundred onsets
  per second next to the words you are reading. Smoke also adds moving braille
  particles.
- [code] Visible text also moves for reasons unrelated to the reveal:
  1. Partial markdown gets restyled: `closePendingInlineSyntax`
     (`src/cli/markdown-stream-format.ts:80`) can turn a word bold after
     it has already appeared.
  2. The line re-wraps as it grows.
  3. The block switches type (fence, table, or list preview).
  4. A heading-hold release floods in queued text.
  5. A height-cap flip snaps text solid.

## What shipping tools do

| Tool | Unit | Notes |
|---|---|---|
| Codex CLI (codex-rs) | completed line | [source] `markdown_stream.rs` commits only on newline; a live tail cell sits over stable scrollback; `commit_tick` drains a queue adaptively |
| Gemini CLI | safe markdown split | [source] `<Static>` history plus one pending item; no fade |
| simonw/llm | raw token | [source] print+flush, no markdown |
| Vercel smoothStream | word (`/\S+\s+/`), 10 ms | [source] never releases a partial word |
| flutter_markdown_stream, flowtoken | word fade | [source] code/tables appear whole |
| Ant Design X | word fade 200 ms + `▋` tail cursor | [docs] |
| ChatGPT / Claude.ai | word fade ~100-200 ms | [observed only] |

Nobody ships a per-character front with per-letter color fades.

## Ranked designs for live reading

1. **Steady words, no color (recommended first try).**
   - Whole words release at a smoothed cadence: at most one cohort per
     ~50 ms, with lag capped at ~250 ms.
   - The trailing partial word and any unclosed `**`/`` ` `` stay hidden,
     so words never grow or restyle after they appear.
   - There is no color animation, so the only onsets are the words
     themselves.
   - Optional dim `▏` caret at the head.
   - Cost: a new `word-reveal` module (~150-200 LOC) behind the existing
     10-member `SmokeReveal` seam, plus a flag. Holding text back is done
     by masking in `apply()`, not by withholding it from the buffer, so the
     "pace the reveal, never the text" invariant holds.
2. **Steady words plus a short fade on the newest cohort only.**
   - This is the web-chat feel. The newest cohort goes dim to normal over
     ~120-160 ms; all older text is solid.
   - Cost: option 1 plus ~40 LOC.
3. **Line commit (Codex style).**
   - A line appears only once it is complete or wrapped. Text above never
     changes, so it is the calmest option.
   - The downsides are steppy output and the newest words lagging by up to
     one line.
   - Build it as reveal-side masking of the incomplete last row, not as a
     pre-push filter. A pre-push filter would break commit-defer and hold
     ordering.
4. **Instant (`AFK_INK_TEXT=0`) plus stability fixes.**
   - Available today. It still repaints the live region at a 33 ms
     throttle and still has restyle and re-wrap motion.
   - Use it as the comparison baseline.
5. **Reader-paced "teleprompter" (experimental, opt-in only).**
   - Drain at ~300 wpm. This extrapolates from RSVP studies, which measure
     single words shown at the fixation point, not paragraphs.
   - A 600-word answer would take ~2 minutes to show, against ~20 s today.
   - It conflicts with the prior doc's "don't pace down to reading speed"
     principle.

Cross-cutting fix that helps every option: never restyle text that is
already shown. Hold unclosed inline markup instead of synthesizing closers
(`markdown-stream-format.ts:80`). This is medium-high complexity, because it
touches `PendingFormatCache` and `formatPendingBuffer`.

## Tests a new mode must pass

`src/cli/markdown-stream.reveal.test.ts`:
- `AFK_INK_TEXT=0` is instant.
- Settled text does not re-fade when syntax arrives.
- The layout matches the reveal-off layout.
- `commitPending`/`discardPending` run synchronously.
- `AFK_REDUCED_MOTION=1` disables the reveal.

## Gaps

- Web-UI fade timings are observed, not published.
- The Aider, Warp, and opencode sources were not read.
- The Codex `commit_tick` drain rate is unconfirmed.
- No study measures streaming prose in a terminal specifically; the live
  A/B is the real test.
