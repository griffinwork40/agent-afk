---
name: devils-advocate
description: "Adversarially critique a proposal by generating alternatives. Dispatches 3 parallel critics (pragmatist, paranoid, architect lenses) — each invents one alternative approach — then a synthesis step ranks all 4 options and recommends the top choice. When the proposal was authored by someone other than the agent (inherited plan, someone else's PR, external review), a 4th steelman critic runs in the same parallel wave and strengthens the original first, so it is judged at its strongest rather than its weakest. Use when a plan, fix, scoping, decomposition, or named recommendation will drive decisions and you want structured alternative-generation before committing. Complements /shadow-verify — that skill re-derives factual claims; this one critiques whether the chosen approach itself is best."
context: load
---

## Sub-agent contract
/contract

When a proposal — a plan, fix, decomposition, scoping, or named recommendation — will drive user decisions, file edits, or commits, do NOT act on it as-given. Run a devils-advocate critique wave **before** acting, and use the recommendation as input to the decision.

**Wave 2 — Parallel critics (3 fixed lenses + 1 conditional, independent):**
1. Extract the **proposal** (the approach being critiqued) and the **goal** (what the proposal is trying to accomplish). Both should be plain prose. Do NOT include the original proposer's reasoning or evidence — critics must invent alternatives without anchoring on the chosen path.
2. Dispatch 3 critics in parallel. **Default `subagent_type: "research-agent"`** (mechanically locked to Read/Grep/Glob/WebFetch/WebSearch — cannot Edit/Write/commit). Each critic receives ONLY the proposal + goal + ONE lens:
   - **pragmatist** — cheapest-path. "What is the cheapest approach that solves the goal? Argue why the proposal may be over-engineered."
   - **paranoid** — safest-path. "What could go wrong with the proposal? Propose a safer alternative with narrower blast radius."
   - **architect** — right-level. "Is the proposal addressing the right abstraction level? Propose an alternative one level up (systemic fix) or down (targeted fix)."
3. Each critic returns `{lens, alternative, tradeoff, strength}` where `strength ∈ {weak, medium, strong}` reflects the critic's confidence that its alternative beats the original.
4. **Conditional 4th critic — steelman.** Fires **only when the proposal is externally-authored**: an inherited plan, someone else's PR, an external review, or third-party text the user pasted in. It does **not** fire on a proposal the agent authored itself this session — there the proposer's reasoning is already in main context and strengthening is a no-op that taxes the hottest call path. When it fires, dispatch it **in the same parallel wave** as the other three (never before them), on the same `research-agent` base, receiving ONLY the proposal + goal + the steelman lens — the closed input set of step 2 is unchanged, and no critic ever sees another critic's output.
   - **steelman** — strongest-version. "Restate this proposal as its strongest defensible version. Fill in assumptions its author left implicit, supply the evidence that would best support it, and drop claims too weak to defend. Do not critique it and do not propose an alternative."
5. The steelman returns `{strengthened_original, gaps_filled, weak_claims_dropped}` — deliberately **not** the `{lens, alternative, tradeoff, strength}` shape. It is an annotation on the original, never a competing option, so it does not enter the ranking as a 5th candidate and does not carry a `strength` score.

**Invariant (why steelman sits *inside* Wave 2, not before it):** a steelman is by construction the proposer's reasoning and evidence, reconstructed and amplified — the single most anchoring artifact obtainable. Routing it upstream of the other critics would hand them a hardened target and violate step 1's prohibition, converting invention into rebuttal. Keeping it a peer in the parallel wave preserves critic independence, which is what makes convergence (Wave 3.5) and `dissent` (Wave 3) informative at all. Never promote it to a pre-wave.

**Wave 3 — Synthesis (sequential, single agent):**
1. Dispatch one synthesis agent (same research-agent base). Input: original proposal + goal + all 3 critic outputs, plus the steelman annotation when Wave 2 produced one.
2. Rank all 4 options (original + 3 alternatives) along: **cost** (implementation + ongoing), **risk** (blast radius + reversibility), **scope-fit** (how cleanly it solves the stated goal, no more), **goal-fit** (how well it addresses the underlying intent, not just the surface goal). When a steelman annotation is present, score the **original at its strengthened form** — the point is to beat the proposal at its best, not to win against a version its author would disown. The candidate count stays 4: the annotation upgrades how `original` is judged, it does not add an option.
3. Recommend ONE top choice with a one-paragraph rationale.
4. Flag `dissent = true` when ≥2 critics returned `strong` alternatives disagreeing with the recommendation — signals the synthesizer is overruling well-argued dissent, so confidence is low. Include a `dissent_note` summarizing the strongest counter-argument.

