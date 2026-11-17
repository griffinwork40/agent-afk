---
name: ground-state
description: "Before starting any non-trivial implementation, run a pre-flight reconnaissance pass over one checkout: git state, project infrastructure, and prior-session memory. Returns a Brief Anchor (cwd, branch, HEAD and existence-checked paths, copied from command output) that the orchestrator pastes into the briefs of sub-agents working in that checkout, plus labelled unverified notes on infrastructure, memory and risks. Prevents stale-worktree reads and silent wrong-path errors before the first edit."
read-only: true
context: fork
failure_modes:
  - stale_worktree_read
  - wrong_branch_assumption
  - path_drift_across_briefs
---

## Sub-agent contract
/contract

**Constraint: read-only reconnaissance.** You MUST NOT call `edit_file`, `write_file`, or any mutating bash command (no `git commit`, `git push`, `git checkout`, `mv`, `rm`, file redirection, package installs, etc.). Read-only tools only: `read_file`, `grep`, `glob`, `list_directory`, `memory_search`, and git queries (via `bash` or `git_read` when bash is unavailable). Under `git_read`, non-git shell commands (`cat`, `ls`, `stat`, `tail`) are not available; use `read_file`, `glob`, and `list_directory` instead. `memory_search` is non-mutating and is the **only** way to reach the cross-session fact archive — it is in scope for this skill, do not strip it from this list.

If the survey reveals a fix that's tempting to apply, **return it as a recommendation in the snapshot** — the orchestrator decides whether to act. Even if the invoking brief sounds prescriptive ("draft the edit", "apply the change"), this skill stops at the snapshot and the preamble artifact. The orchestrator dispatches a separate implementation step afterward.

## Scope

This skill surveys **one checkout on this machine**: the session working directory, or the single repository path named in the arguments. It is a short, fixed survey, not a general audit. If the arguments name several repositories, survey the first one named. To cover two repositories, the orchestrator invokes the skill once for each.

If the arguments ask for more than that (several repositories, another machine, a list of claims to verify, or pull-request, issue or deploy state), run the fixed survey for the one checkout and list the rest under **Out of scope** in your output, with one line telling the orchestrator to send it to a research agent. Do not attempt the wider audit here. Long runs of this skill are where false statements have crept in, and its output is pasted into other agents' briefs.

## Inline reconnaissance

Run the four surveys below **directly using your own tools**. Do NOT dispatch any sub-agents via the `agent` or `skill` tools — every lookup in this phase is a deterministic read that you execute yourself using `bash`, `glob`, `read_file`, `grep`, `list_directory`, and `memory_search`. Issue all four surveys in a single batched tool-use round where possible.

### State survey *(bash)*

Issue these commands (combine into one or two bash calls; when running under `git_read` instead of `bash`, adapt accordingly — `git_read` uses an argv allowlist, so use only the long-form flags shown here):
- `git rev-parse --abbrev-ref HEAD` — current branch
- `git rev-parse HEAD` — HEAD SHA
- `git status -s` — uncommitted changes
- `git log --oneline --max-count=5` — recent commit history
- `git stash list` — stash state (via `git_read`: subcommand `stash` with no arguments; the tool forces `list`)
- `git rev-list --count HEAD..@{upstream}` + `git rev-list --count @{upstream}..HEAD` — upstream divergence (ahead / behind)

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
| `software` | CI configs (`list_directory` or `glob` on `.github/workflows/`), package scripts (`package.json`, `Makefile`, `pyproject.toml`), linters/formatters, authoritative config files for the task. |
| `research` | Reference manager (.bib files), LaTeX setup, data analysis tools (Jupyter, R scripts), collaboration setup. |
| `design` | Design tool configs, prototyping tools, handoff configs (Storybook), asset pipeline scripts. |
| `business` | Modeling tool configs, presentation formats, data source configs, collaboration tool structure. |
| *(other)* | Tooling, build/export pipelines, collaboration infrastructure, config files relevant to the stated domain. |

### Memory survey *(memory_search + read_file)*

Call the **`memory_search` tool** with keywords from the user's current request — FTS5 syntax, so `term1 AND term2`, `"exact phrase"`, and `prefix*` all work. Run 2–3 query variants (different keyword angles) before concluding nothing is there; a single miss is not evidence of absence. Then read hot memory at `~/.afk/state/memory/HOT.md` and the project overlay — `AFK.md`, or `CLAUDE.md` on a Claude Code surface — for conventions bearing on this task.

