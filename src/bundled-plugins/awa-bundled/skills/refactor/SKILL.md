---
name: refactor
description: "Orchestrates safe, large-scale structural changes across a codebase — symbol renames, API migrations, pattern standardizations, layer restructurings. Enumerates all affected sites, groups them into dependency layers via the DAG executor, applies changes in parallel per layer with worktree isolation, and verifies behavioral preservation at each layer boundary before proceeding. Exits immediately on first regression, surfacing the exact site, diff, and behavioral delta before any commit."
argument-hint: "<refactor goal> [--scope <glob-or-path>]"
failure_modes:
  - bad decomposition
  - dependency blindness
  - false completeness
  - premature execution
context: fork
---

## Sub-agent contract
/contract

**Skip when:** the change touches ≤3 files and no dependency ordering is required — just edit directly. Also skip when the codebase has no test coverage at all (behavioral preservation cannot be verified; ask the user to add tests first or proceed manually).

---

### Triage (inline, before dispatching any sub-agent)

Parse `$ARGUMENT` to extract:
- **Change type**: rename | api-migration | pattern-standardization | layer-restructure | dependency-upgrade | other
- **Target symbol / path / pattern** (what is changing)
- **Destination** (what it becomes)
- **Scope**: default to the entire repo; narrow if `--scope` is provided

If `$ARGUMENT` is ambiguous on any of the above, stop and ask exactly one question.

---

### Wave 1 — Scope enumeration (parallel, `subagent_type: "research-agent"`)

Dispatch both agents simultaneously in a single response turn.

**Site-finder agent**
- goal: Enumerate every file and symbol that must change for the refactor to be complete and correct.
- inputs: change type, target symbol/pattern, scope glob
- artifacts:
  - `sites`: array of `{file, line_range, site_type: "definition"|"import"|"usage"|"type-ref"|"test", change_required: string}`
  - `dependency_graph`: for each site, which other sites must be changed first (a site depends on its callers if it exports a symbol; a definition must be changed before its imports)
  - `site_count`: integer
  - `confidence`: low | medium | high
  - `coverage_gaps`: what the agent couldn't search (generated files, third-party vendored code, etc.)
- non_goals: Do not apply any changes. Do not read unrelated files.
- failure_modes: If grep tooling is unavailable, return `confidence: low` and list what was searched manually.

**Contract-extractor agent**
- goal: Identify the public interfaces and test commands that verify behavioral preservation for the affected API surface.
- inputs: site list (from site-finder, passed inline if available; if not yet available, derive from change type + scope)
- artifacts:
  - `contracts`: array of `{symbol, signature_before, exported_by, consumed_by[]}`
  - `test_commands`: array of shell commands that exercise the affected contracts (e.g., `pnpm test -- --grep "AuthService"`)
  - `test_coverage_verdict`: "adequate" | "partial" | "absent"
  - `confidence`: low | medium | high
  - `coverage_gaps`: test paths not reachable by the identified commands
- non_goals: Do not run tests. Do not read unrelated files.

**Scope gate (after Wave 1):**
- `site_count > 50` → warn the user: "This refactor touches N sites. Recommend scoping down with `--scope` or batching via `/parallelize`. Proceeding, but each layer will take longer."
- `test_coverage_verdict == "absent"` → hard stop: "No tests cover the affected contracts. Behavioral preservation cannot be verified. Add tests before proceeding, or explicitly confirm you accept unverified risk."
- Either agent returns `confidence: low` → surface the coverage gaps and ask the user to confirm before proceeding.

---

### Synthesize: Build the layer map (inline)

From `dependency_graph`, compute a topological sort into layers using Kahn's algorithm:
- **Layer 0** — leaf sites with no dependents (definitions that nothing imports, or sites that depend on nothing else changing first)
- **Layer N** — sites whose dependencies are all in layers 0…N-1

