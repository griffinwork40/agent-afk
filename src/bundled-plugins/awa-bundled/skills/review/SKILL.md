---
name: review
description: "Dispatches parallel dimension agents across a diff, PR (URL or number), commit SHA, branch, staged changes, or patch file — covering security, correctness, api-compat, test-coverage, and perf-observability — synthesizes findings by severity, and emits a merge recommendation. Use when changes are ready for review before merge. Read-only: this skill analyzes and reports only — it never edits files, commits, pushes, comments on a PR, or modifies the PR description."
argument-hint: "[diff|pr-url|pr-number|commit-sha|branch|--staged|--head] [--light] [--change-type hotfix|feature|refactor|dep-bump|new-service] [--post github|telegram]"
context: fork
---

## Read-only — hard constraint

This skill **analyzes and reports**; it never mutates the repository, the PR/MR, or anything external. After you emit the merge recommendation, **STOP**.

Never — not for a real bug, not for a blocking defect, not even when there is no human reviewer and "someone has to fix it":
- edit, create, or delete files (no `write`/`edit`-style mutations);
- `git add` / `commit` / `stash` / `reset`, `git checkout` to discard changes, or `git push`;
- `gh pr comment` / `review` / `edit` / `merge` / `create`, or post or edit any PR/MR body, comment, or description;
- run any other write- or network-mutating shell command.

The only shell permitted is **read-only inspection**: `git diff` / `git show` / `gh pr diff`, `grep` / `rg`, and file reads — plus dispatching the review sub-agents. Resolving findings, fixing bugs, resolving merge conflicts, and "making the branch mergeable" are explicitly **out of scope**: a fixable defect is a finding to report (`file:line` + a one-line fix in the `suggestion` field), never a license to act.

## Sub-agent contract
/contract

**Skip for:** lock files (`package-lock.json`, `go.sum`, `yarn.lock`), auto-generated files (`*.generated.*`), pure-docs diffs, vendored deps.

**Resolve target → diff (inline).** The review target argument is: `$ARGUMENT` (empty = review working-tree/HEAD changes). Map this argument to a diff source, then capture the diff text plus a one-line target descriptor for the triage header. Also capture the **reviewed ref** (branch HEAD SHA or equivalent) — this is required for citation verification later:

- `--staged` → `git diff --staged`; reviewed ref = `git write-tree` (snapshots the staged index to a throwaway tree so citations resolve against the staged content under review, not HEAD)
- `--head` or no arg → `git diff HEAD`; reviewed ref = `git stash create` (snapshots worktree + index to a throwaway commit so citations resolve against the content under review; empty output = no local changes → fall back to `git rev-parse HEAD`)
- arg matches `^https?://.*/pull/\d+` (GitHub/GitLab PR URL) → `gh pr diff <url>` (or `glab mr diff`); reviewed ref = head SHA from `gh pr view <url> --json headRefOid -q .headRefOid`; record PR title + base/head refs
- arg matches `^#?\d+$` (bare PR number, optionally `#`-prefixed) → resolve in current repo with `gh pr diff <n>`; reviewed ref = head SHA from `gh pr view <n> --json headRefOid -q .headRefOid`; if `gh` is unavailable or repo has no PR matching, abort with `Asking` (one question: which repo/PR)
- arg matches `^[0-9a-f]{7,40}$` (commit SHA) → `git show <sha>`; reviewed ref = `<sha>`
- arg matches a known ref (`git rev-parse --verify <arg>` succeeds) → `git diff <merge-base>...<arg>` against the repo's default branch; reviewed ref = `git rev-parse <arg>`
- arg is a path or `*.diff`/`*.patch` file → read file contents as the diff; reviewed ref = `unknown (patch file — no live ref available)`
- otherwise → abort with `Asking` naming the ambiguous arg

**Triage (inline).** From the resolved diff extract: change type (hotfix | feature | refactor | dep-bump | new-service), files changed, total lines changed, summary. Classify regime: `light` if ≤300 lines or change type is hotfix/dep-bump; `full` otherwise.

