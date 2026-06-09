---
name: ship
description: "Release pipeline for already-done local work. Dispatches /ground-state pre-flight, runs the project test suite, drafts a commit message, pushes, and opens a PR with a structured verification summary. Use when local changes are ready to hand off to review — e.g. 'ship this', 'push and open a PR', 'release this work'. Add --verify to trigger an adversarial verifier wave on the diff before a human reads the PR."
context: fork
---

## Sub-agent contract
/contract

Release pipeline for work that is **already done locally**. This skill does NOT build, implement, or fix — if the task needs code, route to `/mint`; if a bug needs diagnosis, route to `/diagnose`. This skill's job is the hand-off from "done locally" to "visible in a PR."

**Skip when:**
- Working tree is clean (nothing to ship — tell the user).
- Current branch is the default branch (`main`/`master`) — ask the user for a feature branch.
- User invokes with `--dry-run` → produce the plan but take no git actions.

**Arguments:**
- `--verify` — force the optional adversarial verifier wave (Phase 6), regardless of diff size.
- `--draft` — open the PR as a draft.
- `--dry-run` — run phases 1–5 but stop before Phase 7 (no push, no PR).

---

**Hard rules (non-negotiable — these override any inferred convention):**

- **Branch lock.** Whatever branch is checked out when `/ship` starts is the only branch you may commit and push from. **NEVER** `git checkout` to a different branch during this skill — not to `main`, not to `master`, not to a sibling feature branch. If pre-flight finds you on the default branch, abort. Do not "recover" by switching branches yourself.
- **Never push to the default branch.** Phase 5 pushes the CURRENT (feature) branch. Phase 8 opens a PR. There is no path through this skill that pushes to `main`/`master` or merges without a PR. If you find yourself about to run `git push origin main` (or equivalent), stop.
- **User intent is absolute.** If the user said "make a PR," "open a PR," "submit for review," or anything synonymous, you MUST complete Phase 8. "Ship" / "release" alone also implies PR — there is no interpretation under which `/ship` means "skip the PR step."
- **Do not invent project convention.** Never assert "this project uses direct-to-main flow," "this repo merges direct," or any equivalent justification for bypassing the PR step. If you genuinely cannot tell whether the project uses PRs, run `gh pr list --state merged --limit 5`; ≥3 merged PRs in the last week ⇒ PR is the convention. If still ambiguous, ask the user. Default to PR — it is the safer choice.
- **Anchor cwd.** When `/ship` is invoked, `pwd` at that moment is the only working directory you operate in. All git commands and file reads must run inside that directory — never `cd` to a sibling worktree, the parent repo, or any other path during this skill. If you find yourself reading state from a path other than the invocation cwd (e.g. `git log` returning unrelated commits, or a file diff that doesn't match what was just edited), stop and re-anchor on the original cwd. Worktrees and sibling repos look almost identical; cwd is the only disambiguator.

---

**Phase 1 — Pre-flight (mandatory, runs BEFORE any git mutation).**
Invoke `ground-state` via the Skill tool. Abort and surface the blocker with remediation steps if ground-state reports any of:
- Uncommitted changes in files unrelated to the declared scope
- Branch behind `origin/<default>` (stale — user needs to rebase/merge first)
- Current branch IS the default branch
- Wrong-repo context (user's cwd doesn't match the branch's purpose)

**Phase 2 — Test gate.**
Detect the project's test harness by scanning, in order:
1. `package.json` → `scripts.test` (run via the project's package manager: `pnpm`/`yarn`/`npm`)
2. `pyproject.toml` → `pytest` if configured, or `scripts.test`
3. `Cargo.toml` → `cargo test`
4. `go.mod` → `go test ./...`
5. `Makefile` → `test` target

If found → run it. Non-zero exit → **abort**; surface the failing output and recommend `/diagnose`. Do not proceed to commit.

If no harness detected → **warn the user:** "No test harness detected. Ship without running tests?" Require explicit yes. Do not silently skip.

**Phase 3 — Draft commit message.**
Read the cumulative diff: `git diff --stat origin/<default>...HEAD` + full `git diff`. Synthesize a commit message:
- **Subject (≤70 chars):** imperative, Conventional Commits format (`feat`, `fix`, `chore`, `refactor`, `docs`, etc.)
- **Body:** 2–5 bullets on WHY — the motivation, constraint, or trade-off. Skip the WHAT — the diff speaks for itself.

Before committing, review the **file list** to stage — don't sweep in untracked config/scratch/secret files. Print the draft message + file list to the user as info-only output, then **immediately** invoke Phase 4. **This is not a gate. Do not ask "does this look good?" Do not wait for approval.** The user surface is one continuous turn: draft → commit → push → PR URL.

**Phase 4 — Commit.**
Stage only the confirmed files, then write the commit message to a temp file with your file-writing tool — **NOT** a shell heredoc — and commit with `-F`:

```
# 1. Write the subject + body to a temp file (e.g. .git/COMMIT_BODY.txt) using
#    your file-writing tool. The content never passes through the shell.
# 2. Commit from that file:
git commit -F .git/COMMIT_BODY.txt
```

Going through a file keeps backticks, `$(...)`, and quotes in the message literal. **Never** assemble the message inline as `git commit -m "$(cat <<'EOF' … EOF)"` — a backtick or `$(` in the body is parsed by the shell *before* `git` runs, so the commit fails or records a mangled message. `.git/` is never staged, so the temp file can't sneak into the commit (in a linked worktree `.git` is a file, not a dir — write to the path printed by `git rev-parse --git-dir` instead).

Never `--amend` (creates a new commit each time). Never bypass hooks (`--no-verify`).

**Phase 5 — Push.**
- **Assertion (before any push):** `git rev-parse --abbrev-ref HEAD` must NOT equal the default branch. If it does, abort with the same error as Phase 1 — Branch lock was violated somewhere upstream.
- Upstream unset → `git push -u origin <branch>`
- Upstream set → `git push`
- Non-fast-forward rejection → **abort**; do not force-push. Surface and let the user decide.
- **Never** `git push origin main` (or `master`). Pushing the feature branch is the only allowed form.

**Phase 6 — Optional adversarial verifier wave.**
Trigger when `$ARGUMENT` contains `--verify`, OR when the cumulative diff exceeds **100 changed lines** (rough proxy for "big enough that a human reviewer will miss something"). Skip for diffs under 100 lines unless `--verify` is explicit.

Dispatch an adversarial verifier sub-agent via the Agent tool. Use `subagent_type: "research-agent"` (read-only, no Edit/Bash-that-mutates). Brief it with:
- The cumulative branch diff
- The draft PR body (Phase 7)
- Instruction: from the diff alone — **without consulting the draft's reasoning** — independently re-derive the 2–3 load-bearing claims the PR body makes. Return per claim: `CONFIRM` / `REFINE` / `CONTRADICT` with file:line evidence.

If any verifier returns `CONTRADICT` → **surface to the user** before opening the PR. Append the counter-claim to the PR body's Verification section. User decides whether to proceed, revise, or abort.

**Phase 7 — Synthesize PR body.**
Structure:

```
## Summary
<2–4 bullets: what changed, why>

## Test results
- <command>: <passed/failed + counts>
<repeat per test invocation>

## Verification
<if --verify ran: per-claim verdict + evidence>
<if skipped: "No adversarial verify requested (diff under threshold).">

## Out of scope
<anything touched but not central to this PR, if any; omit section otherwise>
```

**Phase 8 — Open PR.**
Write the PR body (from Phase 7) to a temp file with your file-writing tool — **NOT** a shell heredoc — then pass it with `--body-file`:

```
# 1. Write the Phase 7 PR body to a temp file (e.g. .git/PR_BODY.md) using your
#    file-writing tool. The body never passes through the shell.
# 2. Open the PR from that file:
gh pr create \
  --title "<subject line of the commit>" \
  --body-file .git/PR_BODY.md \
  --base <default-branch> \
  [--draft]
```

PR bodies are markdown: they routinely carry backticks (inline code), `$(...)`, and quotes. **Never** inline the body as `--body "$(cat <<'EOF' … EOF)"` — the shell parses backticks/`$(` inside the command substitution before `gh` ever runs, so the call fails (or worse, opens the PR with a truncated/garbled body and you don't notice). `--body-file` reads the file verbatim: no shell quoting, no escaping. Only `--title` stays inline — keep it a single plain line with no backticks.

Return the PR URL to the user. Done.

---

**Failure modes to watch:**
- `/ground-state` unavailable → skip Phase 1 with a loud warning; do not proceed silently.
- `gh` CLI not authenticated → abort Phase 8 with the exact `gh auth login` command.
- Detached HEAD or shallow clone → abort at Phase 1; these are edge cases `/ship` should not try to auto-recover.