**Invariant: the cross-session memory archive is only reachable via the `memory_search` tool.** The backing store is SQLite (`~/.afk/state/memory/memory.db`) and is not greppable. Do not glob or grep any filesystem path looking for memory — `memory_search` is the only route in.

Return: relevant facts with 1-line summaries, **plus the stores actually consulted** — e.g. `memory_search: 3 queries, 0 hits; HOT.md: read; AFK.md: read` — so the orchestrator can tell "no relevant memory exists" from "the fork never looked." If `memory_search` is unavailable on this surface, say so explicitly.

### Spine survey *(read_file)*

Read `SPINE.md` from the repo root (same directory as `AFK.md`). If the file does not exist or is empty, skip silently -- do not mention it in the snapshot. If it exists and has entries, extract its invariant (INV-*), rejected-pattern (REJ-*), and taste entries (TST-*) and include them in the snapshot so architectural constraints are visible before proposing changes.

### Eval-pipeline recency survey *(software domain only)*

For software-domain sessions, check whether the eval-run pipeline is current. This guard catches silent regressions that accumulate when the pipeline goes unrun during high-velocity sprints.

Read `~/.afk/agent-framework/improve/eval-runs/.index.jsonl` in full (use `read_file` with no `offset` or `limit`; the file is operationally small — typically a few dozen lines — so a full read is safe). If the file does not exist, treat as "never run". Take the last non-empty line as the most recent entry.

Parse the `timestamp` field from the output. Then compute the age in days relative to today's date.

**Threshold**: Read `AFK_EVAL_STALENESS_DAYS` from the environment (default: 7). If the env var is `0`, skip this check silently.

**Surface as a warning finding when any of these are true:**
- The index file does not exist → `⚠ Eval-pipeline has NEVER run. Run \`afk improve eval-run\` to establish a baseline.`
- The file exists but the timestamp is absent or unparseable → `⚠ Eval-pipeline recency guard: index unreadable.`
- Age in days ≥ threshold → `⚠ Eval-pipeline is STALE: last eval-run was N days ago (exceeds AFK_EVAL_STALENESS_DAYS=N threshold). Run \`afk improve eval-run\`.`

Skip this check silently when:
- Domain is not `software`, OR
- Working directory has no `package.json` / `pyproject.toml` / `Cargo.toml` / `go.mod` at root level (heuristic that this is not a software project), OR
- `AFK_EVAL_STALENESS_DAYS=0`.

Include the result (fresh or warning) in the Implementation risks line of the snapshot.

## Synthesis

Assemble the survey results into a snapshot with two parts, followed by the Brief Anchor. Your output has exactly these three parts and no other sections: anything else you found, including answers to questions the arguments asked, goes inside Unverified notes. Keep the two parts separate: the orchestrator relies on the first and treats the second as leads.

### Observed state

This part contains only the lines listed below, plus a stash line when stashes exist. Nothing else belongs here, however carefully you checked it: answers to questions from the arguments, pull-request or CI state, and anything about another repository go in Unverified notes.

Copy each value from the output of a command you ran in this pass. Do not retype it from memory, round it, or infer it, and do not add a count or total unless a command printed that number. If a command failed, was blocked, or returned nothing, write `unknown (<reason>)` for that value.

- Branch: `<current>`. Working tree: `clean` when `git status -s` printed nothing, otherwise `changes present` followed by up to its first 10 lines as printed.
- Upstream: `<N ahead / M behind>` relative to the locally stored upstream ref. This skill cannot fetch, so do not describe the remote as fresh or current.
- Recent work: last 3 commits (short SHA and subject as printed by `git log`) or stash items

### Unverified notes

Head this part with the line `Unverified notes (model-written; check before relying on them)`. Everything in it is your reading of what you saw, so it can be wrong.