**Wave 1 — Full review (regime=full, 2 parallel agents, `subagent_type: "research-agent"`).** Dispatch:
- **security · api-compat** — contracts, auth, injection, breaking changes, secret exposure.
- **correctness · test-coverage · perf-observability** — logic bugs, missing tests, regressions, hot-path perf, logging gaps.

Each agent receives: full diff + file tree + triage header + **reviewed ref (SHA)**, the severity rubric, and the finding schema.

**Citation requirement (enforced per agent):** Before quoting any line in a `blocking` or `high/critical` finding, the agent MUST read that exact line from the branch HEAD using `git show <reviewed-ref>:<file>` (or `gh api /repos/{owner}/{repo}/contents/{path}?ref=<sha>` if outside a git context). The agent must:
1. State the ref it read from in each finding: `ref: <sha>`.
2. Distinguish `diff-context` citations (line visible in the diff hunk, no re-read required) from `file-state` citations (line in the post-merge file, re-read required before quoting).
3. If the line does not exist at that ref, omit the finding entirely — do not paraphrase or reconstruct from memory.

Banned words: "ensure", "consider", "may", "could". No `file:line` citation → omit the finding.

**api-compat reachability pre-check (mandatory before surfacing any breaking-change finding).**
For every symbol flagged as a breaking change, grep production source files (exclude `*.test.*`, `*.spec.*`, `__tests__/`, `__mocks__/`, `/test/`, `/tests/`) for imports or usages of that symbol. Decision table:
- Zero production importers → downgrade finding to `nit`, append `[UNVERIFIED: no production importers]`, set confidence `low`.
- One or more production importers → severity stands; include one importer path as evidence.

If grep tooling is unavailable, tag the finding `[UNVERIFIED: reachability not checked]` and downgrade one severity tier.

**Absence-claim grounding (mandatory for any claim that something does not exist).** Before emitting a finding of the form "no test covers X", "no handler validates Y", "no caller invokes Z", "X is not tested": grep the production tree (`rg --no-heading -n <pattern>` or `git grep -n <pattern>`) for plausible match strings. Decision table:
- Zero matches → finding stands; cite the grep command in the evidence field.
- One or more matches → emit `unverified — absence claim refuted by <path>:<line>` instead of the finding.
- Grep tooling unavailable or claim cannot be reduced to a pattern → tag finding `[UNVERIFIED: absence not checked]` and downgrade one severity tier.

This is the agent's first-line self-check; **Wave 1.5 Check B** independently re-verifies any surviving absence claims against the reviewed ref as a backstop.

**Wave 1 — Light review (regime=light, 1 agent, `subagent_type: "research-agent"`).** Single agent covers all dimensions. Same rubric, schema, and citation requirement.

**Wave 1.5 — Citation + absence-claim verification (1 agent, `subagent_type: "research-agent"`).** Run after Wave 1 returns, before Wave 2 synthesis. This agent performs two independent checks.

**Check A — Citation verification.** Extracts every `file:line` citation from any `blocking`, `critical`, or `high` finding across all Wave 1 results. For each citation, runs `git show <reviewed-ref>:<file>` (or equivalent) and checks whether the quoted evidence snippet actually appears at that line in the reviewed ref — not in main, not in diff context alone. Classifies each citation as:
- `verified` — content matches what is actually at that line on the reviewed ref.
- `diff-only` — line appears in the diff hunk but no longer exists at the reviewed ref HEAD (e.g., deleted block). Finding must be downgraded: the issue may already be resolved.
- `fabricated` — line does not exist at the reviewed ref and was not in the diff hunk; the evidence snippet is unverifiable. Finding is **dropped** from the report.

**Check B — Absence-claim verification.** Extracts every **absence claim** from blocking/critical/high findings — claims of the form "no test covers X", "no handler validates Y", "no caller invokes Z", "X is not tested", "Y has no validation". Citations are not required for absence claims, so Check A cannot catch them; they need their own gate. For each, identify the asserted-absent symbol, test name, or behavior, then run `git grep -n <pattern> <reviewed-ref>` (or `rg --no-heading -n <pattern>` if outside a git context) across the production tree (exclude the same paths as the api-compat reachability check: tests, mocks, fixtures, when the claim is about production code). Classify as:
- `confirmed-absent` — zero matches in the asserted scope; finding stands.
- `false-absent` — one or more matches in the asserted scope; finding is **dropped** (the asserted-absent entity exists at the reviewed ref). Name the matching path(s) in the dropped-findings manifest.
- `grep-unavailable` — tooling missing, symbol ambiguous, or absence claim cannot be reduced to a grep pattern; finding tagged `[UNVERIFIED: absence not checked]` and downgraded one severity tier.

