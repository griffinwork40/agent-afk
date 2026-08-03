# Next-action suggestion at the idle prompt

*(originally "Idle-turn proposal ghost (Tier 3)" — that design was rejected after critique;
see DECISION below for the superseding approach.)*

**Status:** Tier-3 REJECTED. Its successor was also gated out by measurement. A third,
smaller change shipped instead — see "What shipped" below.

## What shipped

Neither idea in this document was built. Both were killed by evidence, in order:

1. **Tier-3 idle proposer** (the original idea) — rejected after a `/devils-advocate` wave;
   three critics independently returned `strong` alternatives.
2. **"Next action" from the end-of-turn contract** (the successor) — gated on a
   prerequisite measurement, which **failed**. Measuring `parseTerminalState()` against 400
   real REPL transcripts (692 assistant turns) gave a **69.5% parse rate** against a 70%
   threshold, and — far more damaging — only **0.7% of terminal-state bodies contained
   anything resembling a runnable slash command**. The premise that "the model already
   computes the next action for free" is false: it emits prose about what is pending, not a
   command. Building on it would have produced a feature that silently did nothing.
3. **What shipped instead:** recency ranking for slash-command completion
   (`src/cli/input/suggest-rank.ts`). Measurement during the above investigation showed
   **92% of the 101 registered commands+aliases sit behind an ambiguous 2-char prefix**, and
   ties were broken *alphabetically* — so `/re` resolved to `/reauth` ahead of `/refactor`,
   `/research`, `/resolve`, `/review` and six others. Ranking the tie-break bucket by the
   user's own input history fixes the discoverability complaint that motivated this whole
   investigation, on a code path that is **already on by default**, with no model call, no
   new config, and no input-pipeline risk.

The through-line: the original goal was "help the user pick the next action, and surface
skills they forgot exist." The shipped change serves that goal on the default-on path; both
rejected designs served it on an opt-in path at much higher cost.

---
**Branch:** `afk/ai-predict-ghost-text` (worktree; tracked tree byte-identical to `main` @ `b25463e3`, 0 commits ahead/behind `main` and `origin/main`)
**Date:** 2026-08-03
**Verification:** claims below survived a 4-verifier adversarial wave (2026-08-03). Two
original claims were REFUTED and are corrected inline, marked with blockquotes. Caveat: two
verifiers read this file during verification, so the wave was not fully blind — though one
of them refuted it anyway.

## Premise correction

The originating idea was "while the REPL sits idle at the user's turn, generate AI ghost
text — maybe suggest a skill." Reconnaissance found that **ghost text already ships and is
live on `main`**: `src/cli/input/suggest.ts` (539 LOC) is a two-tier engine rendering dim
inline completions after the caret, accepted with `Tab` / `→`.

One asterisk, verified: the two tiers have **different defaults**. Tier 1 (deterministic
history/dropdown/slash completion) is **ON** for every user. Tier 2 — the actually-AI tier —
is **OFF** unless `AFK_SUGGEST_ENABLED` is set. So "we already have AI prediction" is true in
the tree and false in practice for a default install.

So this proposal is not "add ghost text." It is the one thing the shipped engine
structurally cannot do: **propose an action from an empty prompt.**

## What exists today (verified by direct read)

| Layer | Behaviour | Citation |
|---|---|---|
| Tier 1 | Sync prefix-match: dropdown top candidate → history → mid-sentence `/slash` name | `src/cli/input/suggest.ts:292-341` |
| Tier 2 | LLM fallback, 250 ms debounce, 1500 ms hard abort, `maxTokens: 24`, FIFO cache (500), secrets redacted at egress | `suggest.ts:343-486`, prompt at `:100-131` |
| Trigger | **Keystroke only** — sole call site is `applyEdit` → `updateGhost` | `terminal-compositor.input-dispatch.ts:182` |
| Render | Dim suffix after caret, grapheme-aware truncation so the line never wraps (DECSTBM safety) | `terminal-compositor.render.ts:102-148` |
| Accept | `→` when cursor at end; `Tab` with dropdown-first precedence | `input-dispatch.ts:1017-1018`, `:1114-1116` |
| Gate | `AFK_SUGGEST_GHOST` / `interactive.suggestGhost` (default **on**); Tier 2 separately behind `AFK_SUGGEST_ENABLED` (default off); model via `AFK_SUGGEST_MODEL` | `env.ts:506-524`, `settable-keys.ts:220`, `repl-loop.ts:85` |

## The gap