**Wave 3.5 — Composition-boundary check (fires on convergence):**
Critics that converge may all have evaluated the proposal in artifact-isolation — none read the boundaries where it composes with siblings. A convergent verdict reached in isolation can be confidently wrong (e.g., critics agree on a UI glyph asserting visual continuity, but none saw that parallel-branch flushes reorder it). When the synthesis recommendation is **convergent** — recommendation ≠ original with ≥2 critics having returned the same alternative — dispatch ONE context-injection verifier (**`subagent_type: "research-agent"`** — Read/Grep/Glob/WebFetch only, no Edit/commit) BEFORE surfacing:
1. Its job is NOT to re-evaluate the proposal in isolation. It reads the 3 nearest composition boundaries — upstream caller, downstream consumer, and the render/event/state pipeline that interleaves the proposal's target with siblings.
2. For each boundary: does the recommendation survive when the boundary varies? Check **temporal interleaving** (can flushes / parallel branches / sibling completions reorder it?), **state threading** (does it assume a point-of-use state upstream can break?), **adjacency assumptions** (does it presume render-tree / scrollback / call-graph adjacency that isn't load-bearing under recomposition?).
3. Returns `CONFIRMED` only if the recommendation survives all three; otherwise `OVERRIDE: <specific boundary condition that breaks it>`. (These verdicts are internal to Wave 3.5 — distinct from shadow-verify's verifier verdict vocabulary.)

Until the verifier returns `CONFIRMED`, the convergent recommendation is a **candidate**, not a recommendation. On `OVERRIDE`, fold the named condition into the matrix and re-rank. **Cap:** if `OVERRIDE` recurs after 2 re-ranks, escalate the full composition failure to the user rather than cycling further — the matrix cannot resolve a boundary violation on its own.

**Scope guard:** skip when the proposal is purely local with no composition surface, or is anchored to an external referent that survives independently of the system. Does not fire when `dissent = true` — that path surfaces the matrix directly; adding a Wave 3.5 gate on already-uncertain output adds friction without signal. Fires once per convergent verdict, not per critic.

**Merge + surface:**
- Recommendation = `original` → the proposal survived critique; proceed with it. **With a steelman annotation present, the strengthened form is what survived and is therefore what you proceed with** — it is the artifact Wave 3 actually scored, and executing the verbatim text instead would run a version that never won: one that can omit a prerequisite the steelman made explicit, or reinstate a claim it dropped as indefensible. Rank and execute must name the same artifact. Surface it **as** the strengthened version, with `gaps_filled` (assumptions the proposal depends on but never stated) and `weak_claims_dropped` (claims too weak to defend) shown as an explicit delta against what the user wrote, so they can see exactly what changed and reject it if they disagree. The substitution must be **visible, never silent** — do not present strengthened text as if it were the user's verbatim proposal. With no steelman annotation, `original` is the verbatim proposal and proceeds unchanged.
- Recommendation ≠ `original`, `dissent = false`, ≥2 critics returned the same alternative → convergent path: run Wave 3.5, then surface the alternative with rationale (on `OVERRIDE`, re-rank first) before acting.
- Recommendation ≠ `original`, `dissent = false`, only 1 critic backed the winner → no convergence to guard: surface the alternative with rationale directly (Wave 3.5 does not fire).
- `dissent = true` → present the matrix to the user; do not act. Confidence is low.

**When to invoke:**
Any time a proposal, plan, root-cause + fix, decomposition, or named recommendation will drive user decisions, file edits, commits, or external side-effects. Especially useful when the proposal "feels right" — that's when alternative-generation has the highest value.

**Skip when:**
- Single-line edits or trivial fixes where alternative space is empty.
- User explicitly named the chosen approach by name (critiquing a directly-requested action is friction, not signal).
- An upstream orchestrator already produced comparative output on the same claim-space (`/diagnose`'s hypothesis ranking does not need a second opinion on its hypotheses — though the *final fix* it produces can still benefit).
- The **steelman critic specifically** no-ops when the agent authored the proposal itself this session — the common plan-mode path ("form a candidate plan → apply adversarial pressure"). The other three lenses still run; only the 4th is skipped. Strengthening your own just-written plan restates context you already hold.

## Appendix: lens selection (non-binding)

Three fixed adversarial lenses always run, plus the conditional steelman; domain-specific lens packs (software-perf, research-methodology, business-risk) are V2 work. When the proposal's domain is clear, the synthesis agent may weight dimensions accordingly — but the critic lenses themselves remain fixed.

| Lens | Typical alternatives it surfaces |
|------|----------------------------------|
| pragmatist | narrower scope, simpler implementation, reuse-over-build |
| paranoid | smaller blast radius, reversibility, guardrails, staged rollout |
| architect | systemic fix one level up, targeted fix one level down, different subsystem ownership |
| steelman *(conditional)* | no alternative — returns the original at its strongest, plus the unstated assumptions it depends on and the weak claims worth dropping |

Note that the three adversarial lenses are all oppositional: each asks some form of "what would be better?" The steelman is the only lens that moves the other way, which is why it returns a different shape and is scored differently. If a future lens pack adds more stances, check which direction each one points before assuming it can reuse the `{alternative, tradeoff, strength}` contract.
