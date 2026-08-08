---
name: review
description: "Dispatches parallel dimension agents across a diff, PR (URL or number), commit SHA, branch, staged changes, or patch file — covering security, correctness, api-compat, test-coverage, and perf-observability — synthesizes findings by severity, and emits a merge recommendation. Use when changes are ready for review before merge. Read-only: this skill analyzes and reports only — it never edits files, commits, pushes, comments on a PR, or modifies the PR description."
argument-hint: "[diff|pr-url|pr-number|commit-sha|branch|--staged|--head] [--light] [--change-type hotfix|feature|refactor|dep-bump|new-service] [--post github|telegram] [--brief <text>|--spec <path>]"
context: load
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

**Capture stated intent (inline).** A reviewer that sees *what changed* but not *what it was meant to accomplish* cannot judge whether the change does its job — it silently redefines "the spec" as whatever the diff or the repo's global constraints imply, and rubber-stamps. Capture the change's stated intent into a `stated-intent` field passed to every agent:
- `--brief "<text>"` / `--spec <path>` supplied → use that text / file contents verbatim (highest priority).
- PR URL or number → `gh pr view <ref> --json title,body -q '.title + "\n\n" + .body'` (or `glab mr view`); title + description are the intent.
- commit SHA → the full commit message: `git show -s --format=%B <sha>`.
- known ref / branch → the branch's PR body if one exists (`gh pr view <branch> --json body -q .body`), else the commit subjects: `git log --format=%s <merge-base>..<ref>`.
- `--staged` / `--head` / working-tree / patch-file with no `--brief` → set `stated-intent = "(none supplied)"`.

Never fabricate intent. When none is available the value is the literal `(none supplied)`; agents disclose its absence rather than guess.

**Triage (inline).** From the resolved diff extract: change type (hotfix | feature | refactor | dep-bump | new-service), files changed, total lines changed, summary. Classify regime: `light` if ≤300 lines or change type is hotfix/dep-bump; `full` otherwise.

