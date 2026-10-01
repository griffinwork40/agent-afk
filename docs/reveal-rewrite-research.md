# Streamed-text reveal: rewrite research (2026-09-29)

Status: proposal, not implemented. Context: after two rounds of constant
tuning (per-letter contrast, then pacing: `TARGET_LAG_MS` 400, `MAX_CPS` 180)
the operator still reports the ink/smoke reveal as "jenky and fast".

## Diagnosis: why tuning cannot fix it

The unit is wrong, not the numbers.

- The reveal animates **one character at a time behind a moving front**
  (`smoke-reveal.playhead.ts`, velocity chase at `:222`). Models emit
  150-350 chars/sec, so the front must move at roughly 150-180 cps: about
  180 separate "letter appeared" motion events per second. Reading runs at
  about 20 cps and the eye moves by **words** (fixations ~200-250 ms), so
  the front is always a blur the eye cannot land on.
- Bursty network chunks make the front sprint and then stall, and any
  overflow is snapped solid as a group (`settleOverflow`, `:93-111`).
  Smoothing that oscillation (the lag constant) trades directly against
  lag behind the model.
- Already-visible words restyle as text arrives: `closePendingInlineSyntax`
  (`markdown-stream-format.ts:80`) synthesizes closers for unclosed
  `**bold**` and backticks, so a word can appear plain and then turn bold,
  and wrap points shift. The reveal amplifies this by fading the very
  characters being restyled.

## What well-regarded tools do (sources in research transcript)

| Tool | Reveal unit | Timing | Backlog |
|---|---|---|---|
| Vercel AI SDK `smoothStream` | word (default), line, regex | `delayInMs` 10 per chunk | buffers to next word boundary; never releases partial words |
| ChatGPT / Claude.ai web | word, with short opacity fade (observed, not documented) | fade ~100-200 ms | smooths bursts; no published spec |
| llm-ui | word for prose; code/markdown blocks held until complete | throttled | never renders partial markdown |
| Codex CLI, Gemini CLI, Charm tools | no per-char animation; text appended / lines committed | n/a | n/a |

Recurring principles:
1. The word is the smallest release unit anyone ships. Nobody ships a
   per-character moving front with per-letter color fades.
2. Do not show partial markup: hold the trailing partial word and any
   unclosed inline syntax until it is stable.
3. Nobody tries to pace text down to reading speed. They make each
   release event calm (word-sized, short fade) and let the rate follow
   the model.
4. Decorative motion outside the reading point (e.g. braille smoke on a
   heading while body text streams) captures attention involuntarily.

## Options

### A. Word-cohort fade (recommended)
- Unit: word (grapheme-safe word boundaries on raw text). The trailing
  partial word and unclosed inline markup are held back until stable.
- Cadence: at most one release per ~50 ms (20 Hz). Every word that is due
  in that tick releases together as one cohort, so a burst becomes a few
  calm steps instead of a racing front, and no "snap solid" path is needed.
- Fade: each cohort fades from about 35% to 100% over ~160 ms with ease-out.
  No moving front, no per-character stagger.
- Lag: about 100-250 ms behind the model, less than today.
- Smoke: drop the braille particles from body streaming; keep at most a
  single whole-line fade for headings.
- Fixes: blur front, sprint/stall, chunk snaps, restyle flashes (partial
  markup is never shown).

### B. Line-at-a-time fade
- A line appears only once it is complete (wrapped or newline), then fades
  in over ~200 ms. About 2-5 events per second; visible text never moves.
- Calmest, but steppier and the newest words lag by up to a line.

### C. No animation (baseline)
- Already available: `AFK_INK_TEXT=0`. Worth one live comparison first: if
  that still feels jenky, the problem is markdown reflow/repaint, not the
  reveal, and the rewrite should target reflow.

## Seam and blast radius

`markdown-stream.ts` touches the reveal through exactly ten members of
`SmokeReveal`: `record`, `apply`, `smokeHoldRemaining`,
`revealHoldRemaining`, `noteCommit`, `forgetNewest`, `markDirty`,
`animating`, `reset`, `dispose`. A rewrite behind that interface leaves
`markdown-stream.ts`, commit-defer, heading-hold, and the compositor
untouched. Plan: new `word-reveal` module implementing the same members,
selected by an env flag so old and new can be compared live; retire the
playhead/cells/oklab path only after the new one is accepted.

Invariants to preserve (from the `smoke-reveal.ts` header): pace the
reveal, never the text (never withhold text from the buffer); map ages by
distance from the end so commits and re-wraps do not restart fades;
`AFK_INK_TEXT`, `AFK_SMOKE_TEXT`, `AFK_REDUCED_MOTION` keep working.

## Confidence and gaps

- High: the seam, the per-char design, the reflow source (read in code).
- Medium: the external survey; ChatGPT/Claude.ai timings are observed
  behavior, not published specs; Aider and Warp were not checked.
- Perceptual claims are principles, not measurements; the live A/B is the
  real test.
