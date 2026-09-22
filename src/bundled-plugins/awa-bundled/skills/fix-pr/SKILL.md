---
name: fix-pr
description: "One-verb pipeline for the operator's highest-frequency manual loop: fetch a PR's unresolved reviewer feedback (inline review comments, review-summary bodies, and issue-level conversation comments) and failing CI checks, triage each issue via parallel read-only probes, fix the validated items in an isolated managed worktree via a budget-bounded subagent, verify with the project's test gates, and push the fix back to the PR branch. Replaces the retyped recipe 'send a subagent in a worktree to fix <PR feedback>, then push.' Use when a PR has review comments or red CI that needs addressing — e.g. 'fix pr 286', 'address the review on #215', 'CI is red on the worktree-sweep PR'. Never force-pushes, never touches main, fails closed on missing gh auth or un-pushable fork PRs."
when-to-use: "A PR has review feedback or red CI that needs fixing."
argument-hint: "<PR-number-or-URL> [--repo <path>] [--no-push] [--re-review]"
surface: "afk"
failure_modes:
  - push to wrong branch
  - nested /review max_depth self-collision
  - silent partial fix (some comments addressed, done claimed for all)
  - unmanaged worktree leak
  - triage probe misclassifies a valid item as invalid (filtered before write agent sees it)
---

## Sub-agent contract
/contract

`fix-pr` turns "review feedback / red CI on PR N" into a pushed fix commit with test evidence, using worktree isolation so the operator's working tree is never disturbed. The pipeline has three stages: **harvest** (collect feedback from all GitHub stores), **triage** (parallel read-only probes validate each issue independently), and **fix** (a single write agent applies pre-validated proposals). The parallel triage wave eliminates false-positive spec items and pre-computes fix proposals before any write begins, reducing cycling.

**Skip when:** the fix is a one-line suggestion the operator pointed at directly (apply inline); the PR is already green with all threads resolved (report and stop); or the work is local-only and unpushed (use `/ship`).

---

### Phase 0 — Input gate & preflight (inline, fail closed)

Parse `$ARGUMENTS`:
- **`pr`** — PR number or URL (required). If absent, stop: "fix-pr requires a PR number or URL."
- **`repo`** — repo path from `--repo`; default: current working directory's git root.
- **`no_push`** — from `--no-push`: produce the fix in a kept worktree + diff summary, no remote mutation.
- **`re_review`** — from `--re-review`: after pushing, re-trigger `/review` (top-level only — see Phase 6 guard).

Preflight (all inline bash; any failure → **Blocked**, do not improvise):
1. `gh auth status` — must be authenticated. Fail closed if not.
2. `gh pr view <pr> --json state,headRefName,headRepositoryOwner,isCrossRepository,mergeable,url` — PR must be OPEN.
3. **Fork guard:** if `isCrossRepository` is true and the authenticated account cannot push to the head repo, emit **Blocked** naming the fork and stop. Never attempt workarounds.
4. Record `head_branch` — this is the ONLY branch this skill will ever push to.

---

### Phase 1 — Feedback harvest (inline)

Reviewer feedback lives in **three distinct GitHub stores** — miss any one and the fix is silently partial. Harvest all three, then the gates:

1. **Inline review comments:** `gh api repos/{owner}/{repo}/pulls/<pr>/comments` — comments anchored to a diff line (each carries `path`/`line`/`diff_hunk`).
2. **Review summary bodies:** `gh pr view <pr> --json reviews` — the top-level body of each APPROVE / REQUEST_CHANGES / COMMENT review submission.
3. **Issue-level conversation comments:** `gh pr view <pr> --json comments` (equivalently `gh api repos/{owner}/{repo}/issues/<pr>/comments`). A PR is also an issue, and its plain conversation comments ("also update the docs", "rename this before merge") live on the **issues** endpoint — the `pulls/<pr>/comments` endpoint does NOT return them. Skipping this source is the known gap: reviewers who leave feedback as normal PR comments are otherwise dropped entirely, and a PR can have actionable conversation comments with zero inline review comments.

Then the gates:
4. **Failing CI checks:** `gh pr checks <pr>` — for each failing check, pull the tail of its log (`gh run view --log-failed` when available).
5. **PR description acceptance criteria** if present.

