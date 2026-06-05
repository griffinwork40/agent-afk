---
name: ground-state
description: "Before starting any non-trivial implementation (multi-file edits, new features, config changes, anything that writes), dispatch a parallel pre-flight reconnaissance wave to triangulate git state, project infrastructure, and prior-session memory. Produces a 5-line ground-truth snapshot that grounds the implementation and catches wrong-branch edits, assumed-no-CI, stale origin, and missed memory context before the first edit."
read-only: true
---

## Sub-agent contract
/contract

**Constraint: read-only reconnaissance.** Surveyors and the synthesizer MUST NOT call `edit_file`, `write_file`, or any mutating bash command (no `git commit`, `git push`, `git checkout`, `mv`, `rm`, file redirection, package installs, etc.). Read-only tools only: `read_file`, `grep`, `glob`, `list_directory`, and read-only bash (`git status`, `git log`, `git diff`, `cat`, `ls`, `find`, etc.).

If the survey reveals a fix that's tempting to apply, **return it as a recommendation in the snapshot** — the orchestrator decides whether to act. Even if the invoking brief sounds prescriptive ("draft the edit", "apply the change"), this skill stops at the snapshot. The orchestrator dispatches a separate implementation step afterward.

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

**Skip when:**
Task is Q&A only; single-line fix on an already-identified file; user says "skip pre-flight".
