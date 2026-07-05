---
name: shadow-verify
description: "Dispatch a parallel adversarial verifier wave after any high-stakes sub-agent investigation (code reviews, audits, findings reports, large refactors) — or whenever a sub-agent asserts a claim with high-confidence language (confident, certain, clearly, ≥80%), since confidence is a trigger, not a verdict. Shadow verifiers independently re-derive 2–3 key claims from scratch using tool calls only, returning CONFIRMED/REFUTED/UNVERIFIABLE, and flag disagreements before the user acts. Use when sub-agent output will drive decisions, file changes, commits, or external side-effects."
context: load
---

## Sub-agent contract
/contract

When a sub-agent (or wave) returns investigation findings, code-review conclusions, audit claims, refactor plans, or counts that will drive user decisions or file changes, do NOT surface the report. Instead, run a shadow verification wave **before** merging.

**Wave 2 — Adversarial verifiers (parallel, independent):**
1. Extract 2–3 concrete, re-checkable claims from the returned report (e.g., "X function is unused", "file Y exceeds 300 lines", "PR targets main", "no tests cover Z").
2. Dispatch one shadow sub-agent per claim, in parallel. Each receives ONLY the claim + the user's original goal — never the original agent's reasoning or cited evidence. **Default to `subagent_type: "research-agent"` (mechanically locked to Read/Grep/Glob/WebFetch/WebSearch — cannot Edit/commit/push).** If the claim requires Bash to verify (running a failing test, `gh pr view`, `git log origin/...`), fall back to a Bash-capable subagent type with `isolation: "worktree"` and prepend this prefix to the prompt: *"Verifier sub-agent — do not Edit, Write, commit, push, `gh pr create`, or `curl`. Return findings only."*
3. Each verifier re-derives the verdict independently using tool calls only — never re-reading the original report's reasoning. Returns `{claim, verifier_verdict, evidence_pointer, evidence_base}`, where `verifier_verdict` is one of `CONFIRMED`, `REFUTED`, or `UNVERIFIABLE`, and `evidence_base` is `independent-rederivation` (read primary sources *outside* the cited artifact's boundary) or `artifact-internal` (re-read only the cited file/region). On `REFUTED`, the verifier also emits a corrected finding.

**Merge:**
- `CONFIRMED` → surface the claim as validated.
- `REFUTED` → replace the claim with the verifier's corrected finding, annotated `[was: confident, now: refuted]`, and show it alongside the original with evidence. Do not act until the conflict is resolved.
- `UNVERIFIABLE` → surface with a `[needs-human-review]` tag rather than passing it through silently.
- `UNVERIFIED-COMPOSITION` / `UNVERIFIED-ECHO-CHAMBER` (from the composition-axis guard below) → surface with a `[needs-human-review]` tag naming the missed boundary; do not pass through as validated.

Bound the loop: at most 3 verification rounds per session. Claims still unresolved after 3 rounds are escalated to the user, never silently dropped.

**Composition-axis guard (echo-chamber check):**
A verifier that re-derives a claim by re-reading the *same* file/region the original sub-agent cited has confirmed the citation, not the claim — it can be blind to composition-boundary failures (temporal interleaving, state threading, render/event-pipeline ordering, scrollback/call-graph adjacency) that only manifest outside the artifact's boundary. Before accepting a `CONFIRMED`:
1. Read each verifier's `evidence_base`.
2. For any **artifact-internal `CONFIRMED`**, require one composition-boundary read (≥1 upstream caller + ≥1 downstream consumer, plus the pipeline that interleaves the artifact with siblings) before merging. If a missed boundary surfaces, downgrade to `UNVERIFIED-COMPOSITION` and tag `[needs-human-review]`.
3. **Echo-chamber guard:** if ≥2 verifiers cite the *same* in-repo artifact as primary evidence with no external referent, flag `UNVERIFIED-ECHO-CHAMBER` regardless of verdict and require one verifier to read outside that artifact's boundary.

**Scope guard:** skip the composition check when the claim cites an external referent (RFC, spec, threat model, upstream-API contract) that survives independently of the repo, or when the artifact is purely local with no composition surface. Runs once per artifact, not on every cite.

**When to invoke:**
Any time sub-agent output will drive user decisions, file edits, commits, external side-effects, or is the basis of a user-facing summary. Treat **high-confidence language as a trigger in its own right**: when a review/audit sub-agent asserts a claim with markers like "confident", "certain", "clearly", "obviously", "must be", or a stated probability ≥ 80%, verify it as if it were decision-driving regardless of stakes. Confidence is a trigger, not a verdict.

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
