# Failure Geometry

Failure Geometry is the pattern of designing agent workflows by naming the default failure mode, choosing the preferred failure mode, and adding structure that transforms one into the other.

Good workflows do not eliminate failure. They make failure earlier, smaller, louder, cheaper, more local, more informative, or more recoverable.

## The pattern

1. **Name the default failure.** What does the agent do when it breaks without intervention? (e.g., silently approve malformed output, narrate instead of act, declare done while blockers remain)
2. **Choose the preferred failure.** What should failure look like instead? (e.g., reject by default, pause in a named state, surface uncertainty)
3. **Add structure that transforms one into the other.** A gate, a parser fallback, a rubric dimension, a contract field, an abort cascade rule.
4. **Verify the signal.** Confirm the new failure mode is observable — if it fires and nobody sees it, the geometry didn't change.

## Existing embodiments

| Default failure | Preferred failure | Mechanism | File |
|---|---|---|---|
| Trust all sub-agent output | Re-verify when uncertain | confidence gate (threshold, gaps, boundary) | `src/skills/_lib/confidence-gate.ts:9-13` |
| Fail silently at iteration cap | Pause in named state with next-step | `heal-failed` exit with resumption path | `src/skills/mint/index.ts:173-180` |
| Opaque epistemic limits | Named boundary categories | `boundary_flag` field in contract output | `src/skills/_agents/prompts/contract.md:25` |
| Child abort kills parent | Child notifies parent without auto-abort | `AbortGraph` cascade rule | `src/agent/abort-graph.ts` |
| Tilde resolves to wrong home in subagent | Pre-resolved absolute path | Inline path expansion before dispatch | `src/skills/audit-fit/index.ts:205-210` |

## Checklist for new skills

When authoring a skill, answer these before shipping:

- [ ] What is the default failure mode if the skill breaks with no hardening?
- [ ] What is the preferred failure mode — what should breaking look like?
- [ ] What structure transforms one into the other? (A gate, fallback, contract field, exit state, or rubric check — not a comment.)
- [ ] Is the preferred failure observable without reading source? (Logged, surfaced in output, or gated.)
- [ ] Does the skill's SKILL.md declare the expected breakage patterns?

## What this is not

- **Not a new rubric.** This doc names a design pattern authors can apply deliberately; it does not add a scoring mechanism.
- **Not a gate or runtime check.** confidence-gate and verdict parsing already enforce fail-closed behavior at runtime. This doc explains why they exist.
- **Not a skill.** There is no `/failure-geometry` command. If it ever became one, it would need to force a better execution pattern — not generate analysis.
- **Not a requirement.** Skills ship without this checklist. It exists so authors can recognize the pattern and apply it deliberately rather than accidentally.
- **Not error handling.** Error handling catches exceptions. Failure Geometry chooses which failure mode the workflow defaults into when nothing catches anything.