- Infrastructure: CI present? package scripts? authoritative configs for this task. Name the file each item came from.
- Memory hits: facts (1-line each) + which stores were consulted, or `none (consulted: …)`
- Spine constraints *(only when SPINE.md exists with entries)*: INV-*, REJ-*, TST-* entries, quoted rather than paraphrased. Omit this line entirely when SPINE.md is absent or empty.
- Implementation risks: e.g. "branch is `main`, don't edit directly"; "CI runs on push"; "memory says prior attempt used approach X"; include any eval-pipeline staleness warning here.
- Epistemic confidence: `<high|medium|low>` — based on how much state could be verified. Flag if working directory is sparse, if domain is unfamiliar, or if key artifacts may be missing.
- Out of scope *(only when the arguments asked for more than the fixed survey)*: what was not covered, and that it should go to a research agent.

Before returning, check each number, name and state in your output against the tool result it came from. A value you cannot find in a tool result from this pass is removed, or moved to Unverified notes and marked as unchecked.

Surface the snapshot and stop. The orchestrator may rely on the Observed state and the Brief Anchor as observations made at the time of this pass. The Unverified notes are leads to check, not facts to pass on. Do not call `workspace_publish` from this skill: workspace entries reach other agents without the Unverified label. This skill never edits files.

## Brief Anchor (auto-runs after synthesis)

After the snapshot is assembled, construct the **Brief Anchor**: a short preamble the orchestrator pastes verbatim into the briefs of sub-agents that work in this checkout. It records what was observed in one checkout at one time.

**Construction procedure:**

1. From your state survey output, extract the verified `cwd` (from `git rev-parse --show-toplevel` combined with `git rev-parse --show-prefix` to reconstruct the full session path: `<toplevel>/<prefix>`), `branch` (from `git rev-parse --abbrev-ref HEAD`), and `HEAD` SHA (from `git rev-parse HEAD`).
2. From your infrastructure survey output, extract the 2–4 canonical file paths most relevant to the task. For each, verify existence with `glob` or `read_file`; include the path only if it exists. Paths that don't exist are omitted; if zero paths survive, set the list to `(none verified)`.
3. Record the observation time in UTC, from `get_runtime_state` or `date -u`. Write `unknown` if neither is available.
4. Assemble the preamble block:

```
## Orchestrator grounding — read this first
- **cwd**: <absolute path>
- **branch**: <branch name>
- **HEAD**: <full SHA>
- **observed**: <UTC time of this survey, or unknown>
- **scope**: this checkout only, as it was at the observed time
- **canonical paths** (verify each on entry; emit GROUNDING_FAILED:<path> and abort if missing):
  - <verified_path_1>
  - <verified_path_2>  ← omit line if not applicable
```

5. Append to the snapshot output under the heading **`## Brief Anchor`** so the orchestrator can copy it directly. The block contains only the lines shown above. Notes and cautions belong in Unverified notes, not in the anchor.

**Orchestrator usage contract:**

- Prepend the Brief Anchor verbatim to every sub-agent brief that reads files, runs `git`/`gh` commands, or references explicit paths in this checkout. Skip for pure-reasoning tasks.
- The anchor describes one checkout. A sub-agent that works somewhere else (another repository, another machine, or its own worktree, including `isolation: "worktree"`) has a different cwd, branch and HEAD. Pass the anchor to such a sub-agent only as background labelled as the parent checkout, never as its own cwd, branch or HEAD. Run `ground-state` for the other checkout when it needs an anchor of its own.
- Do not copy or paraphrase lines from the Unverified notes into sub-agent briefs as facts. If a brief needs one of them, tell the sub-agent to check it, or mark it as unverified in the brief.
- Sub-agents receiving the anchor verify each listed path on entry (via `glob` or `read_file`). A missing path returns `GROUNDING_FAILED:<path>` — the orchestrator re-dispatches once with the corrected path. If the retry also returns `GROUNDING_FAILED`, emit `BRIEF_GROUND_ABORT` with both the expected and actual paths **plus the corrective command** the operator should run — `git worktree list` to find the intended checkout, then `cd <correct-worktree>` — and halt the wave.
- The anchor is an observation, not a lock. Reuse it while the checkout has not changed. After anything that moves the checkout (a commit, checkout, pull, merge, rebase, or a sub-agent that wrote to it), its HEAD is stale. Before pasting it into another brief, refresh the `HEAD` line from `git rev-parse HEAD` and re-check `git status -s`, or re-run `ground-state`.

**Skip when:**
Task is Q&A only; single-line fix on an already-identified file; user says "skip pre-flight".
