---
name: ground-state
description: "Before starting any non-trivial implementation, dispatch a parallel pre-flight reconnaissance wave to triangulate git state, project infrastructure, and prior-session memory. Wave 4 auto-assembles a verified grounding preamble — a session-scoped artifact the orchestrator pastes verbatim into every subsequent sub-agent brief — eliminating stale-worktree reads and silent wrong-path errors before the first edit."
read-only: true
context: fork
failure_modes:
  - stale_worktree_read
  - wrong_branch_assumption
  - path_drift_across_briefs
---

## Sub-agent contract
/contract

**Constraint: read-only reconnaissance.** Surveyors and the synthesizer MUST NOT call `edit_file`, `write_file`, or any mutating bash command (no `git commit`, `git push`, `git checkout`, `mv`, `rm`, file redirection, package installs, etc.). Read-only tools only: `read_file`, `grep`, `glob`, `list_directory`, and read-only bash (`git status`, `git log`, `git diff`, `cat`, `ls`, `find`, etc.).

If the survey reveals a fix that's tempting to apply, **return it as a recommendation in the snapshot** — the orchestrator decides whether to act. Even if the invoking brief sounds prescriptive ("draft the edit", "apply the change"), this skill stops at the snapshot and the preamble artifact. The orchestrator dispatches a separate implementation step afterward.

Before any multi-step implementation (not single-file fixes, not pure Q&A), dispatch three parallel reconnaissance sub-agents, each with a narrow target. Adapt the first two surveyors to the domain:

**State surveyor** *(domain-aware)*

| Domain | What to survey |
|--------|---------------|
| `software` | Current branch, `git log --oneline -5`, `git status -s`, diff-summary vs `origin/<default-branch>`, stash list. Flag: diverged, uncommitted changes, stale upstream. |
| `research` | Bibliography state (how many papers collected, citation manager in use), data pipeline status (raw data present? processed?), draft status (outline? partial draft? submitted?), publication target and deadline if known. |
| `design` | Design system state (component library version, Figma project structure), brand guidelines version, current design phase (research? wireframes? high-fidelity? handoff?), recent design changes. |
| `business` | Financial data freshness (last updated dates on models/reports), market data recency, stakeholder map (who's involved, who decides), current phase (research? proposal? execution?). |
| *(other)* | Scan for version-controlled artifacts, recent changes, current project phase, and any state that could cause conflicts. |

**Infrastructure surveyor** *(domain-aware)*

| Domain | What to scan |
|--------|-------------|
| `software` | CI configs (`.github/workflows/`, `.gitlab-ci.yml`, `Jenkinsfile`), package scripts (`package.json`, `Makefile`, `pyproject.toml`), existing linters/formatters, authoritative config file locations relevant to the task. Return 5-bullet inventory. |
| `research` | Reference manager (Zotero, Mendeley, .bib files), LaTeX setup (template, build system), data analysis tools (Jupyter, R, Python scripts), collaboration tools (Overleaf, shared drives), submission system requirements. Return 5-bullet inventory. |
| `design` | Design tools (Figma, Sketch, Adobe), prototyping tools (Framer, Principle), handoff tools (Zeplin, Storybook), asset pipeline (export scripts, optimization), accessibility testing tools. Return 5-bullet inventory. |
| `business` | Modeling tools (Excel, Google Sheets, financial software), presentation tools (PowerPoint, Google Slides, Pitch), data sources (CRM, analytics platforms), collaboration tools (Notion, Confluence), approval workflows. Return 5-bullet inventory. |
| *(other)* | Scan for tooling, build/export pipelines, collaboration infrastructure, and config files relevant to the stated domain. Return 5-bullet inventory. |

When domain is unspecified, infer from the working directory contents.

**Memory surveyor**
Grep the user's auto-memory store (`~/.claude/projects/-<cwd-slug>/memory/`) + any project CLAUDE.md for keywords from the user's current request. Return relevant memory file pointers with 1-line summaries, or "no relevant memory found."

**Synthesize** into a 6-line ground-truth snapshot:
- Branch: `<current>`, `<clean|diverged>`, upstream: `<fresh|stale>`
- Recent work: last 3 commits or stash items
- Infrastructure: CI present? package scripts? authoritative configs for this task
- Memory hits: file refs or "none"
- Implementation risks: e.g. "branch is `main`, don't edit directly"; "CI runs on push"; "memory says prior attempt used approach X"
- Epistemic confidence: `<high|medium|low>` — based on how much state could be verified. Flag if working directory is sparse, if domain is unfamiliar, or if key artifacts may be missing.

Surface the snapshot and stop. The orchestrator then uses these verified facts — not assumptions — to decide the next step. This skill never edits files.

## Wave 4 — Brief Anchor (auto-runs after synthesis)

After the 6-line snapshot is assembled, run a fourth step inline (no additional sub-agent dispatch required): construct the **Brief Anchor** — a path-verified grounding preamble the orchestrator pastes verbatim into every subsequent sub-agent brief.

**Construction procedure:**

1. From the state surveyor output, extract the verified `cwd` (absolute path from `pwd`), `branch` (from `git symbolic-ref --short HEAD`), and `HEAD` SHA (from `git rev-parse HEAD`).
2. From the infrastructure surveyor output, extract the 2–4 canonical file paths most relevant to the task (primary config file, main entry point, test root, etc.). For each, run `stat <path>` — include the path only if `stat` exits 0. Paths that fail `stat` are omitted; if zero paths survive, set the list to `(none verified)`.
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

- Prepend the Brief Anchor verbatim to every sub-agent brief that reads files, runs `git`/`gh` commands, or references explicit paths. Skip for pure-reasoning tasks (no filesystem reads, no path references).
- Sub-agents receiving the anchor `stat` each listed path on entry. A missing path returns `GROUNDING_FAILED:<path>` — the orchestrator re-dispatches once with the corrected path. If the retry also returns `GROUNDING_FAILED`, emit `BRIEF_GROUND_ABORT` with both the expected and actual paths **plus the corrective command** the operator should run — `git worktree list` to find the intended checkout, then `cd <correct-worktree>` (or re-invoke the orchestrator from it) — and halt the wave so the operator resolves the worktree mismatch.
- The anchor is session-scoped: one construction pass per `ground-state` invocation. Do not re-invoke `ground-state` mid-session to refresh it; instead pass the existing anchor through.

**Skip when:**
Task is Q&A only; single-line fix on an already-identified file; user says "skip pre-flight".