> **Corrected after adversarial verification (2026-08-03).** An earlier draft of this
> section claimed "exactly three independent empty-buffer blocks." That count was wrong,
> and the framing buried the actual primary blocker. Corrected below.

**Primary blocker — an absence, not a guard.** Nothing ever invokes the suggestion engine
while the REPL sits idle. `updateGhost()` (`terminal-compositor.autocomplete.ts:156`) has
exactly one call site repo-wide: `applyEdit` (`terminal-compositor.input-dispatch.ts:182`),
which runs only on a buffer mutation. No timer-, mode-, resize-, paste-, or
turn-completion-driven path computes a suggestion. This cannot be fixed by flipping a
condition; it needs a new arm/disarm subsystem.

**Secondary — the empty-buffer guards (≥4, not 3):**

| file:line | condition | bypassable | load-bearing |
|---|---|---|---|
| `suggest.ts:299` | `if (buffer.length === 0) return null;` (Tier 1) | single line | yes — removing it makes the history branch match the newest entry for *any* buffer, since `entry.startsWith('')` |
| `suggest.ts:352` | `buffer.length < MIN_LLM_CHARS` (`= 3`) | single line | yes — also gates the debounce/cache machinery below it |
| `render.ts:117` | `self.input.buffer.length > 0` | one of 6 clauses | yes — pinned by regression test `terminal-compositor.ghost.test.ts:256` |
| `render.ts:116` | `!suffix` — blocks ghost whenever `[queued]` is showing | single clause | orthogonal to emptiness, but an idle proposal must still handle it |
| `render.ts:121` / `autocomplete.ts:177` | `!ac?.dropdownOpen` | single clause | inert for a truly empty buffer (`detectTrigger('',0)` needs a leading `/` or `@`) but a real co-located gate |

The FIFO result cache has **no** special empty-key behaviour — it is simply unreachable for
`buffer === ''` because the min-chars guard short-circuits first.

**Surface scope.** The fallback readers (`src/cli/input/reader.ts`, `src/cli/input/non-tty.ts`)
wire **no suggestion engine at all** — no ghost of any kind exists there. This feature is
compositor-only; `reader.ts` is explicitly out of scope.

**Two semantic facts:**

- **No idle timer exists.** The 250 ms debounce is "idle *within* typing," not "idle at the
  prompt." Nothing is time-driven.
- **Skills are completed, never proposed.** `suggest.ts:319` expands a partial `/dia` →
  `/diagnose`. It cannot say "you probably want `/diagnose`" when nothing is typed.

The governing invariant is **ghost = continuation of a typed prefix**, enforced by
`isValidContinuation` (`suggest.ts:165-168`). An idle proposal is not a continuation; it is
an *offer*. Overloading Tier 2 with it would:

- void the safety guard — `''.startsWith('')` passes trivially, so every reply validates;
- collapse the result cache onto a single `''` key;
- collide with `Tab`'s dropdown-first precedence at an empty buffer.

**Therefore: a separate concern in its own module, not a fourth branch in `suggest.ts`**
(which is already 539 LOC, well past the 350-line ceiling).

## DECISION (2026-08-03): Tier 3 is REJECTED — superseded

A `/devils-advocate` wave (pragmatist / paranoid / architect, parallel and independent)
returned **three `strong` alternatives**, two of which converged on the same one. A Wave-3.5
composition-boundary check returned CONFIRMED. The Tier-3 design below is retained for
context but **should not be built**.

**Superseding approach — "next action from the end-of-turn contract, seeded into Tier 1":**

1. Add one bullet to `END_OF_TURN_DIRECTIVE` (`routing-directive.ts:98-124`) asking the model
   to name the single most useful next input, preferring an existing slash/skill command.
2. Parse it into the terminal-state structure (`terminal-state.ts`) as `suggestedNext`.
3. Render it as a row in the existing verdict card (`verdict-card.ts` `collectRows`).
4. **Seed it as a Tier-1 candidate source — never into `activeGhost` directly.**

Why this wins: the strong model already computes "what's next" every turn at zero marginal
inference cost. A cheap-model idle call re-derives a weaker version of an existing signal from
a lossy 600-token echo of context the first call already had.

Why step 4 is the crux: because the suggestion enters Tier 1 rather than `activeGhost`, the
empty-buffer guards (`suggest.ts:299`, `render.ts:117`) stay **untouched** — so no ghost is
ever armed at an empty prompt and the accidental-accept hazard never exists. The moment the
user types one character of the suggestion, the already-shipped Tier-1 prefix-match completes
it and Right-arrow accepts. One-keystroke acceptance via machinery that already ships and is
already tested. The guard framed as the obstacle turns out to be the safety mechanism.

