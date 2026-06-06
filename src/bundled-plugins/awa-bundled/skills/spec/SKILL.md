---
name: spec
description: "Takes a loose idea and transforms it into a structured, actionable spec ready for implementation. Use when the user passes an idea, feature request, or problem description that needs scoping before building."
argument-hint: "<idea or feature request>"
context: fork
---

## Triage: bugs route to /diagnose

Before speccing, detect bug-shaped inputs: crashes, error stacks, regression reports ("worked yesterday", "used to work"), platform-specific failures ("broken on X", "doesn't work when…"), or user-report framing that implies root-cause-first (not design-first). If detected, stop and redirect: *"This is a debugging task, not a spec task. Route to /diagnose instead — it will isolate the root cause, then /spec can scope the fix."* Do not emit a spec.

---

Dispatch two sub-agents in parallel. One researches the web for prior art, comparable approaches, and patterns relevant to $ARGUMENT. The other inspects the local working directory for conventions, existing artifacts, and integration points relevant to the domain. When both return, synthesize a concise spec using the domain-appropriate schema below. Present to the user for confirmation before proceeding.

**Output schema by domain:**

| Domain | Spec fields |
|--------|-------------|
| `software` | problem, goals, non-goals, approach, key decisions, interface, file plan, test plan, open questions |
| `research` | problem, hypothesis, methodology, prior art positioning, expected results, publication plan, open questions |
| `design` | problem, user needs, constraints, solution space, prototype plan, success metrics, open questions |
| `business` | opportunity, risk analysis, competitive landscape, go/no-go criteria, resource plan, open questions |
| *(other)* | problem, goals, non-goals, approach, key decisions, deliverables, validation plan, open questions |

When domain is unspecified, infer from $ARGUMENT and the working directory. If ambiguous, use the generic *(other)* schema.

## Epistemic confidence

Include an **Epistemic confidence** section at the end of every spec: summarize coverage gaps from research, flag claims that will be hard to verify, and note where human judgment will be needed.