If the graph has cycles (rare but possible in circular-import codebases), surface them explicitly: "Cycle detected between [A, B, C]. Manual intervention required before automation can proceed." Do not continue.

---

### Wave 2 — Layer-by-layer application (sequential between layers, parallel within each layer)

For **each layer** (starting at Layer 0):

Dispatch one sub-agent per site in this layer, all in parallel, each in a worktree-isolated environment:

**Layer applicator agent** (per site, `isolation: "worktree"`)
- goal: Apply the transformation at exactly this site and verify it passes its targeted tests.
- inputs: site descriptor `{file, line_range, change_required}`, full transformation spec (target → destination), test commands that cover this site
- artifacts:
  - `site`: `{file, line_range}`
  - `status`: "green" | "red" | "skipped"
  - `diff_applied`: the exact unified diff applied (≤30 lines; truncate with `...` if longer)
  - `test_output`: truncated stdout of the targeted test run (last 20 lines)
  - `failure_reason`: populated only if `status == "red"` — the first failing assertion + the file:line where it fired
- non_goals: Do not change any file other than the one in your site descriptor. Do not run the full test suite.
- IMPORTANT: this sub-agent MAY call `edit_file` and run bash commands; `isolation: "worktree"` is required.

**Layer gate — hard stop before proceeding to the next layer:**
- All sites in this layer `status == "green"` → proceed to the next layer.
- Any site `status == "red"` → **abort the entire refactor immediately**. Do NOT apply any more changes. Surface:
  - The failing site (`file:line_range`)
  - The `diff_applied` for that site
  - The `failure_reason`
  - The current layer number and which layers (if any) already completed successfully
  - Recommendation: "Revert layer N changes manually or run `git stash` in each affected worktree, then diagnose with `/diagnose`."

---

### Wave 3 — Behavioral diff verification (after all layers green, `subagent_type: "research-agent"` or Bash-capable)

Dispatch a single behavioral-diff agent:

**Behavioral-diff agent** (`isolation: "worktree"`, Bash-capable)
- goal: Run the full test suite and compare observable behavior at the API boundary before vs. after.
- inputs: `test_commands` from the contract-extractor, plus any project-wide test command (inferred from `package.json`, `Makefile`, etc.)
- artifacts:
  - `full_suite_status`: "all-green" | "failures"
  - `failing_tests`: array of `{test_name, file, failure_reason}` (empty if all-green)
  - `behavioral_deltas`: array of `{symbol, before_behavior, after_behavior, expected: true|false}` — note only deltas, not noise
  - `unexpected_deltas`: subset of `behavioral_deltas` where `expected == false`
  - `confidence`: low | medium | high
- non_goals: Do not commit. Do not push.

**Post-Wave 3 decision:**
- `full_suite_status == "all-green"` AND `unexpected_deltas` is empty → proceed to synthesis, recommend commit.
- `full_suite_status == "failures"` OR `unexpected_deltas` is non-empty → surface the unexpected deltas for human review. Do NOT commit. Recommend: "Review unexpected behavioral changes before committing. If intentional, update tests to reflect new contracts. If not, route to `/diagnose`."

---

### Synthesis: Change report

Emit a structured change report:

```
## Refactor Report

**Goal:** <change type> — <target> → <destination>

**Scope:**
- Sites enumerated: N
- Layers processed: M (of M total)
- Status: COMPLETE | ABORTED AT LAYER N

**Changes applied:**
| File | Lines | Type | Status |
|------|-------|------|--------|

**Tests run:**
- Targeted (per-site): N runs, N green, N red
- Full suite: all-green | N failures

**Behavioral deltas:**
- Expected: N
- Unexpected: N (see below if non-zero)

**Recommendation:** COMMIT | REVIEW REQUIRED | ABORT
```

If recommendation is COMMIT, offer to invoke `/ship` for the final commit + PR. If REVIEW REQUIRED or ABORT, do not invoke `/ship` and do not commit.
