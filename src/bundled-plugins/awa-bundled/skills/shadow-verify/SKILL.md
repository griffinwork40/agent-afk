---
name: shadow-verify
description: "Dispatch a parallel adversarial verifier wave after any high-stakes sub-agent investigation (code reviews, audits, findings reports, large refactors, gap analyses) — or whenever a sub-agent asserts a claim with high-confidence language (\"confident\", \"certain\", \"clearly\", ≥80%), since confidence is a trigger, not a verdict. Shadow verifiers independently re-derive 2–3 key claims from scratch using tool calls only, returning CONFIRMED/REFUTED/STALE/UNVERIFIABLE, and flag disagreements before the user acts. Use when sub-agent output will drive decisions, file changes, commits, or external side-effects."
context: load
---

## Sub-agent contract
/contract

When a sub-agent (or wave) returns investigation findings, code-review conclusions, audit claims, refactor plans, gap-analysis results, or counts that will drive user decisions or file changes, do NOT surface the report. Instead, run a shadow verification wave **before** merging.

### Pre-flight: claim normalization and scale guard

Before dispatching verifiers, the coordinating agent normalizes each claim to a canonical form:

```
[CLAIM_ID] <subject> :: <predicate> :: <evidence_ref>
```

`evidence_ref` must be a concrete pointer — a file path, line number, git ref, config key, or API endpoint. Claims that cannot be anchored to a concrete `evidence_ref` are classified **`UNVERIFIABLE`** immediately and removed from the verification queue. They are preserved in the final output under a dedicated section with the reason they could not be anchored (no re-derivation sub-agent is dispatched for them).

**Scale cap:** if the normalized claim list exceeds 50 items, the coordinating agent halts and asks the operator to scope the investigation before proceeding. Verification at scale degrades into noise; a 50-item cap prevents a finding flood from becoming an echo-chamber rubber-stamp.

Select 2–3 of the highest-stakes normalized claims to send to the verifier wave. Prefer claims that are (a) decision-driving, (b) expressed with high-confidence language, or (c) hard to re-derive from a single artifact.

---

**Wave 2 — Adversarial verifiers (parallel, independent):**
1. Extract 2–3 concrete, re-checkable claims from the returned report (e.g., "X function is unused", "file Y exceeds 300 lines", "PR targets main", "no tests cover Z") and normalize them to `[CLAIM_ID] subject :: predicate :: evidence_ref` form as described above.
2. Dispatch one shadow sub-agent per claim, in parallel. Each receives the normalized claim text + the user's original goal + **the search surface** — the inventory of files, directories, or URLs the original investigation touched. It must NOT receive the original agent's reasoning, verdict, confidence language, or the specific line/region it concluded from. **Withhold the conclusion, not the map.** Withholding the map too does not buy extra independence — the verifier still has to reach the same evidence, it just spends its budget guessing paths to get there. Measured: one verifier denied the inventory spent 70 `grep` + 18 `read_file` calls re-locating files the parent already had paths for, guessed 5 nonexistent paths on the way, and hit its tool-loop ceiling before finishing. The independence that matters is epistemic (re-deriving the verdict), not navigational.
   - The inventory is a **starting surface, not a boundary**: it does not satisfy the composition-axis guard below, and a verifier that reads only inside it still returns `evidence_base: artifact-internal`. At least one primary source outside that surface is still required for `independent-rederivation`.
   - **Default to `subagent_type: "research-agent"` (mechanically locked to Read/Grep/Glob/WebFetch/WebSearch — cannot Edit/commit/push).** If the claim requires Bash to verify (running a failing test, `gh pr view`, `git log origin/...`), fall back to a Bash-capable subagent type with `isolation: "worktree"` and prepend this prefix to the prompt: *"Verifier sub-agent — do not Edit, Write, commit, push, `gh pr create`, or `curl`. Return findings only."*
   - **Every verifier dispatch carries an explicit budget** — `max_tool_use_iterations` (a wave of 2–3 claim checks needs ~15–25 rounds each, not 50) plus the cheapest sufficient model. An unbudgeted verifier does not fail loudly: it exhausts the default tool-round ceiling, terminates `stopReason: "tool_use_loop_capped"`, and emits its verdict from a tools-stripped wind-down round built on partial evidence. A `CONFIRMED` produced that way is indistinguishable from a real one and silently defeats the entire point of the wave. Check each returned verifier's stop reason before merging its verdict; treat a capped or wind-down verifier as `UNVERIFIABLE`, not as a verdict.
3. Each verifier re-derives the verdict independently using tool calls only — never re-reading the original report's reasoning. Returns `{claim_id, verifier_verdict, evidence_pointer, evidence_base}`, where `verifier_verdict` is one of `CONFIRMED`, `REFUTED`, `STALE`, or `UNVERIFIABLE`, and `evidence_base` is `independent-rederivation` (read primary sources *outside* the cited artifact's boundary) or `artifact-internal` (re-read only the cited file/region). On `REFUTED` or `STALE`, the verifier also emits a corrected or updated finding.

---

