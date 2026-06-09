# Agent AFK — Failure-Geometry Audit

**Date:** 2026-06-08
**Audited revision:** working tree @ `4a6eb42` (v3.89.7)
**Scope:** Runtime token budgeting, context handling, trace fidelity, control-plane enforcement, task-phase structure.
**Method:** Direct repo inspection of the token/limit/context/loop core, 3 parallel read-only reconnaissance subagents (tracing, control-plane enforcement, provider validation), and an empirical scan of **3,376 on-disk trace files** under `~/.afk/state/witness/`. Read-only: no source files were modified except this report.
**Status:** Diagnosis + proposals. No runtime or prompt changes were made.

---

## A. Executive verdict

Agent AFK's **failure geometry is shaped by absence, not by misconfiguration.** The runtime has competent mechanical plumbing — per-model caps exist, auto-compaction works, the trace schema is rich, abort/nesting/hook gating are all hard-enforced — but the **budget control plane is almost entirely un-sized and un-validated**, and the **trace control plane silently collapses distinct failure modes into one bucket**.

Three structural facts dominate:

1. **AFK requests the maximum by default and reserves nothing.** Output budget defaults to the model's *full* ceiling (128k Opus / 64k Sonnet/Haiku) via `resolveMaxTokens → maxOutputTokensFor` (`model-limits.ts:48-60`, `anthropic-direct/index.ts:921-927`), and reasoning effort defaults to `'max'` (~10× thinking depth) on every Claude-4.x model (`anthropic-direct/index.ts:1018-1032`). There is **no reservation of output room for a final summary** after thinking and tool use, and **no validation** that the requested `max_tokens` fits the model ceiling or the remaining context window. The dominant failure mode is therefore *not* truncation — it is unbounded, un-tiered, max-effort work on every task regardless of size.

2. **The main tool-use loop is uncapped by default.** `DEFAULT_MAX_TOOL_USE_ITERATIONS = 0` means "no cap" (`anthropic-direct/loop.ts:60`), and **nothing in production ever sets a cap** — `maxToolUseIterations` appears only in tests. The `--max-turns` defaults (`chat`=10, `interactive`=100) cap *user turns*, not the per-turn tool-round loop, so a single autonomous prompt can loop indefinitely, bounded only by context auto-compaction (0.90), the opt-in task budget, or manual abort.

3. **The trace cannot distinguish the failure it is supposed to record.** The `ClosureReason` enum has 7 values but `deriveClosureReason` only ever produces 4, and a code comment admits 3 are "deferred to a later commit" (`agent-session.ts:837-839`). Empirically, across **3,376 traces only two reasons ever appear**: `model_end_turn` (1180) and `abort` (182). `max_tokens` truncation has **no enum representation at all** and **zero captures** across 85,089 recorded tool calls. A truncated, capped, hook-blocked, or budget-killed run is recorded identically to a clean completion.

The control plane is **trust-the-model on behavioral policy, enforce-in-code on structural topology**: nesting depth, tool gating, hook blocks, and abort cascades are hard-checked; reversibility, terminal-state, delegation thresholds, and *all* budget sizing are prompt-only or absent.

