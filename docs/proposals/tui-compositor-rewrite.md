# Proposal: unify the compositor commit model to dissolve the scrollback-gap class

**Status:** Stage 0 VALIDATED — real-terminal A/B (iTerm2) confirmed the fix (void gone, header
present, report contiguous). This PR ships the **minimal A2 core** (~15 LOC in `commit-mode.ts`: retain
against `maxBandModel`, not the tall-frame room). Stages 2–3 (stateless render-instead-of-repin, single
end-of-turn flush) remain OPTIONAL future hardening — not required for this fix.
**Author:** session 8831d316 (diagnosis + design). All claims cited to code read this session.
**Supersedes intent of:** the "separate, larger item" flagged in `docs/scrollback.md:404`.

---

## 1. Context — the bug and why it recurs

Symptom (user-reported, reproduced deterministically): a streamed report ending in a table renders with a
multi-row **void** between content stranded in scrollback and the band hugging the frame; earliest rows can be
lost. Probe buffer (100×40, 22-row overlay): `PROSE-01..05` in scrollback, 25 blank rows, then `PROSE-06`+table
hugging the frame; `HEADER-MARKER` absent.

This is one instance of a **failure class**. ~12 regression tests circle it: `shrink-gap`, `scrollback-gap`,
`overflow-gap`, `multi-commit-gap`, `commit-collapse-wrap-gap`, `band-hold-perline-gap`, `endturn-overflow-gap`,
`banner-commit-gap`, `wrap-gap`, `pad-decay-straddle`, `two-table-overflow`. That density is the signal: the model
is fighting the medium.

## 2. The two hard constraints any design must respect

**(C1) Scrollback is append-only via full-screen scroll — you cannot reposition a committed line.**
`docs/scrollback.md:20-67`: pushing a line to scrollback requires a *full-screen* DECSTBM scroll (cursor at the
bottom margin + `\n`). Sub-region scrolls discard displaced lines. Once a line is in native scrollback its row is
frozen forever.

**(C2) The frame is unconditionally bottom-pinned, on purpose.**
`frame.ts:230-253` (`targetBottomRow === absoluteBottom`, "unconditional bottom-pinning") and
`bottom-pin.test.ts:21,63` ("frame stays bottom-pinned … so the dropdown has headroom"). The frame will **not**
float up to meet sparse content — the autocomplete dropdown / picker rely on the input sitting at the bottom with
headroom above it.

**(V) The automated suite cannot verify real-terminal behavior.** `docs/scrollback.md:9-13,108-111`: mock/headless
tests confirm bytes were *written* but not that they *reached scrollback* — that is a property of the real PTY's
scroll engine. **Prior fixes (6d7cb90, 9690b9f) shipped green and were broken in reality.** Ground truth = a human
running afk in iTerm2 / Apple Terminal / xterm and scrolling up. This is the dominant risk for this whole effort
and is a hard dependency on a human (see §8).

## 3. Root cause (precise)

The compositor has **three** interacting mechanisms for getting committed content on screen:

1. **Eager fits-path commit** (original): a block that fits the room above the *current* frame is pushed to
   scrollback immediately via a full-screen scroll, and painted above the frame.
2. **Band-hold** (`docs:426-448`): a block that overflows the *current tall* frame but fits the *collapsed* screen
   is retained in an in-memory `committedBand` model (capped at `maxBandModel` = rows above a minimal frame),
   painted partially, archived to scrollback only past the cap.
3. **Re-pin** (`committed-band-repin.ts`): on frame geometry change, the painted band is *repositioned* to hug the
   new frame top.

The void arises because the **eager fits-path (1) sizes its keep-vs-archive decision against the room above the
TALL overlay (~12 rows), not the room above the COLLAPSED frame (`maxBandModel` ~34).** Content that *would* fit
post-collapse gets prematurely archived to scrollback (C1: now frozen). On collapse, re-pin (3) drops the surviving
band down to the bottom-pinned frame (C2), leaving the prematurely-archived rows stranded above → the void.
Many-small-commits (each fitting the tall frame) never trigger band-hold (2), so they all take path (1) → the
common real-world trigger.

`overflow-gap.test.ts:198-205` and `docs:400-405` already document this exact geometry as **out of scope / a
separate, larger item** — which is why 416 headless tests stay green while reality breaks.

## 4. Decision drivers

- Dissolve the **class**, not patch instance N+1 (the 12-test density says patching loses).
- Respect C1 (never need to reposition scrollback) and C2 (keep bottom-pin / dropdown headroom).
- Keep the public `TerminalCompositor` API stable (input stack, lifecycle, picker, autocomplete unchanged).
- Minimize real-terminal risk under V (fewer distinct scroll code-paths = fewer places reality can diverge).

## 5. Options considered

### A1 — "Ink model": float the live region, commit-on-finalize, delete the band
Live region (overlay+input) floats directly below finalized content; finalized blocks commit to scrollback in
final position; on collapse the region shrinks in place — no re-pin, no void. **Rejected as primary:** violates C2
(kills unconditional bottom-pin → removes dropdown headroom, `bottom-pin.test.ts:63`), a deliberate UX property.
Larger blast radius and a visible prompt-position UX change. Keep as a "someday, if we revisit bottom-pin" note.

