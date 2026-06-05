# Hypothesis Synthesis Prompt

You are synthesizing ranked hypotheses from parallel research findings (codebase analysis + git history audit).

Given:
- Research findings from codebase investigation (code paths, logic issues, type mismatches)
- Research findings from git history (recent commits, blame info, dependency changes)
- The original failure description and reproducer

Your job:
1. Cross-reference findings from both research subagents
2. Group related findings into coherent root-cause hypotheses
3. Rank them by confidence (evidence quality + relevance)
4. Generate 2–4 hypotheses maximum (HARD CAP at 4)
5. For each hypothesis, specify:
   - A short claim (what is broken)
   - A specific code location (where to look)
   - A proposed minimal fix (what change would validate it)
   - Confidence score (0–1)
   - Evidence sources (which findings support this hypothesis)
   - `coverage_gaps`: things you could not read or verify that would strengthen the hypothesis — list as strings. Emit `[]` (an empty JSON array) when there are no gaps. Do NOT emit `null` for this field; always include the array.
   - `boundary_flag`: set to a short string when you hit an epistemic boundary (timeout, blocked tool, ambiguous evidence) that the caller should know about. Emit the literal string `"none"` when nothing applies. Do NOT emit `null` for this field; always include a string.

These epistemic fields feed a downstream confidence gate: low-confidence, gap-bearing, or boundary-flagged hypotheses get independently re-checked by /shadow-verify before worktree testing. Reporting gaps honestly is rewarded, not penalized — a confident claim with an unresolved gap is more useful than a confident claim that hides one.

Output ONLY the JSON in a fenced code block. Do NOT include any prose after the JSON block — the downstream consumer will extract the JSON from your fenced block and will fail if non-JSON text follows it.

```json
{
  "hypotheses": [
    {
      "id": "h1",
      "claim": "Type mismatch in function signature at src/file.ts:42",
      "location": "src/file.ts:42",
      "proposed_fix": "Change parameter type from string to number",
      "confidence": 0.85,
      "evidence_sources": ["codebase-finding-1", "git-finding-2"],
      "coverage_gaps": ["could not read src/types/user.ts — outside search scope"],
      "boundary_flag": "Grep timed out on node_modules"
    }
  ],
  "signal": {
    "issue": "stable-slug-or-question",
    "stance": "supports",
    "confidence": 0.85,
    "evidence": ["src/file.ts:42"],
    "claim": "Top-ranked hypothesis is the most likely root cause."
  }
}
```

Rank by confidence (highest first). Always cap at 4 hypotheses.

**Optional `signal` field (passive observation, v0).** When the top-ranked
hypothesis is meaningfully more likely than the rest — i.e., your synthesis
has actually converged — you MAY add a top-level `signal` key conforming to
the shape above. See `docs/signal-block.md` for the full convention.
Rules:
- `issue` — a stable slug or question that captures the root-cause question
  (e.g. `"why-does-auth-middleware-fail-under-load"`). Reuse the same string
  across runs investigating the same failure so observers can group claims.
- `stance` — `supports` when you converge on a single hypothesis;
  `uncertain` when the top two are within ~0.1 confidence of each other;
  `opposes` when evidence rules out a previously suspected cause; `blocks`
  when an epistemic boundary (`boundary_flag`) prevents synthesis.
- `confidence` — generally mirrors your top hypothesis's confidence but
  should be reduced when `coverage_gaps` or `boundary_flag` is set.
- `evidence` — file:line pointers and/or commit SHAs from your hypotheses'
  `evidence_sources`.
- `claim` — one sentence stating what you believe the root cause is.

If your hypotheses are not differentiated — i.e., several are equally
likely — OMIT `signal` rather than emitting a low-confidence guess.
Missing is informative; fabricated is harmful.
