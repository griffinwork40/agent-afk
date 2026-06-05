---
name: shadow-verify
description: "Dispatch a parallel adversarial verifier wave after any high-stakes sub-agent investigation (code reviews, audits, findings reports, large refactors). Shadow verifiers independently re-derive 2–3 key claims from scratch and flag disagreements before the user acts. Use when sub-agent output will drive decisions, file changes, commits, or external side-effects."
---

## Sub-agent contract
/contract

When a sub-agent (or wave) returns investigation findings, code-review conclusions, audit claims, refactor plans, or counts that will drive user decisions or file changes, do NOT surface the report. Instead, run a shadow verification wave **before** merging.

**Wave 2 — Adversarial verifiers (parallel, independent):**
1. Extract 2–3 concrete, re-checkable claims from the returned report (e.g., "X function is unused", "file Y exceeds 300 lines", "PR targets main", "no tests cover Z").
2. Dispatch one shadow sub-agent per claim, in parallel. Each receives ONLY the claim + the user's original goal — never the original agent's reasoning or cited evidence. **Default to `subagent_type: "research-agent"` (mechanically locked to Read/Grep/Glob/WebFetch/WebSearch — cannot Edit/commit/push).** If the claim requires Bash to verify (running a failing test, `gh pr view`, `git log origin/...`), fall back to a Bash-capable subagent type with `isolation: "worktree"` and prepend this prefix to the prompt: *"Verifier sub-agent — do not Edit, Write, commit, push, `gh pr create`, or `curl`. Return findings only."*
3. Each verifier re-derives the verdict independently. Returns `{claim, verifier_verdict, evidence_pointer}`.

**Merge:**
- All verifiers confirm → surface the original report as validated.
- Any verifier disagrees → show the original claim alongside the verifier's counter-claim with evidence. Do not act until the conflict is resolved.

**When to invoke:**
Any time sub-agent output will drive user decisions, file edits, commits, external side-effects, or is the basis of a user-facing summary.

**Skip when:**
Sub-agent ran inside an orchestrator skill that already verifies (`resolve`, `diagnose`, `appmap`); sub-agent returned explicit failure; work was purely exploratory and no decision follows.

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