**Noise filter (apply to sources 1–3 before building the spec):** drop bot/automation chatter (vercel, github-actions, codecov, dependabot, deploy-preview posts) and non-actionable social comments ("LGTM", "thanks", 👍). Keep only unresolved, actionable requests.

Routing rule:
- Any actionable reviewer feedback (inline comments, review bodies, or conversation comments) exists → it is the primary spec; failing checks are secondary gates.
- **No actionable feedback but CI is red → the failing checks ARE the spec** (acceptance criterion 3).
- Neither → report "PR is green with no unresolved feedback" and stop (Done, no mutation).

Consolidate into a numbered fix spec: each item = source (comment URL or check name), file/line if known, and the requested change. This numbered list is the completeness contract — every item must be addressed or explicitly declared out-of-scope in the terminal report.

---

### Phase 2 — Isolated worktree (inline, managed only)

Create the worktree via the **`worktree` tool** (`action: create`, `name: pr<pr>-fix`, `base: <head_branch>` after `git fetch`). **NEVER raw `git worktree add`** — unmanaged trees lack sweep metadata and leak (the 108-worktree/14GB sprawl was this failure mode).

If a managed worktree for this PR already exists, reuse it only if clean; otherwise create a fresh one with a suffixed name.

---

### Phase 2.5 — Parallel issue triage (read-only probes)

This phase validates each spec item independently before any writes begin. The goals: filter false positives, detect already-addressed items, and pre-compute fix proposals so the write agent receives validated work orders instead of raw review comments.

**Fast-path:** if the numbered spec contains exactly 1 item, skip this phase entirely -- dispatch directly to Phase 3 with the raw spec item. The parallel wave's value is proportional to item count; for a single item the overhead exceeds the benefit.

**For 2+ spec items:** dispatch N read-only sub-agents in parallel via the `agent` tool (one call per spec item in the same tool-use turn -- pure fan-out). `compose` now supports `agent_type`, `cwd`, `readRoots`, and `writeRoots` per node (so the read-only and worktree-scoping guarantees are NOT silently lost when using compose), but the `agent` fan-out is preferred here: it gives simpler rate-limiting control (see the rate note below) and each probe is truly independent with no DAG dependencies to model. If DAG dependency tracking between probes matters for a future extension, compose is a valid alternative -- just wire `agent_type: "research-agent"` and `cwd: <worktree path>` on each node. Each probe:

- **agent_type:** `research-agent` (mechanically read-only -- cannot write files, run bash, or commit).
- **cwd:** `<worktree path>` (so file reads target the PR branch, not the main working tree).
- **model:** `haiku` (sufficient for validation; keeps the fan-out cheap).
- **max_tool_use_iterations:** 8 (read the cited code, check surrounding context, form a verdict -- more than enough).
- **inputs (in prompt):** one numbered spec item (comment text, source URL, file/line if known) and the `head_branch`.
- **goal:** read the cited file(s) and surrounding context in the worktree. Determine whether the reviewer's request is (a) valid and unaddressed, (b) already addressed by existing code, or (c) a false positive / misunderstanding. If valid, propose the minimal fix: exact file, location, and the change to make.
- **deliverable (structured):**
  - `item_id`: the spec item number.
  - `verdict`: `valid` | `already-addressed` | `invalid` | `unclear`.
  - `reasoning`: 2-3 sentences explaining the verdict with file:line citations.
  - `proposed_fix` (when verdict is `valid`): exact file path, location description, and a concrete description of the change needed. NOT a diff -- a plain-language description the write agent can execute.
  - `risk`: `low` | `medium` | `high` -- whether the fix might have non-obvious side effects.

**After all probes return,** the orchestrator consolidates:

1. **Filter:** items with verdict `already-addressed` or `invalid` are removed from the fix spec. Note them in the terminal report as "triaged out" with the probe's reasoning.
2. **Escalate:** items with verdict `unclear` stay in the spec but are flagged -- the write agent sees the probe's reasoning and must make its own determination.
3. **Enrich:** items with verdict `valid` carry the probe's `proposed_fix` and `risk` forward into Phase 3 as pre-validated work orders.

If ALL items are triaged out (every probe returned `already-addressed` or `invalid`), report "All spec items were triaged out by parallel probes -- no changes needed" with the per-item triage table and stop (Done, no mutation). Clean up the worktree.

**Rate note:** for PRs with >6 spec items, cap the parallel wave at 6 concurrent `agent` calls per turn (remaining items in a second turn) to respect API rate ceilings.

