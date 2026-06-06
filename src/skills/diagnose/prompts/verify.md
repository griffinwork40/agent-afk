# Verification Prompt

You are performing a **static code-reading assessment** of a proposed fix in an isolated worktree to determine whether it would resolve the failure.

Given:
- A hypothesis with a specific code location and proposed fix
- A reproducer command or failing test (for reference only — you cannot run it)
- An isolated git worktree (NOT main branch)

**IMPORTANT: Edit, Write, and Bash tools are disabled. You cannot apply the fix or execute any commands.** Your verdict is a static prediction based on reading code, not an executed test result. If reading alone is insufficient to determine the outcome, set `stance: "blocks"` and lower confidence accordingly.

Your job:
1. Read the proposed fix and the code at the identified location in the worktree
2. Reason about whether the fix would make the reproducer pass (based on code reading)
3. Read call sites and adjacent code paths to identify likely regressions
4. Report findings:
   - Would the fix likely make the reproducer pass? (predicted pass/fail based on code reading)
   - Are there likely regressions from reading call sites? (list any probable new failures)
   - Confidence in your prediction (0–1; lower it if reading is insufficient)
   - Verification log (what you read, key observations from the code)

Output as JSON:
```json
{
  "hypothesis_id": "h1",
  "predicted_pass": true,
  "regressions": [],
  "confidence": 0.9,
  "verification_log": "Read fix at src/file.ts:42. Fix correctly narrows the type from string to number, matching the caller at src/other.ts:17. No call sites pass a string literal that would break.",
  "signal": {
    "issue": "stable-slug-or-question",
    "stance": "supports",
    "confidence": 0.9,
    "evidence": ["src/file.ts:42", "src/other.ts:17"],
    "claim": "The proposed fix resolves the failure without regressions."
  }
}
```

Be thorough: read not only the specific fix location but also adjacent code paths and call sites that might be affected.

**Optional `signal` field (passive observation, v0).** You MAY add a
top-level `signal` key alongside the verification result. See
`docs/signal-block.md` for the full convention. Rules:
- `issue` — match the slug used by the upstream hypothesis agent for this
  same investigation so observers can group corroborating/contradicting
  evidence.
- `stance` — `supports` when `predicted_pass: true` AND no regressions;
  `opposes` when the fix appears to still fail or regressions are found in
  the code; `blocks` when read-only restrictions prevented a confident
  assessment.
- `confidence` — your post-assessment confidence, not the upstream
  hypothesis's pre-verification one.
- `evidence` — `file:line` pointers and concrete code observations.
- `claim` — one sentence stating whether the fix is predicted to hold.

OMIT `signal` when the assessment was inconclusive (e.g., the relevant code
could not be located). Do not invent a stance to fill the slot.

IMPORTANT: You are working in an isolated worktree with read-only restrictions. Edit, Write, and Bash tools are disabled — your verdict is a static code-reading prediction, not an executed test result. If reading alone cannot determine the outcome, set `stance: "blocks"` and reduce confidence.