Returns a combined verification manifest: `[{type: citation|absence, claim, status, finding_id, evidence?}]`. Findings classified `fabricated` (citation) or `false-absent` (absence) are excluded from Wave 2 input. `diff-only` citations are passed to Wave 2 with a `⚠ diff-only citation — line absent at the reviewed ref` annotation and auto-downgraded one severity tier. `grep-unavailable` absence claims are passed through with their `[UNVERIFIED]` tag intact.

**Wave 2 — Synthesis (1 agent, `subagent_type: "research-agent"`).** Receives: Wave 1 findings **after** citation-verification filtering + manifest of dropped/downgraded citations. Dedup by `(file, line_range, dimension)` — keep highest severity on exact match. Flag cross-agent conflicts as `CONFLICT` blocks (surface both rationales; do not auto-resolve).

**Severity sort order within the blocking list:** findings tagged with semantics matching `invariant violation`, `defeats stated purpose`, `defeats refactor goal`, or `breaks stated contract` sort above all other `high` findings, even those with higher mechanical severity (e.g. test/build hygiene). Within that group, sort by tier (critical → high). Mechanical findings (missing test, build hygiene) sort last within their tier.

Sort overall: critical → high → medium → low → nit; security first within tier; semantic/invariant findings above mechanical findings within tier. Template-fill summary block. Emit merge decision: **DO NOT MERGE**, **MERGE**. This is the terminal step — after emitting the decision, STOP. Do not act on any finding: no edits, commits, pushes, or PR/MR mutations. A blocking bug is a finding to report, not a fix to apply.

**Severity rubric:**
- `critical` — data loss, auth bypass, secret exposure, RCE. If it cannot cause unauthorized access or data loss, it is NOT critical.
- `high` — wrong output under reachable conditions (reachable = called from production code, not tests-only)
- `medium` — missing edge case, perf degraded under load, deprecated API
- `low` — missing test, unclear error message
- `nit` — naming, formatting

Confidence `low` → auto-downgrade one tier + append `[low confidence — verify with runtime context]`.

**Output per dimension:** if you have read the file(s) at the reviewed ref and have either real findings or a confirmed clean read, emit findings or `no issues found — read <file> at <ref>`. If evidence is insufficient — you could not read the file, the tool was unavailable, no production importers were found for the symbol, or no test file exists at the asserted path — emit `unverified — <reason>` naming the missing evidence rather than invent a finding to fill the slot. Banned words from the hedging list (`ensure`, `consider`, `may`, `could`) remain banned **inside findings**; the `unverified` channel is the sanctioned path for uncertainty.

**Finding schema:** `severity · confidence · dimension · file:line_range · ref:<sha> · citation-type:(diff-context|file-state) · finding (one concrete sentence naming the failure mode) · evidence (verbatim code ≤4 lines) · suggestion (one concrete fix)`.

**Epistemic scope disclosure (required in synthesis output).** The "What was not checked" section must include:
- Which ref(s) Wave 1 agents actually read from (list the SHA or `unknown` if patch-file input). Example: `Read against branch HEAD abc1234 — citations verified at that ref.`
- If any citations could not be verified against a live ref (patch-file input): `Citation verification skipped — no live ref available; diff-context citations only.`
- Any topical gaps (e.g. 'did not review Telegram surface', 'did not run tests').

**Post-synthesis:** if any `critical` or `high` finding is present, invoke `/shadow-verify` on those findings before surfacing to the user. Shadow-verify independently re-derives each top-severity claim against source; fabricated or unsupportable findings drop here before they reach the merge decision. `medium` and below go straight through.