### A2 — "Unified retained model" (RECOMMENDED)
Collapse the three mechanisms into **one**. Keep bottom-pin.

- All mid-turn committed content lives in a single ordered in-memory `turnModel: string[]`.
- **Routing:** every `commitAbove` appends to `turnModel`. Nothing takes an "eager fits-path" scroll just because
  it fits the current tall frame. (Deletes mechanism 1.)
- **Archive threshold uses the COLLAPSED-frame room (`maxBandModel`), never the current tall-frame room.** Only the
  true overflow — lines beyond the bottom `maxBandModel` — is archived to scrollback, and only ever from the *top*
  of the model, contiguously, so C1 never requires repositioning.
- **Render, don't re-pin:** each repaint paints the visible window (`turnModel.slice(-room)`) fresh at the current
  geometry via the existing CUP erase-and-paint primitive (`eraseAndPaintRow`, no `\n`, no scroll — C1 safe),
  hugging the bottom-pinned frame. Collapse is just "render at the new, larger `room`." (Replaces mechanism 3's
  incremental reposition with a stateless re-render — gap-free by construction.)
- **Single flush at turn-end:** when the turn finalizes (geometry stable), flush the remaining model to scrollback
  once, contiguously, via the full-screen-scroll commit — the only place C1's scroll is used besides true overflow.

Why it dissolves the class: content only ever reaches scrollback (a) as true top-overflow during the turn or
(b) as the final flush — in both cases contiguous and never repositioned. The visible band is always a fresh
render, so there is no scrollback-adjacent band to re-pin and no seam to mismanage.

### C — Document as a known limitation (status quo). Already effectively in place (`docs:400-405`). No.

## 6. Blast radius (A2)

**Reworked (~1,200 LOC):** `committed-band-commit.ts` (750 — unify routing, drop eager fits-path),
`committed-band-repin.ts` (146 — replace incremental reposition with stateless window re-render),
`frame-preserve.ts` (332 — eviction logic folds into the single archive threshold). **Preserved:** `frame.ts`,
`render.ts`, `cup-frame-renderer.ts`, `lifecycle.ts`, the entire input stack (`input-dispatch`, `input-mode`,
`paste`, `autocomplete`, `picker`, `caret`), and the public API. So this is a **bounded refactor of the commit
model, not a ground-up compositor rewrite** — the earlier "2–4k LOC rewrite" estimate was pessimistic.

## 7. Migration stages (each gated; spike first)

- **Stage 0 — Spike (throwaway, in a worktree).** Prototype `turnModel` + render-window + collapsed-room archive
  threshold behind a flag. Prove on the 100×40 repro that the void is gone AND a representative slice
  (`multi-commit-gap`, `overflow-gap`, `scrollback-gap`, `shrink-gap`) stays green. **Human visually validates the
  spike in a real terminal.** If it doesn't hold, we learned cheaply and stop. ← de-risks §2-V before real spend.
- **Stage 1 — Unify routing.** Route all commits through `turnModel`; delete the eager fits-path; archive at
  `maxBandModel`. Full suite green.
- **Stage 2 — Render-not-repin.** Replace `repositionCommittedBand` with the stateless window re-render. Full suite.
- **Stage 3 — Single end-of-turn flush.** Full suite + new deterministic regression tests (the 100×40 void, the
  many-small-commits trigger, the header-loss case).
- **Stage 4 — Real-terminal validation matrix** (human): iTerm2 / Apple Terminal / xterm × {short report, long
  report+table, resize mid-turn, overlay grow→collapse, dropdown headroom, picker}. Only after this passes is it
  "done."

## 8. Risks & dependencies

- **[HARD] Human visual validation (V).** The suite cannot certify correctness; I cannot see a real terminal. This
  rewrite is *not shippable* on green tests alone. Requires the operator (or a human) to run the Stage-0 spike and
  the Stage-4 matrix and eyeball scrollback. Without this commitment, the honest ceiling is "headless-green,
  reality-unverified" — no better guarantee than the fixes that already shipped broken.
- **Flicker (re-render each frame).** Stateless window re-render writes more bytes than incremental reposition.
  Mitigation: only repaint on model/geometry change (not per spinner tick); add cell-diffing later if needed.
- **`maxBandModel` memory for pathological turns.** Bounded by the cap; true overflow still archives. No regression
  vs today.
- **Hidden coupling.** `committedBandBottomRow` is read by ~10 sites assuming band-adjacency
  (`committed-band-commit.ts:191,607-608,687`). Stage 2 removes the incremental band, so these collapse into the
  render path — must be migrated together, not piecemeal.

## 9. Open questions / not yet verified

- Whether `HEADER-MARKER`'s disappearance in the probe is true content loss (repin void-erase,
  `committed-band-repin.ts:117-119`) or a harness artifact — confirm in Stage 0.
- Exact `maxBandModel` derivation under non-zero `extraRows` + soft-wrapped frame lines (`measure()` path).
- Whether any caller depends on mid-turn scrollback *scrollability* of not-yet-final content (A2 keeps only
  true-overflow scrollable mid-turn; the rest becomes scrollable at end-of-turn flush). Believed acceptable; confirm.