**Fix order (detail in §F, issue drafts in §G):**
1. **Reserve output headroom + clamp `max_tokens`** to `min(ceiling, context − input − reserve)` (Issue #1). Cheapest, highest-leverage.
2. **Validate `config.maxOutputTokens`** at config load (Issue #2).
3. **Stop masking failure reasons** — emit the dead enum values and add a `truncated` reason (Issue #3).
4. **Default budget tiers by task class / surface** (Issue #4) — see §E.
5. **Default runaway guard** for the anthropic-direct loop (Issue #5).
6. **Capture tool arg/result digests + per-turn context series** in traces (Issue #6).
7. Guard thinking-budget starvation + fix stale comments (Issues #7, #8).

---

## B. Evidence table

| # | Finding | Location | Observed | Failure-geometry consequence | Confidence |
|---|---|---|---|---|---|
| F1 | Output budget defaults to the model's **full ceiling** | `model-limits.ts:48-60` (`maxOutputTokensFor`), `anthropic-direct/index.ts:921-927` (`resolveMaxTokens`) | Unset `maxOutputTokens` → `max_tokens` = 128k (Opus) / 64k (Sonnet/Haiku). `resolveMaxTokens` only floors + finite-guards; **no clamp**. | No headroom discipline. Every call advertises the max; the budget is never sized to the task. | High (read) |
| F2 | `max_tokens` sent raw to the wire | `anthropic-direct/loop.ts:242` | `max_tokens: input.maxTokens` forwarded with no reservation or recompute. | Final-summary room is whatever is left after thinking + tool text; nothing guarantees a floor. | High (read) |
| F3 | **No reservation** of output room for a final report | (absence) entire `anthropic-direct/` + `session/` path; nearest signal is post-hoc warning at `turn-handler.ts:600-605` | No code computes "reserve N tokens for the closing summary." | A long reasoning/tool run can leave too little budget for the final answer; truncation is silent. | High (read) |
| F4 | Reasoning effort defaults to **`'max'`** on all Claude-4.x | `anthropic-direct/index.ts:1018-1032` (`resolveEffort`) | `if (/(claude-)?(opus\|sonnet)-4-[678]/.test(m)) return 'max'`. Comment: `max` ≈ 10× thinking depth vs server default. | Every task — trivial or deep — pays maximum reasoning cost by default. Primary driver of excess planning / wasted work. | High (read) |
| F5 | `thinking:'enabled'` budget can **starve the answer** | `anthropic-direct/index.ts:978-985` | `budget_tokens = max(min(budgetTokens, maxTokens−1), 1024)`; with no explicit `budgetTokens`, thinking budget = `maxTokens−1`. | If a caller sets `thinking:{type:'enabled'}` without a budget, thinking may consume ~all of `max_tokens`, leaving ~1 token for the visible reply. Footgun (opt-in; default path is `adaptive`). | High (read) |
| F6 | Main tool-use loop is **uncapped by default** | `anthropic-direct/loop.ts:60` (`DEFAULT_MAX_TOOL_USE_ITERATIONS = 0`), `:187` | `0` = "no cap"; the cap branch (`:674-681`) only fires when a positive value is passed. | A single prompt can loop tools indefinitely. Backstops: auto-compact (0.90), opt-in budget, manual abort. | High (read) |
| F7 | `maxToolUseIterations` is **never set in production** | grep across `src/` — only `loop.test.ts:308,759` set it | No CLI/session path passes a cap into `runTurn`. | The cap branch and the `iteration_cap` closure reason are effectively dead code on the anthropic path. | High (read) |
| F8 | Loop-cap exit yields **no final summary turn** | `anthropic-direct/loop.ts:674-681` | On cap, emits `turn.completed` with `stopReason:'tool_use_loop_capped'` and returns — the model never gets a no-tools turn to synthesize. | When a cap *is* set, the run ends mid-action with no closing report. Incomplete final report by construction. | High (read) |
| F9 | `--max-turns` caps **user turns, not tool rounds** | `chat.ts:130` (default `'10'`), `interactive.ts:162` (default `'100'`), enforced `agent-session.ts:994-995` (throws) | `turnCount` increments per user message; the per-turn tool loop is independent (F6). | A one-shot `afk chat "do X"` is 1 turn → maxTurns provides no bound on the autonomous work inside it. | High (read) |
| F10 | **No pre-run validation** of `max_tokens` vs ceiling or context | `resolveMaxTokens` (`index.ts:921-927`); `contextLimitFor` used only for display % (`query.ts:575-579`, `openai-compatible/query.ts:807`) | No check that `max_tokens ≤ ceiling`, none that `input + max_tokens ≤ context_limit`. | An over-large `maxOutputTokens` is sent verbatim → API 400, or silently squeezes context. | High (read) |
| F11 | `config.maxOutputTokens` has **no schema/range validation** | `config-types.ts:332-339` | Plain optional `number`. JSDoc claims propagation to a "SDK subprocess as `CLAUDE_CODE_MAX_OUTPUT_TOKENS`" — **stale** (no subprocess SDK; real path is `resolveMaxTokens`). | Bad values pass through unguarded; doc misleads maintainers about the mechanism. | High (read) |
| F12 | Truncation handled only by **stripping orphaned `tool_use`** | `anthropic-direct/loop.ts:457-468` | On non-`tool_use` stop, `tool_use` blocks (e.g. "truncated by `max_tokens`") are filtered to avoid 400s. No retry, no warning, no distinct event. | A `max_tokens` truncation degrades the turn silently; downstream sees a normal `turn.completed`. | High (read) |
| F13 | `ClosureReason` enum has **7 values; only 4 reachable; 3 deferred** | `trace/types.ts:305-312`; `agent-session.ts:866-874` (`deriveClosureReason`); `agent-session.ts:837-839` (comment) | `deriveClosureReason` produces only `abort / budget_exceeded / timeout / model_end_turn`. Comment: `iteration_cap / hook_blocked / max_turns_exceeded` "deferred to a later commit." | Failure aggregation by closure reason is unreliable; capped/blocked runs masquerade as clean completions. | High (read) |
| F14 | **No `max_tokens` representation** in closure reason | `trace/types.ts:305-312` (enum), `:324-325` (raw `lastStopReason?` optional) | Truncation is recoverable only from the optional raw `lastStopReason` string, never from the AFK reason enum. | Dashboards grouping by `closure.reason` cannot see truncation at all. | High (read) |
| F15 | **Empirical:** only 2 closure reasons + **0 truncations** in 3,376 traces | scan of `~/.afk/state/witness/*/trace.jsonl` | `reason`: `model_end_turn`=1180, `abort`=182 (5 enum values never appear). `lastStopReason`: `end_turn`=959, `<absent>`=304, `stop`=67, `tool_use`=31, `tool_calls`=1. **`max_tokens`/`length` = 0.** | Confirms F13/F14 in production data: the trace plane is effectively binary (completed vs aborted). | High (measured) |
| F16 | Traces record **byte counts, not content**, for tool calls | `trace/types.ts` `tool_call` fields (`inputBytes`/`resultBytes`/`isError`/`truncated`); 85,089 `tool_call` events on disk | Tool name + sizes + error flag are captured; arguments and results are not. | A content-level failure (bad tool output, wrong arg) cannot be reconstructed from the trace alone. | High (read+measured) |
| F17 | Full session transcripts **not continuously persisted** | `~/.afk/state/sessions/*.json` (840 files; truncated tool results); compaction sidecar `trace/writer.ts` (intermittent) | REPL history persists truncated tool events; the live messages array is otherwise in-memory only. | If no compaction fires, the verbatim conversation is unrecoverable post-mortem. | Med (subagent + disk) |
| F18 | Subagent failures lose stack/cause | `subagent_lifecycle` payload (`errorClass`+`errorMessage` only) | No `.stack`, no `.cause` recorded on child failure. | Root-causing a failed delegation from the trace is limited to the message string. | Med (subagent) |
| F19 | Auto-compaction default 0.90; trigger basis is mixed | `anthropic-direct/index.ts:898` (`DEFAULT_AUTO_COMPACT_THRESHOLD = 0.9`), `query/auto-compact.ts:117-126` (`shouldAutoCompact`), `:30-31` (`computeUsedTokens` = input+output, mixed basis) | Compaction at 90% of context. `computeUsedTokens` is the fallback basis when `contextWindowTokens` is absent; comment flags it as a "mixed basis." | Context relief is late (0.90) and the fallback basis can mis-estimate; rare in practice (`compaction`=18 events / 3,376 traces). | High (read) |
| F20 | Background summarizer cap = 80 tokens **(by design)** | `background-summarizer.ts:55` (`DEFAULT_MAX_OUTPUT_TOKENS = 80`) | Haiku ≤80-token status summaries. | Correct sizing — included as the *one* place output is deliberately tiered. Not a defect. | High (read) |
| F21 | OpenAI-compatible provider diverges sharply on `max_tokens` | `openai-compatible/query.ts` streaming (omits `max_tokens`), `oneshot.ts:79` (hardcodes `64`), `:91-96` (o-series → `max_completion_tokens`) | Streaming path sends **no** output cap (server default governs); oneshot hardcodes 64. | Cross-provider behavior is inconsistent; local/unknown models fall back to 64k output ceiling + 262k context (`model-limits.ts:42,113`) which may exceed real local limits — mitigated only by the streaming path omitting the field. | Med (subagent + read) |
| F22 | Stale comment: anthropic loop "MAX_ITERATIONS (50 there)" | `openai-compatible/query.ts:84-85` | Comment claims the anthropic loop caps at 50; real value is `0` (no cap, F6). | Misleads maintainers into believing a cap exists. | High (read) |
| F23 | Only signal of truncation risk is a **cosmetic, post-hoc, REPL-only** warning | `turn-handler.ts:600-605` | When context ≥ 100%, prints "context OVER Nk tok … output may be silently truncated." | Fires *after* the turn, only on the interactive surface; absent on `chat`, daemon, Telegram, subagents. | High (read) |

### Control-plane enforcement matrix (Q6)

| Claim | Enforcement | Evidence | Note |
|---|---|---|---|
| Irreversible actions require explicit recent intent | **Prompt-only** | `prompts/system-prompt.md` (Constraints) | No PreToolUse handler inspects for destructive patterns. |
| Every turn ends in a terminal state | **Prompt-only** | `routing-directive.ts` (`END_OF_TURN_DIRECTIVE`, interactive surfaces only) | UI renders a verdict card but never rejects/re-prompts when absent. |
| Delegate when reading >3 files | **Prompt-only** | `prompts/system-prompt.md` (Delegation) | No read-call counter; model can read N files inline freely. |
| Run `/ground-state` before non-trivial impl | **Prompt-only** | `AFK.md`, routing hints | Nothing requires it before write-class tools. |
| Ordered-operation / teardown-before-setup | **Prompt-only (convention)** | `AFK.md` (pattern-card text) | No linter/test enforces source ordering. |
| Output-token / context budget guard before a run | **Soft / opt-in** | `config/env.ts:151` (`AFK_MAX_OUTPUT_TOKENS`), `:281` (`AFK_TASK_BUDGET`); warn-only at `turn-handler.ts:600-605` | No default pre-run gate. |
| Max nesting depth = 3 | **Code-enforced** | `tools/nesting.ts` (`DEFAULT_MAX_NESTING_DEPTH=3`); depth-gated tool withholding in `subagent-executor` / `skill-executor` | Enforced by withholding the `agent`/`skill` schema at depth ≥ 3. |
| `agent`/`skill` available only when executor wired | **Code-enforced** | tool dispatcher returns structured `isError` when executor absent | Hard gate. |
| Hook `decision:'block'` short-circuits a tool | **Code-enforced** | `hooks/hook-registry.ts` (`isBlocking` throws `HookBlockedError`); dispatcher returns `isError`, handler never runs | Fail-safe: handler errors treated as blocks. |
| Abort cascade (parent → children) | **Code-enforced** | `abort-graph.ts` (`linkChild` BFS cascade); every fork wired into the tree | Child abort never auto-aborts parent (notify-only). |

> Control-plane rows below the divider are corroborated by the prior `orchestration-pressure-audit.md` and a dedicated subagent pass; the structural mechanisms (depth, gating, hook block, abort) were independently cited there. Confidence: high on direction, medium on exact line numbers not personally re-read.

---

## C. Failure taxonomy

Four geometries, ordered by how often the audit evidence implicates them.

**G1 — Un-tiered maximalism (most common).** Default config = max output ceiling (F1) + `effort:'max'` (F4) + uncapped tool loop (F6) on *every* task. Trivial tasks pay deep-reasoning cost; investigation tasks loop without a ceiling. This is the "high token limits cause rambling / excess planning / wasted work" axis (Q2). It rarely *errors* — it wastes time and money and dilutes output quality.

**G2 — Silent truncation / starvation (rare but invisible).** No output reservation (F3), thinking can eat the budget (F5), truncation is handled by stripping (F12) with no retry/warn, and the only signal is a cosmetic REPL-only post-hoc print (F23). Empirically rare *because* `max_tokens` is set so high (F15: 0 truncations in 3,376 traces) — but when it happens it is undetectable from the trace.

**G3 — Phase-structure starvation (latent).** If a tool-loop cap were set, the run would end mid-action with no synthesis turn (F8). Today this is latent because no cap is set in production (F7), but it is a designed-in hazard the moment anyone enables a cap. Inverse of G1: too tight a phase boundary starves the final report.

**G4 — Trace blindness (systemic).** The control plane that should let you *tell these apart* collapses them: 3 enum reasons never fire, `max_tokens` has no reason at all, tool content is byte-counts-only, transcripts aren't durably persisted, subagent failures lose stack/cause (F13–F18). Every other failure becomes harder to diagnose because the recorder can't name it.

---

## D. Answers to the audit questions

**Q1 — Where can max-token limits cause starvation, truncation, or incomplete final reports?**
Three sites. (a) No output reservation (F3) + raw send (F2): a long reasoning/tool turn can leave too little for the closing summary, truncated silently (F12). (b) `thinking:'enabled'` without an explicit budget sets thinking to `maxTokens−1`, starving the visible answer (F5) — opt-in footgun. (c) A tool-loop cap, *if set*, terminates with no synthesis turn (F8). In production today, (c) is latent (F7) and (a)/(b) are rare because `max_tokens` defaults to the ceiling (F15).

**Q2 — Where can high token limits cause rambling, excess planning, or wasted work?**
The default configuration is maximalist on every axis at once: full output ceiling (F1), `effort:'max'` ≈ 10× thinking depth (F4), and an uncapped tool-use loop (F6, F7) bounded only by 0.90 auto-compaction (F19) or manual abort. `--max-turns` does not help — it bounds user turns, not the work inside a single autonomous prompt (F9). This is the primary, ever-present failure geometry.

**Q3 — Does AFK reserve output room for final summaries after reasoning/tool use?**
**No.** There is no reservation logic anywhere on the anthropic-direct or session path. `max_tokens` is resolved once to the ceiling (F1) and sent raw (F2); thinking budget can consume nearly all of it (F5). The only output that is deliberately sized is the 80-token background summarizer (F20).

**Q4 — Are provider limits validated before runs?**
**No.** `resolveMaxTokens` floors and finite-guards but never clamps to the model ceiling or checks `input + max_tokens ≤ context_limit` (F10). `config.maxOutputTokens` has no schema/range validation and a stale JSDoc (F11). `contextLimitFor` is used only for display percentages, never as a gate (F10, F23). The OpenAI-compatible provider diverges further (omits the field in streaming; hardcodes 64 in oneshot; 64k/262k fallbacks for unknown local models — F21).

**Q5 — Do traces capture enough to reconstruct failures?**
**Partially — timeline yes, root cause no.** Recoverable: terminal status, tool-call sequence (names/sizes/error flags), abort origin + cascade, compaction events, latency waterfall. **Not** recoverable: tool arguments/results content (F16), top-level model id, per-turn context pressure, subagent stack/cause (F18), and — critically — *which* failure occurred: the closure reason is effectively binary (F13–F15), `max_tokens` truncation has no representation (F14) and zero captures (F15), and verbatim transcripts aren't durably persisted (F17).

**Q6 — Which control-plane claims are code-enforced vs prompt-only?**
**Code-enforced (structural topology):** nesting depth (3), `agent`/`skill` gating by executor wiring, hook `decision:'block'`, abort cascade. **Prompt-only or absent (behavioral policy & budgets):** irreversible-action intent, terminal-state mandate, delegation threshold, ground-state-first, ordered-operations, and *all* output/context budget sizing (soft, opt-in env vars only). See the §B matrix.

**Q7 — What should be changed first?**
See §A fix order and §F. First mover: **reserve output headroom and clamp `max_tokens`** to `min(ceiling, context − input − reserve)` (Issue #1) — it is a localized change in `resolveMaxTokens` / the query builder, closes G2, and is the precondition for tiering (G1).

---

## E. Recommended default budget tiers

Sizing should be a function of **task class** and **surface**, not a single global maximum. Proposed tiers (tunable; the point is that *a* policy exists):

| Tier | Use case | `max_tokens` | Reserved final (hard floor) | Effort / thinking | Auto-compact | Tool-loop cap |
|---|---|---|---|---|---|---|
| **T0 micro** | classification, routing, yes/no, ≤80-tok summaries | 512 | n/a | none | n/a | 4 |
| **T1 standard** | single-file edit, focused Q&A, tool-light turns | 4,000 | 1,000 | default (none/low) | 0.85 | 16 |
| **T2 deep** | multi-file investigation, synthesis, refactor planning | 16,000 | 4,000 | high | 0.80 | 40 |
| **T3 report** | audits/specs/deliverables where completeness matters | 32,000 | 8,000 | high | 0.75 | 60 |
| **Subagent** | compressed-finding return (output-schema bounded) | 4,000 | 1,000 | sized to task | 0.85 | per `max_turns` |

**Invariants the tiers should enforce in code (not prompt):**

1. `effective_max_tokens = min(model_ceiling, context_limit − current_input_tokens − reserved_final)`.
2. `thinking.budget_tokens ≤ effective_max_tokens − reserved_final` (never let thinking eat the reservation — fixes F5).
3. If `effective_max_tokens < reserved_final`, **compact or abort before the call** rather than truncating after (fixes F3/G2).
4. Default the *main* session to **T2** and `effort` to model default (not `'max'`); reserve `'max'` for explicit deep tasks (fixes F4/G1).
5. The background summarizer (T0-like, F20) already follows this shape — generalize it.

Defaults should be overridable via `afk.config.json` / `AFK_*` env, but the *default* must be a sized tier, not the ceiling.

---

## F. Recommended fix sequence

1. **Reserve + clamp** (Issue #1) — localized in `resolveMaxTokens` + query builder. Closes G2; enables tiering.
2. **Validate config** (Issue #2) — Zod/range check at config load; fix the stale JSDoc.
3. **Un-mask failures** (Issue #3) — emit the 3 deferred enum reasons, add a `truncated` reason, populate it from `stop_reason`/`finish_reason`. Closes G4's worst gap.
4. **Tier the budget** (Issue #4) — implement §E; flip the `effort:'max'` default.
5. **Runaway guard** (Issue #5) — a sane default tool-loop ceiling with a synthesis turn on cap (fixes F6 + F8 together).
6. **Trace fidelity** (Issue #6) — tool arg/result digests + per-turn context series.
7. **Thinking-budget guard + doc cleanup** (Issues #7, #8).

---

## G. GitHub issue drafts

### Issue #1 — Reserve output headroom and clamp `max_tokens` to the context budget
**Labels:** `runtime`, `reliability`, `priority:high`
**Problem.** `resolveMaxTokens` (`src/agent/providers/anthropic-direct/index.ts:921-927`) defaults `max_tokens` to the model's full ceiling (`maxOutputTokensFor`, `src/agent/model-limits.ts:48-60`) and sends it raw (`loop.ts:242`). Nothing reserves room for a final summary or checks the value against the remaining context window. A long reasoning/tool turn can be truncated silently (`loop.ts:457-468` strips orphaned `tool_use` with no warning).
**Proposal.** Compute `effective_max_tokens = min(model_ceiling, context_limit − current_input_tokens − RESERVED_FINAL)` in the query builder; clamp before the wire call. If the result is below `RESERVED_FINAL`, trigger compaction or abort *before* the call rather than truncating after.
**Acceptance.** Unit test: an input near the context limit yields a clamped `max_tokens` ≥ `RESERVED_FINAL`; a final-summary turn always has at least `RESERVED_FINAL` available. No behavior change when input is small.
**Refs.** F1, F2, F3, F10, F12.

### Issue #2 — Validate and clamp `config.maxOutputTokens`; fix stale JSDoc
**Labels:** `config`, `validation`
**Problem.** `maxOutputTokens` is a plain optional `number` (`src/agent/types/config-types.ts:332-339`) with no range/schema check; over-large values are sent verbatim → API 400. The JSDoc still claims propagation to a "SDK subprocess as `CLAUDE_CODE_MAX_OUTPUT_TOKENS`" — stale; the real path is `resolveMaxTokens`.
**Proposal.** Add a Zod/range validation at config load: positive integer, clamp to the resolved model ceiling with a warning when exceeded; keep the `POSITIVE_INFINITY` "model max" sentinel explicit (today it works only by the `Number.isFinite` fall-through). Rewrite the JSDoc to describe the direct-provider path.
**Acceptance.** Invalid/over-ceiling values are clamped with a logged warning; sentinel still resolves to the ceiling; doc matches code.
**Refs.** F11, F1.

### Issue #3 — Stop masking failure reasons in the closure trace
**Labels:** `tracing`, `observability`, `priority:high`
**Problem.** `ClosureReason` (`src/agent/trace/types.ts:305-312`) declares 7 values but `deriveClosureReason` (`src/agent/session/agent-session.ts:866-874`) emits only 4; a comment (`:837-839`) admits `iteration_cap`/`hook_blocked`/`max_turns_exceeded` are "deferred." There is **no** reason for `max_tokens` truncation. Empirically, across 3,376 on-disk traces only `model_end_turn` (1180) and `abort` (182) ever appear, and `max_tokens`/`length` truncation has zero captures.
**Proposal.** Wire the 3 deferred reasons from their origin sites (loop-cap → `iteration_cap`, hook block → `hook_blocked`, turn-cap throw → `max_turns_exceeded`); add a `truncated` reason and populate it when `stop_reason`/`finish_reason ∈ {max_tokens, length}`. Keep raw `lastStopReason` as-is.
**Acceptance.** Each path emits its distinct reason in a unit test; a forced `max_tokens` stop records `reason:'truncated'`.
**Refs.** F13, F14, F15.

### Issue #4 — Introduce default budget tiers; flip the `effort:'max'` default
**Labels:** `runtime`, `cost`, `quality`
**Problem.** Defaults are maximalist on every axis: full output ceiling (F1) + `effort:'max'` ≈ 10× thinking (`src/agent/providers/anthropic-direct/index.ts:1018-1032`) + uncapped tool loop (F6). Trivial tasks overpay; the only deliberately-tiered path is the 80-token background summarizer (`background-summarizer.ts:55`).
**Proposal.** Implement the tier table in the audit (§E) keyed by task class/surface; default the main session to a "deep" tier and `effort` to the model default; reserve `'max'` for explicit deep work. Make tiers overridable via config/env.
**Acceptance.** Each surface/skill resolves to a named tier; `effort:'max'` is opt-in; background summarizer keeps its sizing.
**Refs.** F1, F4, F6, F20, §E.

### Issue #5 — Default runaway guard for the anthropic-direct tool loop, with a synthesis turn on cap
**Labels:** `runtime`, `reliability`
**Problem.** `DEFAULT_MAX_TOOL_USE_ITERATIONS = 0` (`src/agent/providers/anthropic-direct/loop.ts:60`) = no cap, and nothing in production sets one (`maxToolUseIterations` appears only in tests). When a cap *is* set, the loop ends mid-action with no final summary (`loop.ts:674-681`). A stale comment in the OpenAI-compatible provider (`query.ts:84-85`) claims the anthropic loop caps at 50.
**Proposal.** Set a sane default ceiling (tier-dependent, §E); on cap, issue **one final no-tools turn** so the model can synthesize before `turn.completed`. Fix the stale comment.
**Acceptance.** A loop that hits the cap produces a non-empty final assistant message and `reason:'iteration_cap'` (Issue #3); comment matches reality.
**Refs.** F6, F7, F8, F22.

### Issue #6 — Capture tool arg/result digests and a per-turn context-pressure series in traces
**Labels:** `tracing`, `observability`
**Problem.** `tool_call` events record byte counts and an error flag but not arguments/results (`src/agent/trace/types.ts`), so content-level failures can't be reconstructed (85,089 such events on disk carry no content). There is no per-turn context-window series, and subagent failures lose stack/cause.
**Proposal.** Add bounded, secret-redacted digests of tool args/results (reuse the redactor in `background-summarizer.ts`); emit a per-turn `context_pressure` sample (used/limit); record `errorStack`/`cause` on subagent-lifecycle failures.
**Acceptance.** A failed run's trace lets an engineer identify the failing tool call's inputs and the context level at failure; digests are size-bounded and redacted.
**Refs.** F16, F17, F18, F19.

### Issue #7 — Guard against thinking-budget starvation
**Labels:** `runtime`, `footgun`
**Problem.** For `thinking:{type:'enabled'}` without an explicit `budgetTokens`, `budget_tokens` defaults to `maxTokens−1` (`src/agent/providers/anthropic-direct/index.ts:978-985`), which can consume nearly the entire output budget and starve the visible reply.
**Proposal.** Clamp `budget_tokens ≤ effective_max_tokens − RESERVED_FINAL` (depends on Issue #1); warn when a caller-supplied budget would breach the reservation.
**Acceptance.** With `thinking:'enabled'` and no explicit budget, the final answer always retains ≥ `RESERVED_FINAL` tokens.
**Refs.** F5, F3.

### Issue #8 — Reconcile OpenAI-compatible provider `max_tokens` behavior
**Labels:** `provider:openai-compatible`, `consistency`
**Problem.** The streaming path omits `max_tokens` entirely while oneshot hardcodes `64` (`src/agent/providers/openai-compatible/oneshot.ts:79,91-96`); unknown local models fall back to 64k output / 262k context (`model-limits.ts:42,113`), which can exceed real local limits. Behavior diverges from the anthropic path.
**Proposal.** Apply the same tiered/clamped `max_tokens` resolution (Issues #1, #4) to the OpenAI-compatible streaming path, honoring `max_tokens` vs `max_completion_tokens` per model family; document the local-model fallback risk.
**Acceptance.** Both providers resolve output budget through one tiered/clamped policy; o-series still receives `max_completion_tokens`.
**Refs.** F21.

---

## H. Method, confidence, and what was not checked

**Method.** Primary token/limit/context/loop findings (F1–F14, F19–F23) were read directly from source at the cited lines. F15–F16 are measured from a scan of all 3,376 `~/.afk/state/witness/*/trace.jsonl` files. F17–F18 and the lower half of the control-plane matrix are from a dedicated read-only subagent pass, corroborated where possible by direct reads and the prior `orchestration-pressure-audit.md`.

**Confidence.** High on the budget/loop/closure core (read + measured). Medium on exact line numbers for control-plane mechanisms not personally re-opened (depth/gating/hook/abort) and on transcript-persistence specifics (F17).

**Not checked.** (1) The full `stream-consumer.ts` path that maps provider `stop_reason` → `lastStopReason` (verified populated at `agent-session.ts:294-298,862`, not traced end-to-end). (2) Daemon scheduler per-task budget/abort wiring. (3) `compose` DAG node-budget interaction with these limits. (4) Whether any MCP server independently gates action categories. (5) The Responses-API streaming path (if present) for `max_tokens`. (6) CLI `--max-output-tokens` flag parsing (only the env/config path was traced). (7) Live reproduction of a `max_tokens` truncation — inferred absent from the corpus, not forced.