---

### Phase 3 — Fix dispatch (one subagent, budget-bounded)

Size the dispatch per `/right-size-delegation` if available; defaults otherwise:

Dispatch ONE implementation subagent (`agent` tool, `cwd: <worktree path>`, `max_turns: 25`, model right-sized to the diff -- `sonnet` default, `haiku` never for code fixes):
- inputs: the **triaged fix spec** (not raw review comments): each surviving item carries its original numbered ID, the reviewer's request, the triage probe's `proposed_fix` and `risk` assessment, and `unclear` items carry the probe's reasoning. Also: `head_branch`, repo test/lint commands (inferred from package.json / Makefile / pyproject.toml and passed explicitly).
- goal: apply every surviving spec item with minimal diffs, using the triage probe's proposed fixes as a starting point (the probe proposals are guidance, not mandates -- the write agent may deviate if it discovers a better approach). Run the narrowest relevant tests per item. **Do NOT commit yet** -- emit the manifest first (see below).
- non_goals: do NOT push, do NOT touch branches other than the checked-out one, do NOT invoke /review or any skill, do NOT expand scope beyond the surviving spec items, do NOT modify files that are not named in the triaged spec unless a fix structurally requires it (e.g. a shared helper, a test file, a baseline file the gate checks).
- deliverable -- **two-part, manifest-then-commit:**
  1. **Pre-commit manifest** (emit BEFORE running `git commit`):
     - `touched_files`: list of every file modified or created.
     - `spec_item_map`: `{ file: [spec_item_ids] }` -- which numbered spec items justified touching each file. Every file must map to at least one item; a file not named in the spec must carry an explicit justification (e.g. "shared helper used by the fixed call site", "test file covering the changed behavior", "baseline file that the CI gate requires after the edit").
     - `invariant_per_file`: `{ file: "one-sentence claim about what changed and why it is correct" }` -- a falsifiable statement the orchestrator can verify by re-reading the file.
     - `out_of_scope`: `{ [spec_item_id]: "reason" }` -- spec items the subagent determined cannot be addressed in this PR, with a reason for each.
  2. **After orchestrator validates the manifest** (see Phase 3.5): emit the per-item status table (`fixed` | `out-of-scope <reason>`), unified diff summary, and targeted test output.

---

### Phase 3.5 — Manifest validation (inline, before commit)

After the fix subagent emits its pre-commit manifest, the orchestrator validates it **before** allowing the commit:

Run all three checks below, collecting violations into a single list. Do NOT re-dispatch after each individual check -- aggregate first, re-dispatch once after step 3.

1. **Scope check:** independently enumerate the worktree's modified and untracked files using the union of: `git diff --name-only HEAD` (unstaged changes), `git diff --name-only --cached` (staged changes), and `git ls-files --others --exclude-standard` (untracked files) — deduplicate the combined list. Require an exact match with the subagent's `touched_files` list. Any file present in the worktree diff but absent from `touched_files` → record violation: "File `<path>` was modified in the worktree but not declared in your `touched_files` manifest. Add it to the manifest or revert the change." Then, for each file in `touched_files`, verify it appears in `spec_item_map` with a valid spec item or an explicit justification. Any unjustified file → record violation: "File `<path>` was modified but is not covered by any spec item. Either remove the change or provide a justification."
2. **Invariant spot-check:** re-read each file in `touched_files` in the worktree. For each, check whether the `invariant_per_file` claim is consistent with the file's actual content. Flag obvious contradictions (e.g. claim says "added try/catch around writeFn" but the file has no try/catch near writeFn). A contradicted invariant → record violation naming the specific discrepancy.
3. **Compound-fix completeness:** cross-reference the triaged spec (surviving items only) against `spec_item_map`. If any surviving spec item is absent from the map AND absent from `out_of_scope`, record violation: "Spec item N is not addressed by any touched file and was not declared out-of-scope."

**After all three checks:** zero violations → pass. One or more violations → re-dispatch with the full violation list as a single message.

