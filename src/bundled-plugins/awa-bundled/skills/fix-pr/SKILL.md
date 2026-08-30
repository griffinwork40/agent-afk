---
name: fix-pr
description: "One-verb pipeline for the operator's highest-frequency manual loop: fetch a PR's unresolved reviewer feedback (inline review comments, review-summary bodies, and issue-level conversation comments) and failing CI checks, fix them in an isolated managed worktree via a budget-bounded subagent, verify with the project's test gates, and push the fix back to the PR branch. Replaces the retyped recipe 'send a subagent in a worktree to fix <PR feedback>, then push.' Use when a PR has review comments or red CI that needs addressing — e.g. 'fix pr 286', 'address the review on #215', 'CI is red on the worktree-sweep PR'. Never force-pushes, never touches main, fails closed on missing gh auth or un-pushable fork PRs."
when-to-use: "A PR has review feedback or red CI that needs fixing."
argument-hint: "<PR-number-or-URL> [--repo <path>] [--no-push] [--re-review]"
surface: "afk"
failure_modes:
  - push to wrong branch
  - nested /review max_depth self-collision
  - silent partial fix (some comments addressed, done claimed for all)
  - unmanaged worktree leak
---

## Sub-agent contract
/contract

`fix-pr` turns "review feedback / red CI on PR N" into a pushed fix commit with test evidence, using worktree isolation so the operator's working tree is never disturbed. It is the composition the operator previously chained by hand: `/resolve`-style feedback interpretation + managed worktree + budget-bounded fix subagent + test gate + push.

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

### Phase 3 — Fix dispatch (one subagent, budget-bounded)

Size the dispatch per `/right-size-delegation` if available; defaults otherwise:

Dispatch ONE implementation subagent (`agent` tool, `cwd: <worktree path>`, `max_turns: 25`, model right-sized to the diff — `sonnet` default, `haiku` never for code fixes):
- inputs: the numbered fix spec, `head_branch`, repo test/lint commands (inferred from package.json / Makefile / pyproject.toml and passed explicitly).
- goal: address every numbered item with minimal diffs; run the narrowest relevant tests per item; commit locally with a message referencing the PR (`fix(pr-<pr>): address review feedback`).
- non_goals: do NOT push, do NOT touch branches other than the checked-out one, do NOT invoke /review or any skill, do NOT expand scope beyond the numbered items.
- deliverable: per-item status table (`fixed` | `out-of-scope <reason>`), unified diff summary, targeted test output, local commit SHA.

---

### Phase 4 — Verification gate (inline in the worktree)

Run the project's full test/lint gates in the worktree yourself — do not trust the subagent's report alone.

- All green → Phase 5.
- Failures → iterate: re-dispatch the fix subagent with the failure output as an updated spec (or hand off to `/heal` semantics if that skill is loadable), **≤2 iterations**. Cap reached → keep the worktree, emit **Blocked** naming the branch, the worktree path, the surviving failures, and the per-item status table.

**Completeness check:** every numbered spec item must be `fixed` or explicitly `out-of-scope` with a reason. A partially addressed spec is never reported as Done.

---

### Phase 5 — Push (guarded)

- `no_push` set → `worktree keep` (reason: "fix-pr --no-push review pending"), emit the diff summary + per-item table, stop (Done, no remote mutation).
- Otherwise: `git push origin <head_branch>` from the worktree. **Plain push only — never `--force`, never `--force-with-lease`, never any other ref.** If push is rejected (non-fast-forward because the PR moved), fetch + rebase the fix commits onto the new head, re-run Phase 4 gates, push again. If still rejected → Blocked.

---

### Phase 6 — Optional re-review (top-level guard)

If `re_review`: invoke `/review` **directly from this top-level session only — NEVER from inside a subagent** (known max_depth self-collision: 100+ `delegation.skipped reason:"max_depth" requested_name:"review"` entries in routing-decisions.jsonl). If the current session is itself a subagent (check `get_runtime_state` depth), skip re-review and note it in the terminal report instead.

---

### Phase 7 — Cleanup & terminal state

- Success: `worktree remove` (branch ref is preserved automatically).
- Failure/Blocked: keep the worktree, name its path and branch in the report.

**Done** must cite: pushed commit SHA(s), the PR URL, the per-item fix table, and test-gate output location.
**Blocked** must cite: exact unblock condition (auth, fork perms, surviving test failures), worktree path, and everything already fixed.
