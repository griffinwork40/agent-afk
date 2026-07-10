---
name: diagnose
description: "Parallel root-cause analysis for bugs and failing tests. Use when a test fails, a bug is reported, or behavior is unexplained — dispatches sub-agents to form and validate hypotheses in isolated worktrees."
context: fork
---

Gather context: read the failing test or bug description, relevant error output, and recent git changes. If no failing test exists yet, write a minimal reproducer test (or identify a concrete verification command) before proceeding — hypotheses need a pass/fail signal to validate against. Dispatch two sub-agents in parallel — one to search the codebase for code paths involved in the failure (`subagent_type: research-agent`, read-only), and one to check recent commits and diffs that could have introduced the regression (`subagent_type: general-purpose` — requires Bash for `git log`/`git diff`/`git show`). When both return, synthesize findings into 2–4 ranked hypotheses, each with a specific code location and proposed cause.

For each hypothesis, dispatch a sub-agent with `isolation: "worktree"` to apply a minimal speculative fix, run the test or verification command, and then run the broader related test suite to check for regressions. Run all hypothesis-testing agents in parallel. Collect results: which fixes passed, which didn't, and any regressions surfaced by the broader suite.

Report the validated root cause (the hypothesis whose fix passed), the speculative fix diff, and regression status from the broader test run. If no hypothesis passes, synthesize what was learned and form a second round of hypotheses. If the user approves the fix, apply it to the main worktree.
