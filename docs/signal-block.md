# SIGNAL Block Convention (v0, passive-observation only)

Status: **v0 / passive observation.** This convention is read-only
infrastructure. It does not gate finalization, does not influence routing,
and is not authoritative for any decision.

Companion audit: [`docs/audits/`](./audits/) — the audit that produced this
convention concluded AFK is ready for passive observation but **not** ready
for authoritative convergence scoring. This convention is the smallest
reversible step toward observation.

---

## What it is

A subagent that produces a load-bearing claim about an issue MAY emit an
optional `signal` object as a top-level key in its final assistant message's
JSON output. AFK's `extractSignalBlock` / `parseSignal` (in
[`src/agent/signal-block.ts`](../src/agent/signal-block.ts)) finds it by key,
not by position, so the SIGNAL can coexist with any existing structured
output schema.

## Required shape

```json
{
  "signal": {
    "issue": "stable-slug-or-question",
    "stance": "supports | opposes | uncertain | blocks",
    "confidence": 0.0,
    "evidence": ["file:line or source"],
    "claim": "one sentence claim"
  }
}
```

| Field | Type | Notes |
|-------|------|-------|
| `issue` | non-empty string | Stable slug or question. Subagents investigating the same thing should use the **same string verbatim**; this is the only grouping key v0 supports. No NLP, no fuzzy match. |
| `stance` | enum | `supports`, `opposes`, `uncertain`, `blocks`. `blocks` means a precondition (env, tool access, missing data) prevents reaching a verdict. |
| `confidence` | number in [0, 1] | Self-reported. v0 records it; it is not authoritative. |
| `evidence` | array of strings | `file:line`, commit SHA, log pointer, or URL. An empty array is permitted but is itself a signal ("claim without evidence"). |
| `claim` | non-empty string | One sentence. The falsifiable thing the agent actually believes. |

## Placement rules

The `signal` field is **discovered by key**, not by position. Two equally
correct placements:

1. **Sibling key on the existing output JSON block** (preferred when the
   agent already emits a structured `outputSchema` block):

   ```json
   {
     "status": "PASS",
     "issues": [],
     "signal": { "issue": "...", "stance": "supports", ... }
   }
   ```

   This is the cleanest option because:
   - It preserves the agent's existing single-block output contract.
   - Existing `z.object({...})` Zod schemas silently strip the unknown
     `signal` key (Zod default behavior — verified), so no schema migration
     is required.
   - Positional last-fence extraction still finds the schema as before.

2. **Separate fenced JSON block** (when the agent emits no structured
   output, or when keeping concerns separate is clearer):

   ```
   Some prose explaining the finding.

   ```json
   {
     "signal": { "issue": "...", "stance": "supports", ... }
   }
   ```
   ```

The parser walks all fenced blocks in order and returns the first whose root
has a `signal` key, so either placement works regardless of order.

## When to emit

**Emit** when:
- The subagent has converged on a single load-bearing claim about a named
  issue.
- The agent is one of several investigating the same question and wants to
  contribute a stance.
- A precondition prevents reaching a verdict (`stance: "blocks"`).

**Do NOT emit** when:
- The agent did not converge — multiple hypotheses are equally likely.
- The agent's role is purely "do work" (refactor, generate code, ship); it
  has no claim to make.
- Filling the slot would require fabrication. Missing is informative;
  fabricated is harmful.

## What it does NOT do (v0)

- It does **not** gate finalization.
- It does **not** modify provider message history or `tool_result` pairing.
- It does **not** trigger automatic re-runs, shadow-verifies, or nudges.
- It does **not** compute a convergence score, stability score, or wave
  metric of any kind.
- It does **not** do NLP, fuzzy matching, or auto-issue-key inference.
  Subagents are expected to coordinate on `issue` strings explicitly via the
  prompt.

## Future direction (explicitly LATER)

A future passive observer may:
- Render an aggregate `signal: issue=count↑/↓` indicator in the status line.
- Append `SignalObservation` entries to a JSONL telemetry sink.
- Surface contradiction warnings ("two agents reached opposite stances on
  the same issue") as advisory output, not gating.

A future finalization gate is gated on four prerequisites listed in the
audit (compose upstream provenance, tool-error surfacing in `SubagentResult`,
evidence-required schemas, truncation flags). None of those land in v0.

## Adoption

v0 prompt-side adoption is limited to AFK-native specialized findings
prompts:

- [`src/skills/diagnose/prompts/research.md`](../src/skills/diagnose/prompts/research.md)
- [`src/skills/diagnose/prompts/hypothesis.md`](../src/skills/diagnose/prompts/hypothesis.md)
- [`src/skills/diagnose/prompts/verify.md`](../src/skills/diagnose/prompts/verify.md)
- [`src/skills/mint/prompts/verify.md`](../src/skills/mint/prompts/verify.md)

Vendored prompts (`research-agent.md`, `git-investigator.md`)
are not modified in v0 — they belong upstream. The pinned-hash drift tests
in `src/skills/_agents/vendored.test.ts` enforce this.

`audit-fit/prompts/*.md` are not modified — their existing "must be the
final fenced block" constraint conflicts with the sibling-key approach and
the cohabitation pattern would require a schema rewrite. Deferred.