**Merge:**
- `CONFIRMED` → surface the claim as validated.
- `REFUTED` → replace the claim with the verifier's corrected finding, annotated `[was: confident, now: refuted]`, and show it alongside the original with evidence. Do not act until the conflict is resolved.
- `STALE` → the claim was true at some prior point but no longer holds. Surface annotated `[was true, now stale]` with the verifier's updated finding. Do not forward the original claim downstream; re-investigate if currency matters for the decision.
- `UNVERIFIABLE` → surface with a `[needs-human-review]` tag rather than passing it through silently. This includes both pre-flight unanchorable claims and claims a verifier could not resolve after exhausting its evidence surface.
- **Budget-exhausted verifier** (`stopReason` of `tool_use_loop_capped` / `soft_deadline_wind_down`, or a `timeout`/`429` failure) → its verdict was produced without finishing the evidence gathering, so it is not a verdict. Downgrade to `UNVERIFIABLE [budget-exhausted]` and re-dispatch that one claim with a narrower scope and the search surface attached; this re-dispatch counts as the next verification round (and must respect the invoking workflow's round budget — e.g. `/review` permits one round with no repeats). If the loop cap (3 rounds total) is already reached, or the caller's budget forbids another round, escalate to the user instead of re-dispatching. Never merge a capped `CONFIRMED`.

*The two verdicts below are **not** emitted by individual verifiers — they are produced by the Composition-axis guard (defined below) and handled here:*
- `UNVERIFIED-COMPOSITION` → surface with `[needs-human-review: composition boundary unchecked]`; do not act until a boundary read confirms or refutes the claim.
- `UNVERIFIED-ECHO-CHAMBER` → surface with `[needs-human-review: echo-chamber suspected]`; require at least one verifier to re-derive from outside the cited artifact before acting.

Bound the loop: at most 3 verification rounds per session. Claims still unresolved after 3 rounds are escalated to the user, never silently dropped.

---

**Gate verdict:**

After all verifier results are merged, the coordinating agent emits a single gate verdict before surfacing findings downstream:

| Verdict | Condition |
|---|---|
| `PASS` | All verifiable claims confirmed; findings may proceed downstream |
| `WARN` | One or more claims are `STALE`, `UNVERIFIABLE`, or `UNVERIFIED-COMPOSITION`/`UNVERIFIED-ECHO-CHAMBER`; proceed only with explicit caveats attached |
| `FAIL` | One or more claims `REFUTED`; findings must not be forwarded until re-investigated |

A `FAIL` verdict blocks downstream use. The coordinating agent surfaces the specific refuted claims and their contradicting evidence to the operator before any remediation work begins. A `WARN` may proceed but must carry the flagged claims and their tags — stripping the caveats before forwarding is a protocol violation.

---

**Composition-axis guard (echo-chamber check):**
A verifier that re-derives a claim by re-reading the *same* file/region the original sub-agent cited has confirmed the citation, not the claim — it can be blind to composition-boundary failures (temporal interleaving, state threading, render/event-pipeline ordering, scrollback/call-graph adjacency) that only manifest outside the artifact's boundary. Before accepting a `CONFIRMED`:
1. Read each verifier's `evidence_base`.
2. For any **artifact-internal `CONFIRMED`**, require one composition-boundary read (≥1 upstream caller + ≥1 downstream consumer, plus the pipeline that interleaves the artifact with siblings) before merging. If a missed boundary surfaces, downgrade to `UNVERIFIED-COMPOSITION` and tag `[needs-human-review]`. (An artifact-internal `REFUTED` is intentionally exempt: a refutation already halts action under the Merge rule above, so its boundary-blindness cannot drive a wrong commit — the asymmetry is safe by construction.)
3. **Echo-chamber guard:** if ≥2 verifiers cite the *same* in-repo artifact as primary evidence with no external referent, flag `UNVERIFIED-ECHO-CHAMBER` regardless of verdict and require one verifier to read outside that artifact's boundary. If the 3-round loop cap is already exhausted when this fires, escalate to the user as `UNVERIFIED-ECHO-CHAMBER [loop-cap-reached]` — do not dispatch a new round.

**Scope guard:** skip the composition check when the claim cites an external referent (RFC, spec, threat model, upstream-API contract) that survives independently of the repo, or when the artifact is purely local with no composition surface. Runs once per artifact, not on every cite.

---

**When to invoke:**
Any time sub-agent output will drive user decisions, file edits, commits, external side-effects, or is the basis of a user-facing summary — including gap analyses, audit findings, and issue lists that will be forwarded to a downstream session. Treat **high-confidence language as a trigger in its own right**: when a review/audit sub-agent asserts a claim with markers like "confident", "certain", "clearly", "obviously", "must be", or a stated probability ≥ 80%, verify it as if it were decision-driving regardless of stakes. Confidence is a trigger, not a verdict.

**Skip when:**
Sub-agent ran inside an orchestrator skill that already verifies (`resolve`, `diagnose`, `appmap`); sub-agent returned explicit failure; work was purely exploratory and no decision follows; or the session is **text-terminal** — a pure explanation, architecture walkthrough, onboarding Q&A, or capability map that names no mutated artifact (file/PR/commit/test), where there are no re-checkable state claims for adversarial verifiers to re-derive (assess coverage, coherence, and citation density instead of dispatching re-derivation sub-agents).

## Appendix: verification methods by domain (non-binding)

Reference aid for choosing re-derivation methods when dispatching a verifier. Consult when the claim's domain isn't obvious.

| Domain | Re-derivation methods |
|--------|----------------------|
| `software` | Grep, Read, test runs, git commands (`gh pr view`, `git log`, `git diff`), build output |
| `research` | Web search for citation verification, independent literature re-search, replication/methodology audit, cross-reference checks |
| `design` | Competitive audit via web search, heuristic evaluation against stated criteria, accessibility/usability re-assessment |
| `business` | Market comp search, independent financial/metric re-derivation, assumption stress-test via web research |
| *(other)* | Web search re-derivation, independent source verification, assumption audit — use whatever tools can independently check the claim |

When domain is unspecified, infer from the claim content.
