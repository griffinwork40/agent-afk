---
name: devils-advocate
description: "Adversarially critique a proposal by generating alternatives. Dispatches 3 parallel critics (pragmatist, paranoid, architect lenses) — each invents one alternative approach — then a synthesis step ranks all 4 options and recommends the top choice. Use when a plan, fix, scoping, decomposition, or named recommendation will drive decisions and you want structured alternative-generation before committing. Complements /shadow-verify — that skill re-derives factual claims; this one critiques whether the chosen approach itself is best."
---

## Sub-agent contract
/contract

When a proposal — a plan, fix, decomposition, scoping, or named recommendation — will drive user decisions, file edits, or commits, do NOT act on it as-given. Run a devils-advocate critique wave **before** acting, and use the recommendation as input to the decision.

**Wave 2 — Parallel critics (3 fixed lenses, independent):**
1. Extract the **proposal** (the approach being critiqued) and the **goal** (what the proposal is trying to accomplish). Both should be plain prose. Do NOT include the original proposer's reasoning or evidence — critics must invent alternatives without anchoring on the chosen path.
2. Dispatch 3 critics in parallel. **Default `subagent_type: "research-agent"`** (mechanically locked to Read/Grep/Glob/WebFetch/WebSearch — cannot Edit/Write/commit). Each critic receives ONLY the proposal + goal + ONE lens:
   - **pragmatist** — cheapest-path. "What is the cheapest approach that solves the goal? Argue why the proposal may be over-engineered."
   - **paranoid** — safest-path. "What could go wrong with the proposal? Propose a safer alternative with narrower blast radius."
   - **architect** — right-level. "Is the proposal addressing the right abstraction level? Propose an alternative one level up (systemic fix) or down (targeted fix)."
3. Each critic returns `{lens, alternative, tradeoff, strength}` where `strength ∈ {weak, medium, strong}` reflects the critic's confidence that its alternative beats the original.

**Wave 3 — Synthesis (sequential, single agent):**
1. Dispatch one synthesis agent (same research-agent base). Input: original proposal + goal + all 3 critic outputs.
2. Rank all 4 options (original + 3 alternatives) along: **cost** (implementation + ongoing), **risk** (blast radius + reversibility), **scope-fit** (how cleanly it solves the stated goal, no more), **goal-fit** (how well it addresses the underlying intent, not just the surface goal).
3. Recommend ONE top choice with a one-paragraph rationale.
4. Flag `dissent = true` when ≥2 critics returned `strong` alternatives disagreeing with the recommendation — signals the synthesizer is overruling well-argued dissent, so confidence is low. Include a `dissent_note` summarizing the strongest counter-argument.

**Merge + surface:**
- Recommendation = `original` → the proposal survived critique; proceed with it.
- Recommendation ≠ `original`, `dissent = false` → synthesis found a better path; surface the alternative with rationale before acting.
- `dissent = true` → present the matrix to the user; do not act. Confidence is low.

**When to invoke:**
Any time a proposal, plan, root-cause + fix, decomposition, or named recommendation will drive user decisions, file edits, commits, or external side-effects. Especially useful when the proposal "feels right" — that's when alternative-generation has the highest value.

**Skip when:**
- Single-line edits or trivial fixes where alternative space is empty.
- User explicitly named the chosen approach by name (critiquing a directly-requested action is friction, not signal).
- An upstream orchestrator already produced comparative output on the same claim-space (`/diagnose`'s hypothesis ranking does not need a second opinion on its hypotheses — though the *final fix* it produces can still benefit).

## Appendix: lens selection (non-binding)

V1 ships three fixed lenses; domain-specific lens packs (software-perf, research-methodology, business-risk) are V2 work. When the proposal's domain is clear, the synthesis agent may weight dimensions accordingly — but the critic lenses themselves remain fixed.

| Lens | Typical alternatives it surfaces |
|------|----------------------------------|
| pragmatist | narrower scope, simpler implementation, reuse-over-build |
| paranoid | smaller blast radius, reversibility, guardrails, staged rollout |
| architect | systemic fix one level up, targeted fix one level down, different subsystem ownership |