**Concurrency floor — declared, conditional, and enforced.** *Through synthesis*, a full-regime review peaks at **2 concurrent sub-agent sessions** (Wave 1's two dimension agents) and dispatches **3 in total** (Wave 1 ×2, then Wave 2 ×1, sequential). Wave 1.5 runs inline in the orchestrator and dispatches nothing. **No wave nests a child**: the sub-agents are shell-less by design, and nothing in this skill requires them to run a command, so none of them needs to nest a `git-investigator` to comply. If you add a requirement here that needs a shell, you have silently doubled this floor — put that requirement in Wave 1.5 instead.

**The post-synthesis tail is the conditional half of that budget.** A review that surfaces a `critical`/`high` finding invokes `/shadow-verify` (see **Post-synthesis** below), which dispatches one verifier per claim in parallel — so the whole-run budget is **peak 3 concurrent, 5–6 total**, and it lands on exactly the high-stakes reviews most likely to hit a rate ceiling. Bound it: **at most 3 claims in a single round, no repeat rounds**, and hand the verifiers Wave 1.5's manifest so each re-derives the *claim* instead of re-locating evidence Wave 1.5 already pinned at the ref. Wave 1.5 verifies that a citation is real; shadow-verify re-derives whether the inference drawn from it holds — never substitute one for the other.

**Wave 1 — Full review (regime=full, 2 parallel agents, `subagent_type: "research-agent"`).** Dispatch:
- **security · api-compat** — contracts, auth, injection, breaking changes, secret exposure.
- **correctness · spec-compliance · test-coverage · perf-observability** — logic bugs, regressions, whether the change satisfies its **stated intent** (unmet requirement or unrequested scope creep), missing tests, hot-path perf, logging gaps.

Each agent receives: full diff + file tree + triage header + **reviewed ref (SHA)** + the **stated intent** (what the change is meant to accomplish, or `(none supplied)`), the severity rubric, and the finding schema.

**Citation requirement (enforced per agent).** Wave 1 agents cite from the diff and from file reads available in their own session. They do **not** run git and do **not** re-read at the reviewed ref — that verification is centralized in Wave 1.5 below, which re-reads every `blocking`/`critical`/`high` citation **and every `file-state` citation at any severity** at the ref, then drops the fabricated ones. Each agent must:
1. State the reviewed ref it was given in each finding: `ref: <sha>`.
2. Classify every citation as `diff-context` (line visible in the diff hunk) or `file-state` (line in the post-merge file, not visible in the hunk). Tag every `file-state` citation `[UNVERIFIED: not re-read]` so Wave 1.5 knows to check it — a Wave 1 `Read` observes the **working tree**, which equals the reviewed ref only when that ref is the checked-out HEAD, so for a PR, branch, or commit target that is not checked out locally the tag is load-bearing, not decorative.
3. Never paraphrase or reconstruct a line from memory. If the line is not visible in the diff, cite it as `file-state` and let Wave 1.5 resolve it — do not invent the content.

**Invariant — why Wave 1 does not run git.** `research-agent` has no shell (`tools: Read, Grep, Glob, WebFetch, WebSearch, Agent(git-investigator)` — no `Bash`, and that single `Agent(...)` entry is the nesting path this rule closes), so a mandatory `git show` forces it to dispatch a nested `git-investigator` purely to run one command. That doubles the concurrent session count of *every* Wave 1 agent, and is the structural cause of the rate-limit cascade in #726. Ref-anchored verification is therefore performed once, centrally, by a shell-capable actor — never N times by shell-less ones. Do not reintroduce a per-agent re-read here.

Banned words: "ensure", "consider", "may", "could". No `file:line` citation → omit the finding.

**Spec-compliance assessment (mandatory framing for the spec-compliance dimension).** Judge the diff against the `stated-intent` — not against the diff's own apparent goals, and not against the repo's global constraints:
- `stated-intent` present → flag (a) **unmet intent**: a requirement named in the intent with no implementing change, and (b) **scope creep**: a substantive behavior change the intent does not call for. Cite the unmet clause for gaps; cite `file:line` for creep.
- `stated-intent` is `(none supplied)` → do **not** assess spec-compliance and do **not** substitute the global constraints for the spec. Emit exactly one line: `unverified — spec-compliance not assessed: no stated intent supplied (pass --brief/--spec, or review a PR/commit)`. Silently treating the diff or the constraints as "the spec" is the precise failure this rule prevents.

**api-compat reachability pre-check (mandatory before surfacing any breaking-change finding).**
For every symbol flagged as a breaking change, search production source files with the `Grep` tool — which needs no shell, so this check never forces a nested dispatch — for imports or usages of that symbol, excluding `*.test.*`, `*.spec.*`, `__tests__/`, `__mocks__/`, `/test/`, `/tests/`. Decision table:
- Zero production importers → downgrade finding to `nit`, append `[UNVERIFIED: no production importers]`, set confidence `low`.
- One or more production importers → severity stands; include one importer path as evidence.

If the `Grep` tool is unavailable, tag the finding `[UNVERIFIED: reachability not checked]` and downgrade one severity tier.

**Absence-claim grounding (mandatory for any claim that something does not exist).** Before emitting a finding of the form "no test covers X", "no handler validates Y", "no caller invokes Z", "X is not tested": search the production tree with the `Grep` tool — which needs no shell, so this check never forces a nested dispatch — for plausible match strings. Decision table:
- Zero matches → finding stands; cite the search pattern in the evidence field.
- One or more matches → emit `unverified — absence claim refuted by <path>:<line>` instead of the finding.
- Grep tooling unavailable or claim cannot be reduced to a pattern → tag finding `[UNVERIFIED: absence not checked]` and downgrade one severity tier.

This is the agent's first-line self-check; **Wave 1.5 Check B** independently re-verifies any surviving absence claims against the reviewed ref as a backstop.

**Wave 1 — Light review (regime=light, 1 agent, `subagent_type: "research-agent"`).** Single agent covers all dimensions (including spec-compliance). Same `stated-intent` input, rubric, schema, and citation requirement.

**Wave 1.5 — Citation + absence-claim verification (INLINE — run by the orchestrator, dispatches nothing).** Run after Wave 1 returns, before Wave 2 synthesis. The orchestrator already holds exactly the read-only shell this verification needs (`git show` / `git diff` / `gh pr diff` / `grep` / `rg` — see the shell grant above), so running it inline costs **zero** additional sessions and zero nesting. A shell-less sub-agent here would have to nest a `git-investigator` to run the very commands the orchestrator can already run. Two independent checks:

**Check A — Citation verification.** Extracts (a) every `file:line` citation from any `blocking`, `critical`, or `high` finding, **and (b) every citation tagged `file-state` at any severity** — `medium`, `low`, and `nit` included — across all Wave 1 results. Both sets are checked, because Wave 1 never re-reads at the ref: an unverified `file-state` citation in a `low` finding is exactly as fabricable as one in a `high` finding, and quoting a line absent from the reviewed change is a defect at every tier. For each citation, runs `git show <reviewed-ref>:<file>` (or equivalent) and checks whether the quoted evidence snippet actually appears at that line in the reviewed ref — not in main, not in diff context alone. Classifies each citation as:
- `verified` — content matches what is actually at that line on the reviewed ref.
- `diff-only` — line appears in the diff hunk but no longer exists at the reviewed ref HEAD (e.g., deleted block). Finding must be downgraded: the issue may already be resolved.
- `fabricated` — line does not exist at the reviewed ref and was not in the diff hunk; the evidence snippet is unverifiable. Finding is **dropped** from the report.

**Check B — Absence-claim verification.** Extracts every **absence claim** across all Wave 1 results **at any severity** — `medium`, `low`, and `nit` included, for the same reason Check A checks every `file-state` citation: Wave 1's absence grounding is a self-check by an agent that never re-read at the ref, so an unverified absence claim in a `low` finding is exactly as fabricable as one in a `high` finding. These are claims of the form "no test covers X", "no handler validates Y", "no caller invokes Z", "X is not tested", "Y has no validation". Citations are not required for absence claims, so Check A cannot catch them; they need their own gate. For each, identify the asserted-absent symbol, test name, or behavior, then run `git grep -n <pattern> <reviewed-ref>` (or `rg --no-heading -n <pattern>` if outside a git context) across the production tree (exclude the same paths as the api-compat reachability check: tests, mocks, fixtures, when the claim is about production code). Classify as:
- `confirmed-absent` — zero matches in the asserted scope; finding stands.
- `false-absent` — one or more matches in the asserted scope; finding is **dropped** (the asserted-absent entity exists at the reviewed ref). Name the matching path(s) in the dropped-findings manifest.
- `grep-unavailable` — tooling missing, symbol ambiguous, or absence claim cannot be reduced to a grep pattern; finding tagged `[UNVERIFIED: absence not checked]` and downgraded one severity tier.

Returns a combined verification manifest: `[{type: citation|absence, claim, status, finding_id, evidence?}]`. Findings classified `fabricated` (citation) or `false-absent` (absence) are excluded from Wave 2 input. `diff-only` citations are passed to Wave 2 with a `⚠ diff-only citation — line absent at the reviewed ref` annotation and auto-downgraded one severity tier. `grep-unavailable` absence claims are passed through with their `[UNVERIFIED]` tag intact.

**Wave 2 — Synthesis (1 agent, `subagent_type: "research-agent"`).** Receives: Wave 1 findings **after** citation-verification filtering + manifest of dropped/downgraded citations. Dedup by `(file, line_range, dimension)` — keep highest severity on exact match. Flag cross-agent conflicts as `CONFLICT` blocks (surface both rationales; do not auto-resolve).

**Severity sort order within the blocking list:** findings tagged with semantics matching `invariant violation`, `defeats stated purpose`, `defeats refactor goal`, or `breaks stated contract` sort above all other `high` findings, even those with higher mechanical severity (e.g. test/build hygiene). Within that group, sort by tier (critical → high). Mechanical findings (missing test, build hygiene) sort last within their tier.

Sort overall: critical → high → medium → low → nit; security first within tier; semantic/invariant findings above mechanical findings within tier. Template-fill summary block.

**Merge-decision rule (mandatory — do not improvise a threshold).**

Severity and disposition are **separate axes**. `severity` answers "how bad is this defect?" — it is a property of the finding. `blocking` answers "does this prevent merge?" — it is policy. Never let one silently encode the other.

Every finding carries an explicit `blocking: true|false`, assigned from this default table:

| severity | default `blocking` |
|---|---|
| `critical` | true |
| `high` | true |
| `medium` | true |
| `low` | false |
| `nit` | false |

**Overrides (each requires a one-clause justification appended to the finding):**
- A `medium` may be marked `blocking: false` when it is a bounded, non-data-affecting defect the author can reasonably land and follow up — e.g. a rare-input formatting error with no downstream consumer.
- A `medium` in the `security` dimension is **never** overridable to `false`; today's narrow reachability is tomorrow's incident.
- A `medium` representing a material data-integrity risk or a likely production failure under normal usage is **never** overridable to `false` — a race that intermittently loses user state stays blocking even when its blast radius keeps it out of `high`.
- A `low` or `nit` may be marked `blocking: true` only for a stated external constraint (release gate, compliance requirement). Do not use this to smuggle a preference.

Emit **DO NOT MERGE** when one or more findings carry `blocking: true` after Wave 1.5 filtering. Emit **MERGE** only when every surviving finding is `blocking: false`.

State the counts that drove the decision on the same line, **with a dimension breakdown for any blocking medium**, e.g. `Decision: DO NOT MERGE — 1 high, 2 medium blocking (1 security, 1 correctness); 1 medium waived, 3 low.` or `Decision: MERGE — 0 blocking (2 medium waived, 3 low, 1 nit).` If zero findings survived, say `Decision: MERGE — 0 findings.` Never emit a bare verdict with no counts, and never waive a finding silently — a waived medium must appear in the count with its justification.

This is the terminal step — after emitting the decision, STOP. Do not act on any finding: no edits, commits, pushes, or PR/MR mutations. A blocking bug is a finding to report, not a fix to apply.

**Severity rubric (impact axis only — severity measures blast radius and reachability, never category):**
- `critical` — data loss, auth bypass, secret exposure, RCE. If it cannot cause unauthorized access or data loss, it is NOT critical.
- `high` — produces wrong output or an unsafe state under reachable conditions (reachable = called from production code, not tests-only)
- `medium` — produces wrong output or an unsafe state, but only under narrow, rare, or hard-to-reach conditions
- `low` — does not affect production behavior today: missing test, unclear error message, doc/PR-body mismatch, dead code, stale comment, deprecated API with no removal date, perf concern with no load evidence
- `nit` — naming, formatting; no behavioral claim at stake

**A category is never a tier by itself.** Re-home by impact, not by kind:
- "missing edge case" → `high` if reachable in production and wrong; `medium` if reachable but rare; `low` if only reachable from tests.
- "perf degraded under load" → `high` if unbounded or production-breaking; `medium` if bounded but measured; `low` if theoretical with no load evidence.
- "deprecated API" → `low` by default; `high` only when a hard removal date will break a production call path.

Confidence `low` → auto-downgrade one tier + append `[low confidence — verify with runtime context]`.

**Output per dimension:** if you have read the relevant file(s) and have either real findings or a confirmed clean read, emit findings or `no issues found — read <file>`. If evidence is insufficient — you could not read the file, the tool was unavailable, no production importers were found for the symbol, or no test file exists at the asserted path — emit `unverified — <reason>` naming the missing evidence rather than invent a finding to fill the slot. Banned words from the hedging list (`ensure`, `consider`, `may`, `could`) remain banned **inside findings**; the `unverified` channel is the sanctioned path for uncertainty.

**Finding schema:** `severity · blocking:(true|false) · confidence · dimension · file:line_range · ref:<sha> · citation-type:(diff-context|file-state) · finding (one concrete sentence naming the failure mode) · evidence (verbatim code ≤4 lines) · suggestion (one concrete fix)`. When `blocking` departs from the default table, append `· waived: <one clause>` (or `· escalated: <one clause>`) naming the reason.

**Epistemic scope disclosure (required in synthesis output).** The "What was not checked" section must include:
- Which ref citations were verified against in Wave 1.5 (list the SHA or `unknown` if patch-file input). Example: `Citations verified inline against branch HEAD abc1234.`
- If any citations could not be verified against a live ref (patch-file input): `Citation verification skipped — no live ref available; diff-context citations only.`
- Any topical gaps (e.g. 'did not review Telegram surface', 'did not run tests').
- Whether a **stated intent** was available and spec-compliance was assessed. Example: `Stated intent: PR #123 title+body — spec-compliance assessed.` or `Stated intent: (none supplied) — spec-compliance not assessed.`

**Post-synthesis:** if any `critical` or `high` finding is present, invoke `/shadow-verify` on those findings before surfacing to the user. Shadow-verify independently re-derives each top-severity claim against source; fabricated or unsupportable findings drop here before they reach the merge decision. `medium` and below go straight through.
