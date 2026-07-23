---
name: contract
description: "Reference convention for sub-agent I/O schemas. Loaded by orchestrator skills via /contract and into agents via the `skills:` field."
---

# Contract

For each sub-agent you plan to dispatch, define a schema before the call:

- `goal` — one-sentence objective
- `inputs` — data/context the sub-agent receives
- `artifacts` — named structured fields expected back (not freeform prose)
- `non_goals` — what the sub-agent must NOT do
- `failure_modes` — how to report blocked or partial work
- `domain` *(optional)* — the knowledge domain for this task. Guides how research, specification, and verification adapt. Common values: `software`, `research`, `design`, `business` — but any freeform string works (e.g., `healthcare`, `legal`, `education`). When omitted, infer from context: git repo present → `software`; PDFs/papers/citations in working directory → `research`; design files/brand assets → `design`; financial models/strategy docs → `business`. Default fallback: `software`.

Embed the schema at the top of every sub-agent's prompt and require results in that exact shape. Instruct each sub-agent explicitly: "Return ONLY the schema fields. No preamble, no analysis prose, no explanation — begin your response with the first schema field." When sub-agents return, validate field-by-field. If any artifact is missing, malformed, or wrapped in prose, re-dispatch only the failing sub-agent with the gap cited. Merge only schema-valid responses.

Also instruct each sub-agent to stop on non-convergence: if repeated attempts at the same sub-goal stop making progress after a few tries, do not keep retrying — return the best partial result through the schema's designated failure/partial channel (`failure_modes`, or whatever blocked/`unverified` field that agent's schema defines), naming what could not be resolved. Activity is not progress.

## Epistemic confidence

Recommended for all sub-agents. Add to your return schema:

- `confidence` — low / medium / high — how confident is the sub-agent in the completeness and accuracy of its findings?
- `coverage_gaps` — what the sub-agent couldn't access, verify, or search (e.g., proprietary databases, paywalled sources, unpublished practitioner knowledge, subjective judgment areas)
- `boundary_flag` — if the sub-agent hit an epistemic boundary, name it: `non-falsifiable` (claim can't be tested), `low-coverage` (search was limited), `tacit-knowledge` (unwritten knowledge required), `unprecedented` (genuinely novel, no baseline), `time-sensitive` (answer depends on current state), or `none`
- `recommended_action` — what should happen next: `proceed` (findings solid, move ahead), `human-gate` (pause for human judgment before acting), `re-retrieve` (try different search strategy or sources), `elicit` (generate prompts to validate with domain experts)

This is NOT required — skills that don't return it continue to work. But when present, coverage gaps and boundary flags surface automatically during merge, preventing silent failures.

## Skip if

- Single-agent dispatch
- Sub-agents returning freeform prose where structure doesn't help merge
- Exploratory tasks where the output shape isn't known yet
