---
name: ground-state
description: "Before starting any non-trivial implementation, run a pre-flight reconnaissance pass to triangulate git state, project infrastructure, and prior-session memory. Auto-assembles a verified grounding preamble — a session-scoped artifact the orchestrator pastes verbatim into every subsequent sub-agent brief — eliminating stale-worktree reads and silent wrong-path errors before the first edit."
read-only: true
context: fork
failure_modes:
  - stale_worktree_read
  - wrong_branch_assumption
  - path_drift_across_briefs
---

## Sub-agent contract
/contract

**Constraint: read-only reconnaissance.** You MUST NOT call `edit_file`, `write_file`, or any mutating bash command (no `git commit`, `git push`, `git checkout`, `mv`, `rm`, file redirection, package installs, etc.). Read-only tools only: `read_file`, `grep`, `glob`, `list_directory`, `memory_search`, and read-only bash (`git status`, `git log`, `git diff`, `cat`, `ls`, `find`, etc.). `memory_search` is non-mutating and is the **only** way to reach the cross-session fact archive — it is in scope for this skill, do not strip it from this list.

If the survey reveals a fix that's tempting to apply, **return it as a recommendation in the snapshot** — the orchestrator decides whether to act. Even if the invoking brief sounds prescriptive ("draft the edit", "apply the change"), this skill stops at the snapshot and the preamble artifact. The orchestrator dispatches a separate implementation step afterward.

## Inline reconnaissance

Run the three surveys below **directly using your own tools**. Do NOT dispatch any sub-agents via the `agent` or `skill` tools — every lookup in this phase is a deterministic read that you execute yourself using `bash`, `glob`, `read_file`, `grep`, `list_directory`, and `memory_search`. Issue all three surveys in a single batched tool-use round where possible.

### State survey *(bash)*

Issue these commands (combine into one or two bash calls):
- `git symbolic-ref --short HEAD` — current branch
- `git rev-parse HEAD` — HEAD SHA
- `git status -s` — uncommitted changes
- `git log --oneline -5` — recent commit history
- `git stash list` — stash state
- `git rev-list --left-right --count HEAD...@{upstream} 2>/dev/null` — upstream divergence

Adapt what you surface to the domain:

| Domain | What to flag |
|--------|-------------|
| `software` | Branch, recent commits, uncommitted changes, stash, upstream divergence. Flag: diverged, uncommitted, stale. |
| `research` | Version-controlled artifact state, current phase, publication target/deadline if discoverable. |
| `design` | Design system version, component library state, current phase, recent file changes. |
| `business` | Financial model freshness, market data recency, current project phase. |
| *(other)* | Recent changes, current project phase, any state that could cause conflicts. |

When domain is unspecified, infer from working directory contents.

### Infrastructure survey *(bash/glob/read_file)*

Check for relevant tooling and configs. Use the domain table below to decide which paths to probe, then probe them yourself. Return a **5-bullet inventory**.

| Domain | What to scan |
|--------|-------------|
| `software` | CI configs (`ls .github/workflows/ 2>/dev/null`), package scripts (`package.json`, `Makefile`, `pyproject.toml`), linters/formatters, authoritative config files for the task. |
| `research` | Reference manager (.bib files), LaTeX setup, data analysis tools (Jupyter, R scripts), collaboration setup. |
| `design` | Design tool configs, prototyping tools, handoff configs (Storybook), asset pipeline scripts. |
| `business` | Modeling tool configs, presentation formats, data source configs, collaboration tool structure. |
| *(other)* | Tooling, build/export pipelines, collaboration infrastructure, config files relevant to the stated domain. |

### Memory survey *(memory_search + read_file)*

Call the **`memory_search` tool** with keywords from the user's current request — FTS5 syntax, so `term1 AND term2`, `"exact phrase"`, and `prefix*` all work. Run 2–3 query variants (different keyword angles) before concluding nothing is there; a single miss is not evidence of absence. Then read hot memory at `~/.afk/state/memory/HOT.md` and the project overlay — `AFK.md`, or `CLAUDE.md` on a Claude Code surface — for conventions bearing on this task.

**Invariant: the cross-session memory archive is only reachable via the `memory_search` tool.** The backing store is SQLite (`~/.afk/state/memory/memory.db`) and is not greppable. Do not glob or grep any filesystem path looking for memory — `memory_search` is the only route in.

Return: relevant facts with 1-line summaries, **plus the stores actually consulted** — e.g. `memory_search: 3 queries, 0 hits; HOT.md: read; AFK.md: read` — so the orchestrator can tell "no relevant memory exists" from "the fork never looked." If `memory_search` is unavailable on this surface, say so explicitly.

## Synthesis

Assemble the survey results into a **6-line ground-truth snapshot**:
- Branch: `<current>`, `<clean|diverged>`, upstream: `<fresh|stale>`
- Recent work: last 3 commits or stash items
- Infrastructure: CI present? package scripts? authoritative configs for this task
- Memory hits: facts (1-line each) + which stores were consulted, or `none (consulted: …)`
- Implementation risks: e.g. "branch is `main`, don't edit directly"; "CI runs on push"; "memory says prior attempt used approach X"
- Epistemic confidence: `<high|medium|low>` — based on how much state could be verified. Flag if working directory is sparse, if domain is unfamiliar, or if key artifacts may be missing.

Surface the snapshot and stop. The orchestrator then uses these verified facts — not assumptions — to decide the next step. This skill never edits files.

## Brief Anchor (auto-runs after synthesis)

After the 6-line snapshot is assembled, construct the **Brief Anchor** — a path-verified grounding preamble the orchestrator pastes verbatim into every subsequent sub-agent brief.

**Construction procedure:**

1. From your state survey output, extract the verified `cwd` (absolute path from `pwd`), `branch` (from `git symbolic-ref --short HEAD`), and `HEAD` SHA (from `git rev-parse HEAD`).
2. From your infrastructure survey output, extract the 2–4 canonical file paths most relevant to the task. For each, run `stat <path>` — include the path only if `stat` exits 0. Paths that fail `stat` are omitted; if zero paths survive, set the list to `(none verified)`.
3. Assemble the preamble block:

```
## Orchestrator grounding — read this first
- **cwd**: <absolute path>
- **branch**: <branch name>
- **HEAD**: <full SHA>
- **canonical paths** (stat each on entry; emit GROUNDING_FAILED:<path> and abort if missing):
  - <verified_path_1>
  - <verified_path_2>  ← omit line if not applicable
```

4. Append to the snapshot output under the heading **`## Brief Anchor`** so the orchestrator can copy it directly.

**Orchestrator usage contract:**

- Prepend the Brief Anchor verbatim to every sub-agent brief that reads files, runs `git`/`gh` commands, or references explicit paths. Skip for pure-reasoning tasks.
- Sub-agents receiving the anchor `stat` each listed path on entry. A missing path returns `GROUNDING_FAILED:<path>` — the orchestrator re-dispatches once with the corrected path. If the retry also returns `GROUNDING_FAILED`, emit `BRIEF_GROUND_ABORT` with both the expected and actual paths **plus the corrective command** the operator should run — `git worktree list` to find the intended checkout, then `cd <correct-worktree>` — and halt the wave.
- The anchor is session-scoped: one construction pass per `ground-state` invocation. Do not re-invoke `ground-state` mid-session to refresh it; instead pass the existing anchor through.

**Skip when:**
Task is Q&A only; single-line fix on an already-identified file; user says "skip pre-flight".