Pass → the orchestrator commits inline: run `git commit -m 'fix(pr-<pr>): address review feedback'` in the worktree. Fail → **≤2 manifest-validation re-dispatch iterations** (all violations from steps 1-3 in a single re-dispatch message per iteration). Cap reached with outstanding **scope violations** (unjustified files in `touched_files`, or missing spec items not declared out-of-scope) → emit **Blocked** naming the unresolved violations, the worktree path, and the branch (keep the worktree for manual follow-up). Cap reached with **unverified invariants only** (invariant claims the orchestrator could not confirm but no scope violation) → for each file whose invariant remains unverified, require the subagent to either restate the invariant in a falsifiable form (concrete line number + observable property) or declare the file `out-of-scope`. If at least one file retains a verifiable invariant, commit only the files with verified or restated-and-verified invariants. If zero files pass, emit **Blocked** naming the unverifiable claims. In all cases, note unverified invariants in the terminal report.

---

### Phase 4 — Verification gate (inline in the worktree)

Run the project's full test/lint gates in the worktree yourself — do not trust the subagent's report alone.

- All green → Phase 5.
- Failures → iterate: re-dispatch the fix subagent with the failure output as an updated spec (or hand off to `/heal` semantics if that skill is loadable), **≤2 test-failure re-dispatch iterations** (independent of Phase 3.5's manifest-validation counter). Each Phase 4 re-dispatch must also pass through Phase 3.5 manifest validation (with a fresh counter) before the orchestrator commits the resulting changes. Cap reached → keep the worktree, emit **Blocked** naming the branch, the worktree path, the surviving failures, and the per-item status table.

**Completeness check:** every numbered spec item must be `fixed` or explicitly `out-of-scope` with a reason. A partially addressed spec is never reported as Done.

---

### Phase 5 — Push (guarded, with PR state re-check)

- `no_push` set → `worktree keep` (reason: "fix-pr --no-push review pending"), emit the diff summary + per-item table, stop (Done, no remote mutation).
- Otherwise, **re-check PR state before pushing** -- the PR may have been merged or closed during the fix work:
  1. `gh pr view <pr> --json state,mergedAt,mergeCommit` — if `state === "MERGED"`: STOP. Report "PR #N was merged during fix work (merged at `<mergedAt>`, commit `<mergeCommit.oid>`). Fix commits are on branch `<head_branch>` in worktree `<path>` — cherry-pick to a fresh branch if the fixes are still needed." Keep the worktree, emit Done (no push).
  2. If `state === "CLOSED"` (no `mergedAt`): STOP. Report "PR #N was closed without merge during fix work." Keep the worktree, emit Done (no push).
  3. If `state === "OPEN"`: proceed with push.
- `git push origin <head_branch>` from the worktree. **Plain push only -- never `--force`, never `--force-with-lease`, never any other ref.** If push is rejected (non-fast-forward because the PR moved), fetch + rebase the fix commits onto the new head, re-run Phase 4 gates, push again. If still rejected → Blocked.

---

### Phase 6 — Optional re-review (top-level guard)

If `re_review`: invoke `/review` **directly from this top-level session only — NEVER from inside a subagent** (known max_depth self-collision: 100+ `delegation.skipped reason:"max_depth" requested_name:"review"` entries in routing-decisions.jsonl). If the current session is itself a subagent (check `get_runtime_state` depth), skip re-review and note it in the terminal report instead.

**Scope the re-review via `--brief`:** pass the numbered fix spec from Phase 1 as the `--brief` argument to `/review`. This anchors the re-review's spec-compliance assessment to "were these specific items addressed?" rather than a full open-ended sweep. The review skill's stated-intent capture and spec-compliance assessment will assess the fix against the original findings as its spec — findings from other review dimensions (security, api-compat, perf, etc.) are reported normally and unaffected by `--brief`; the spec-compliance dimension flags deviations from the original findings as scope creep or unmet intent, so the reviewer can judge whether the original items were resolved.

**Note:** the manifest gate (Phase 3.5) catches over-broad scope; logic inversions introduced by the fix subagent are caught only when `--re-review` is passed. For high-risk fixes, pass `--re-review` to enable this detection.

---

### Phase 7 — Cleanup & terminal state

- Success: `worktree remove` (branch ref is preserved automatically).
- Failure/Blocked: keep the worktree, name its path and branch in the report.

**Done** must cite: pushed commit SHA(s), the PR URL, the triage table (per-item verdict from Phase 2.5, including items triaged out), the per-item fix table, and test-gate output location.
**Blocked** must cite: exact unblock condition (auth, fork perms, surviving test failures), worktree path, and everything already fixed.
