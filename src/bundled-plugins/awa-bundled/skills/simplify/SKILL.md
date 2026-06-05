---
name: simplify
description: "Discovers incidental complexity, duplication, and dead code in a codebase and produces a ranked, behavior-preserving reduction plan — optionally applying safe changes. Dispatches four parallel read-only discovery lenses (clone detection, dead code, complexity hotspots, wrong abstraction), synthesizes into a prioritized reduction plan, and gates apply mode behind /refactor and a hard test check."
argument-hint: "[target] [--apply] [--all]"
---

## Sub-agent contract
/contract

### Overview

`/simplify` is a discovery-and-prioritization skill, not a correctness auditor (that is `/review`'s job) and not a blind executor (that is `/refactor`'s job). It answers: *what incidental complexity, duplication, and dead weight exists in this code, and what is safe to remove?* Default mode is **read-only**: a ranked reduction plan is emitted but nothing is changed. Writes only happen when `--apply` is explicitly passed.

Scope is **diff-bounded by default** (`git diff origin/main`, or working-tree/HEAD if no remote). Pass `--all` for a whole-repo sweep (where duplication and dead-code analysis pay off most). Pass an explicit `[target]` path or PR reference to override both. Code with no test coverage is safe to *analyze* but must never be *auto-applied* — the skill surfaces that gap and recommends `/simplify [target] --all` after adding tests, or produces the plan and stops.

---

## Argument parsing

| Argument | Effect |
|---|---|
| *(none)* | Scope = `git diff origin/main` (working-tree fallback) |
| `[target]` | Explicit path, glob, or PR ref |
| `--all` | Whole-repo sweep; excludes `node_modules/`, `dist/`, generated files |
| `--apply` | Opt-in write mode; default is read-only plan |

Parse arguments before dispatching Wave 1. Resolve scope to a concrete file list or diff stat and attach it to every sub-agent prompt.

---

## Wave 1 — Parallel discovery (read-only)

Dispatch all four lenses simultaneously as `research-agent` sub-agents. All are strictly read-only — no writes, no installs that modify `package.json`. Optional tooling (`jscpd`, `knip`) is an **accelerant only**; degrade to grep/structural reasoning when absent or network-gated.

### (a) Duplication / clone detection
Find exact and near-duplicate logic blocks across modules within scope. Optionally seed with:
```
npx jscpd <scope> --reporters json --silent
```
If `jscpd` is absent, use grep for literal repetition and structural reasoning for semantic clones. Output: **clone clusters** with `file:line` ranges, estimated token overlap, and a suggested extraction site.

### (b) Dead code / unused exports
Find module-graph-dead exports, unreachable branches, and obsolete feature flags — beyond what `tsc --noEmit --noUnusedLocals` already catches. Optionally seed with:
```
npx knip --reporter json
```
**MANDATORY GROUNDING**: every "X is unused/dead" claim MUST carry:
1. A `file:line` citation for the symbol.
2. A structural evidence path — *who would import it, and why nothing does*.

Dynamic imports, reflection, string-keyed access, and barrel re-exports are common false-positive vectors. Never assert dead code without grounding. Flag uncertain cases as **POSSIBLE-DEAD** rather than **DEAD**.

### (c) Complexity hotspots
Identify over-long functions (>40 lines), deep nesting (>3 levels), boolean-flag parameters, primitive obsession, and sprawling switch/if chains. **The target repo has NO ESLint** — this lens is pure agent reasoning over the code, not lint output. Rank by cyclomatic complexity estimate × call-site frequency. Output: hotspot list with `file:line`, smell label, and a plain-language refactor suggestion.

### (d) Reuse / wrong-abstraction-level
Find code that reimplements an existing helper, sits at the wrong layer (leaky abstraction, unnecessary wrapper), or is a thin pass-through with no added value. Cross-reference the project's existing utilities before flagging. Output: reuse candidates with `file:line`, what existing construct could replace them, and estimated call-site count.

---

## Synthesis — inline, after Wave 1

1. **Dedup**: one site often trips multiple lenses. Merge duplicate entries; annotate each with the lens(es) that flagged it.
2. **SANDI-METZ WRONG-ABSTRACTION GUARD**: flag but **do NOT propose collapsing** two code paths if unifying them requires introducing a new boolean/flag parameter. Record these as *"defer — duplication is cheaper than the wrong abstraction"* with an explanation.
3. **Rank by impact × safety**:
   - **HIGH IMPACT**: multi-site duplication, provably dead exports, complexity hotspots at high call frequency.
   - **LOW RISK**: purely local changes, full test coverage, no public API surface.
   - Deprioritize: single-use private helpers, style preferences, anything touching uncovered code.
4. **Emit the reduction plan** — one row per finding:

| # | Location (`file:line`) | Smell | Proposed simplification | Risk note | Behavior-preservation note |
|---|---|---|---|---|---|

5. Append a **Coverage gate summary**: list files in scope with no test coverage where apply was requested — recommend tests first.

**In default (read-only) mode: STOP here.** Print the plan and exit.

---

## Wave 2 — Gated apply (only when `--apply` is passed)

Before any write, verify the test suite is green:
```
pnpm lint && pnpm test
```
If the gate is red before any change, **abort apply and report**. Do not attempt to fix pre-existing failures.

**Delegation decision** (per ranked item, high-to-low):

- **Multi-site mechanical changes** (extract duplicated block into a shared helper used at N≥2 sites): delegate to `/refactor` if available. `/refactor` handles DAG-layered, worktree-isolated parallel application with a hard test gate at each layer boundary and a behavioral diff. Pass the reduction plan item as the refactor spec.
- **`/refactor` NOT available, OR single-site local simplifications**: apply directly inside a git worktree. One change at a time; run `pnpm lint && pnpm test` after each. On regression → route to `/diagnose`; revert the change; continue with remaining items.
- **Items touching uncovered code**: skip apply, preserve in plan output as *"plan-only — no test coverage"*.

On full success, chain to `/ship` for commit + PR.

---

## Guardrails

- **Behavior-preserving only** — never change observable behavior under the guise of cleanup.
- Exclude `node_modules/`, `dist/`, vendored code, and auto-generated files from all analysis.
- Optional tooling (`jscpd`, `knip`) must not modify `package.json` or lock files — use `npx` with no persistent side effects.
- Diff-scoped by default; whole-repo only on `--all` — avoids signal-drowning noise on large codebases.
- Max 3 apply-layer retries per item before skipping and continuing.

---

## Failure modes to surface explicitly

| Failure mode | Mitigation |
|---|---|
| Over-DRYing / wrong abstraction | Sandi-Metz guard (see Synthesis step 2) |
| False dead-code positives | Mandatory grounding rule on lens (b) |
| Behavior change disguised as cleanup | Pre/post test gate; worktree isolation |
| Scope creep on large repos | Diff-scope default; `--all` is explicit opt-in |

---

## Chains to

- `/refactor` — multi-site mechanical apply
- `/ship` — commit + PR after successful apply
- `/diagnose` — when an applied simplification breaks a test