---
name: polish
description: "Iteratively refines any artifact (prose, spec, prompt, API design, SKILL.md, code snippet) by running a decoupled evaluator → generator loop until explicit criteria are met or an iteration cap is reached. Locks criteria in Wave 1, isolates the evaluator from generation history to prevent sycophancy, and emits the best version with any remaining gaps flagged at cap."
---

## Sub-agent contract
/contract

`polish` is a three-wave evaluator-optimizer loop that applies to any artifact at any workflow stage. Wave 1 locks concrete, testable criteria. Waves 2 and 3 alternate (evaluator → generator) until all criteria pass or the iteration cap is reached. The evaluator is always spawned stateless — it never sees prior generation history — eliminating the sycophancy failure mode that plagues shared-context review loops.

The orchestrator coordinates but never edits the artifact directly. All revisions are produced by the Wave 3 generator, which receives only the `blocking_gaps` list from the evaluator (not its full reasoning). This constraint prevents scope-creep revisions and keeps each iteration focused on the delta between current state and the locked criteria.

On cap exhaust the orchestrator emits the best-scoring version plus a structured `remaining_gaps` report so the caller can decide whether to extend the cap, escalate to a human, or ship with known gaps documented.

---

## Inputs

| Field | Required | Description |
|---|---|---|
| `artifact` | yes | The text, spec, prompt, design doc, or code snippet to refine |
| `goal` | yes | Natural-language quality intent ("make this safe for external stakeholders") |
| `criteria` | no | Pre-supplied testable criteria — skips Wave 1 extraction if provided |
| `threshold` | no | `pass_all` (default) or `pass_N` where N is an integer |
| `cap` | no | Max refinement iterations (default: 4, max: 8) |

---

## Wave 1 — Criteria Extraction

**Trigger:** Always, unless `criteria` were supplied by the caller.

**Agent:** Single subagent. Reads `artifact` + `goal`. Produces:

```json
{
  "criteria": [
    { "id": "C1", "text": "<concrete, binary-testable criterion>" },
    ...
  ],
  "threshold": "pass_all | pass_N",
  "cap": 4
}
```

**Rules:**
- Criteria must be falsifiable — "no jargon visible to end-users", not "improve clarity".
- Maximum 8 criteria. If the goal implies more, merge related ones.
- Criteria are **locked** after Wave 1. The evaluator may not add or modify them.

**Exit:** Emit `criteria.json`. Proceed to Wave 2.

---

## Wave 2 — Evaluation (stateless)

**Agent:** Single subagent, spawned fresh with **no generation history**. Receives:
- Current artifact (text only)
- Locked `criteria.json`

**Produces:**

```json
{
  "scores": [
    { "criterion_id": "C1", "pass": true, "gap": "" },
    { "criterion_id": "C2", "pass": false, "gap": "<specific, actionable description of what is missing or wrong>" }
  ],
  "overall": "pass | fail",
  "blocking_gaps": ["C2: <gap text>", ...]
}
```

**Rules:**
- If `overall: pass` (threshold met) → skip Wave 3, emit final artifact, terminate loop.
- If iteration count == cap → skip Wave 3, emit best version + `remaining_gaps`, terminate loop.
- Gap text must be specific enough for Wave 3 to act on without re-reading evaluator reasoning.

---

## Wave 3 — Revision

**Agent:** Single subagent. Receives:
- Current artifact
- `blocking_gaps` list (text only — NOT the evaluator's full `scores` object)
- Original `goal` (for orientation only, not as new criteria)

**Produces:** Revised artifact (full text, not a diff).

**Rules:**
- Address only the `blocking_gaps`. Do not make unrequested changes.
- Do not invent new criteria or second-guess passing scores.
- Output is the next artifact fed into Wave 2.

---

## Loop Control

```
iteration = 0
artifact = <input>

Wave 1 → criteria.json

loop:
  iteration += 1
  result = Wave 2(artifact, criteria.json)
  if result.overall == "pass":
    emit artifact, result.scores, iteration_count
    DONE
  if iteration == cap:
    emit artifact, result.remaining_gaps, "CAP_REACHED"
    DONE
  artifact = Wave 3(artifact, result.blocking_gaps)
```

---

## Outputs

| State | Emitted |
|---|---|
| Converged | Final artifact + `{status: "CONVERGED", iterations: N, scores: [...]}` |
| Cap reached | Best artifact + `{status: "CAP_REACHED", iterations: cap, remaining_gaps: [...]}` |

`CAP_REACHED` is not a failure — it is an explicit signal for the caller to extend, escalate, or ship with documented gaps. The orchestrator never silently discards gap information.

---

## Composition

`polish` is designed to run *after* a generative skill and *before* `ship`:

```
spec → forge → polish → ship
research → mint → polish → ship
<any draft> → polish → ship
```

It may also be called standalone on an existing artifact with explicit `criteria` supplied.