Cost: ~60 LOC. No new module, no timer subsystem, no `activeProposal` field, no render-gate
exception, no env var (hence no CI-gated `docs/env-registry.*` regen), no PTY scenario.

**Rejected variant:** seeding directly into `activeGhost` (the architect's render half).
`applyGhostAccept` (`terminal-compositor.autocomplete.ts:272-278`) has no `buffer.length > 0`
precondition, so an empty buffer trivially satisfies all of them. It is inert today only
because nothing ever arms a ghost on an empty buffer; this would be the first producer to do
so.

### Prerequisite before building — the kill criterion

The whole approach rests on the model reliably honoring the end-of-turn contract, and
verification found that contract is **unenforced and unmeasured**:
`terminal-state-gate.ts:126-133` cannot distinguish "nothing parseable was emitted" from a
legitimate Blocked/Asking verdict, and no telemetry tracks parse-failure rate.

**Measure the terminal-state parse rate across recent interactive turns FIRST.**
- parse rate < ~70% → the feature silently no-ops on most turns; do not build it, fix
  compliance first.
- parse rate healthy, but the offered command is accepted < ~10% of the time → the suggestion
  is noise; remove the bullet (one-line revert).

### Two known landmines

- `mapBulletsToFields` resolves `deferred` with the needle list
  `('pending','deferred','follow-up','followup','next')` (`terminal-state.ts:247`), and
  `find()` returns on first substring match. A bullet labeled "Suggested next" contains
  `next` and would be captured as `deferred`. Narrow the needle or order the new field first.
- Card-to-prompt adjacency is conditional: background-subagent and shell-passthrough
  notifications drain at the top of the *next* loop iteration
  (`loop-iteration.ts:236-266`), printing after the verdict card and before the prompt. Any
  UX premise that the suggestion sits directly above the cursor breaks while background work
  is in flight.

### Surface scope, verified

`END_OF_TURN_DIRECTIVE` is injected only for `surface ∈ {'repl','telegram'}`
(`routing-directive.ts:138-141`); one-shot (`chat.ts:360`) and sub-agent threads deliberately
omit it, and the daemon bypasses `assembleSystemPrompt` entirely. `suggestedNext` inherits
that conditionality for free and degrades to null everywhere else — `collectRows` already
skips empty values, so no downstream change is needed.

---

## REJECTED DESIGN (retained for context)

> Everything below describes the Tier-3 idle proposer, superseded by the decision above.

### New module — `src/cli/input/idle-propose.ts` (~200 LOC)

```ts
createIdleProposer(opts): IdleProposer
  arm(ctx: IdleContext): void   // start the timer
  disarm(): void                // cancel timer + abort in-flight
  dispose(): void
```

Dependency-injected exactly like `createSuggestEngine` (`completeFn`, `resolveProviderFn`,
`delayMs`, `timeoutMs`) so it is unit-testable with no live infrastructure.

### Trigger policy — the whole feature lives or dies here

- Arm only when input mode flips to `idle` **and** the buffer is empty.
  Hook: `setInputMode('idle')` at `input-surface.ts:355` / `stream-renderer.ts:916`.
- Delay **~4 s**, not 250 ms. The signal is "the user is thinking," not "paused mid-word."
- **Exactly one call per turn.** Never re-fire until the next turn ends.
- Disarm on: first keypress, `setInputMode('streaming')`, dropdown open, `[queued]` suffix.
- `Esc` dismisses for the remainder of the turn.

### Context bundle — where "send a subagent" gets cashed out cheaply

Assembled once at turn end, all in-process, all free. Richer than Tier 2's 200-char tail:

- last assistant message tail (~400 chars)
- **tool errors from the last turn** — highest-signal input for "what next"
- git branch + dirty count (already held by the REPL)
- 5 recent commands
- **slash/skill registry: names + one-line descriptions** — `listSlashCommands` /
  `aliasEntries` are already imported at `suggest.ts:30`

Reuse `redactSecrets` at the same egress chokepoint as `buildUser` (`suggest.ts:126`).

System prompt differs from Tier 2's: *"Propose the single most likely next input. Prefer an
existing slash command when one fits. Output only the line."*

**Explicitly rejected: dispatching a real subagent per idle.** 3–15 s latency and real cost,
answering after the user has already typed. The rich-context oneshot captures most of the
value at ~1 % of the cost.

### Render + accept

- Relax render gate #3 to allow an empty buffer **only** when an idle proposal is active,
  tracked as a field distinct from `activeGhost`.
- Render visually distinct from a completion — dim plus a leading `↳ ` marker. Users must
  never be unsure which characters are really in their buffer.
- **Accept: no keybinding work is needed — and that is the risk.**

  > **Corrected after adversarial verification.** An earlier draft asserted "Right-arrow at
  > an empty buffer is a no-op, so binding it is collision-free." That is **false**.

  `input-dispatch.ts:1016-1029` already routes Right-arrow to `applyGhostAccept()` whenever
  `cursor === buffer.length && activeGhost !== null && !dropdownOpen`. An empty buffer
  satisfies `cursor === 0 === buffer.length` **identically to any other end-of-buffer
  state**. So if the idle proposal is stored in `activeGhost`, Right-arrow accepts it with
  zero new code.

  The consequence is a *hazard*, not a win: Right-arrow at an empty prompt is currently
  harmless muscle memory, and this silently turns it into "submit an AI-proposed command
  into my buffer." Two options:

  1. **Reuse `activeGhost`** — free accept, but inherits the accidental-accept hazard.
  2. **Separate `activeProposal` field** — requires an explicit accept binding, but lets the
     accept key differ from completion-accept and keeps the hazard opt-in.

  Recommend (2). The cost is ~20 LOC; the benefit is that an idle proposal can never be
  accepted by a reflex keystroke aimed at a completion.

  `Tab` stays untouched either way — Tab-hijack is the most-cited reason people disable AI
  autocomplete (`vscode-copilot-release#1013`). Note also that `(meta|ctrl)+right` word-jump
  is dispatched *before* plain-right (`input-dispatch.ts:951`), so modified arrows never
  reach the ghost branch.

- **`isValidContinuation` must NOT be reused.** Verified: on an empty buffer
  `''.startsWith('')` is always true, so the guard degenerates to "the model said something
  non-blank" (`suggest.ts:165-168`). It validates nothing about continuation. The proposer
  needs its own validator (e.g. must match a known slash command, or pass a length/shape
  check).

### Gating — off by default

New key `interactive.idleSuggest` mirroring `interactive.suggestGhost`
(`settable-keys.ts:220`), plus `AFK_SUGGEST_IDLE` env override. Off by default because it
spends tokens while the user is not even typing — discovering that after the fact is the
failure mode that loses trust.

Cost: ~600 tok in / 32 tok out, once per turn ≈ **$0.0008/turn on Haiku**.

### Files that must change

| File | Change |
|---|---|
| `src/cli/input/idle-propose.ts` | new module |
| `src/cli/input/idle-propose.test.ts` | new tests (mirror `suggest.test.ts` injection style) |
| `src/cli/terminal-compositor.render.ts` | empty-buffer exception + distinct marker |
| `src/cli/terminal-compositor.autocomplete.ts` | proposal state, arm/disarm |
| `src/cli/terminal-compositor.input-mode.ts` | arm on `idle`, disarm on `streaming` |
| `src/cli/input/input-surface.ts` | wire proposer lifecycle to the surface |
| `src/config/env.ts` | `ENV_REGISTRY` entry + getter for `AFK_SUGGEST_IDLE` |
| `src/config/settable-keys.ts` | `interactive.idleSuggest` spec |
| `docs/env-registry.{json,md}` | regenerate via `pnpm scan:env` (CI-gated by `scan:env:check`) |
| `AFK.md` | document default-off rationale |
| `tests/pty/scenarios.ts` | add an idle-proposal PTY scenario (none exists for ghost today) |

## Risks

- **Peripheral-vision noise.** Unrequested text appearing while the user thinks is the
  top-cited reason people disable this class of feature. Mitigated by the 4 s delay,
  one-shot-per-turn, Esc-dismiss, and default-off.
- **Proposal quality.** A wrong proposal at an empty prompt is worse than a wrong completion,
  because there is no typed prefix constraining it. The tool-error signal is the main lever.
- **Non-Anthropic sessions.** `pickModel` (`suggest.ts:529`) falls back to `ctx.model`
  verbatim for non-Anthropic providers — which may be an expensive model. Pre-existing gap in
  Tier 2; an idle tier makes it worse and should fix it (prefer the `local` slot, else
  `small`/haiku).
