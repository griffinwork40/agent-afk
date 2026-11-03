---
name: afk-release
description: "Cut a manual agent-afk release end to end. Auto-release was removed in #4146, so merging to main publishes nothing. This skill runs the read-only preflight (clean main equal to origin/main, CI green on that exact SHA, no publish in flight, npm in sync with the last tag), picks the semver bump from conventional commits plus the engines.node floor check, fills CHANGELOG [Unreleased] when it is empty, dry-runs scripts/release.mjs, stops for one explicit confirmation, then runs `pnpm release`, watches publish.yml, and verifies the version on npm and in GitHub Releases. Emits RELEASED / DRY-RUN / NOTHING-TO-RELEASE / BLOCKED / PUBLISH-FAILED."
when-to-use: "When the operator wants a new agent-afk version on npm: 'cut a release', 'release this', 'ship a patch', 'publish 5.329.0', 'do a release'. Not for opening a PR (/ship) or merging one (/land). Not for retrying a failed publish without a new version (see Recovery; that is a single gh workflow run)."
argument-hint: "[patch|minor|major|x.y.z] [--dry-run] [--yes]"
flags: [--dry-run, --yes]
context: load
---

# afk-release

Releases are manual (`docs/publish-workflow.md`). The only thing that
publishes is a pushed `vX.Y.Z` tag, which fires `.github/workflows/publish.yml`
(tag-vs-package guard, lint, test, `npm publish --provenance`, GitHub Release).
`scripts/release.mjs` (`pnpm release`) does the bump, CHANGELOG stamp, commit,
tag, and atomic push. This skill wraps it with the checks a human used to do
by hand, plus one confirmation gate.

Run from the repo root of the agent-afk checkout. Run this skill in the
top-level session (`context: load`). It needs `ask_question` for the gate,
and forked children auto-decline that tool.

## Hard rules

- Publishing to npm cannot be undone: a version number can never be reused.
  Never run `pnpm release` without the Phase 5 confirmation, unless the
  arguments contain `--yes`.
- Never force-push. Never delete, move, or re-push a tag that already reached
  the remote. Never run `npm publish` locally (provenance needs the CI runner).
- Never stash, reset, or discard the operator's working-tree changes to make
  preflight pass. Report them and stop.
- Commit messages go on stdin through a quoted heredoc (`git commit -F - <<'EOF'`),
  never inside double quotes.
- The operator's `release-boundary` PreToolUse hook blocks shell commands that
  look like a publish. It fires even on a read-only grep whose pattern
  contains the publish command text, so search workflow files with the grep
  tool instead of a shell grep. If it blocks Phase 6, do not route around it.
  End with **Asking** and hand the operator `pnpm release <bump>` to run.
- If `gh` reports "multiple remotes detected", add `-R griffinwork40/agent-afk`.

## Phase 1: Preflight (read-only, run the checks in parallel)

| # | Check | Command | Fail action |
|---|-------|---------|-------------|
| 1 | On `main` | `git rev-parse --abbrev-ref HEAD` | BLOCKED |
| 2 | No tracked changes (untracked `??` files are fine) | `git status --porcelain \| grep -v '^??'` | BLOCKED, list the paths |
| 3 | Up to date | `git fetch origin --tags`, then compare `git rev-parse HEAD` with `git rev-parse origin/main` | Behind and check 2 passed: `git pull --ff-only`. Ahead or diverged: BLOCKED |
| 4 | CI green on that exact SHA | `gh run list --workflow ci.yml --branch main --limit 10 --json headSha,status,conclusion,databaseId,url`, then pick the run whose `headSha` equals origin/main | In progress: `gh run watch <id> --exit-status`. Missing or failed: BLOCKED with the run URL |
| 5 | No publish in flight | `gh run list --workflow publish.yml --limit 1 --json status,headBranch,conclusion` | Running: wait for it or BLOCKED |
| 6 | npm matches the last tag | `git describe --tags --abbrev=0` versus `npm view agent-afk version` | Mismatch means the last publish never landed. Go to Recovery, do not cut a new version on top |
| 7 | Something to release | `git log <last-tag>..HEAD --format='%h %s'`, ignoring `chore(release):` lines | Empty: NOTHING-TO-RELEASE |

## Phase 2: Choose the bump

An explicit `patch|minor|major|x.y.z` argument wins, with one exception:
rule 1 below forces a major and overrides a smaller explicit bump. Warn if
the argument is smaller than what rule 2 or 3 implies.

1. `pnpm exec tsx scripts/check-engines-node-floor.ts`. Exit 1 means the Node
   floor was raised (or changed and could not be parsed). That is breaking, so
   the bump must be **major**.
2. Breaking change: a subject with `!:`, or a `BREAKING CHANGE:` footer
   (`git log <last-tag>..HEAD --format=%B | grep -n '^BREAKING CHANGE'`).
   Bump **major**.
3. Any `feat:` means **minor**. Any `fix:`, `perf:`, or `refactor:` means
   **patch**.
4. Only `docs|chore|test|ci|build|style` commits: there is nothing to release.
   Stop with NOTHING-TO-RELEASE unless the operator passed an explicit bump.

## Phase 3: Fill CHANGELOG [Unreleased]

`release.mjs` refuses an empty `## [Unreleased]`. If the section already has
content, review it against the Phase 1 commit list and skip to Phase 4.

Preview the generated entries (read-only, no build needed):

```bash
pnpm exec tsx --eval "import('./src/changelog.ts').then(m=>{const c=m.parseCommits(process.cwd()).filter(e=>!/^v\d+\.\d+\.\d+$/.test(e.subject));console.log(m.formatEntries(c,{includeHash:true}))})"
```

Write those entries under `## [Unreleased]` with `edit_file`. Keep the
trailing `(hash)` on each bullet, because `/changelog` and
`scripts/generate-changelog.mjs` dedup on it. Light edits for readability are
fine. Do not invent entries that no commit supports. Do **not** run
`scripts/generate-changelog.mjs`: it also stamps the version heading, which
collides with the stamp `release.mjs` writes.

`release.mjs` requires a clean tree and local == origin, so the CHANGELOG edit
must be committed and pushed first:

```bash
git add CHANGELOG.md
git commit -F - <<'EOF'
docs(changelog): prepare vX.Y.Z
EOF
git push origin main
```

This commit is docs-only. `publish.yml` re-runs lint and test on the tag, so
you do not need to wait for CI on it.

## Phase 4: Dry run

```bash
pnpm release:dry <bump>
```

Confirm that the printed `current → next` version, the tag, and the
Unreleased preview match Phases 2 and 3. If `--dry-run` was passed, stop
here with DRY-RUN.

## Phase 5: Confirmation gate (skipped only by `--yes`)

Call `ask_question` with `type: confirm`. Put the version transition, the
commit count, the bump rationale, and the first lines of the changelog in
`context`. Proceed only on `accept` with `value: true`. On `decline`,
`cancel`, or `false`, end with **Asking** and the exact command to run once
approved: `pnpm release <bump>`.

## Phase 6: Release

```bash
pnpm release <bump>
```

This commits `chore(release): vX.Y.Z`, tags it, and runs
`git push --atomic origin main refs/tags/vX.Y.Z`. Because the push is
atomic, a rejection leaves nothing on the remote. The local commit and tag
still exist, so report them and ask before undoing anything.

## Phase 7: Watch and verify

1. Find the run: `gh run list --workflow publish.yml --limit 3 --json databaseId,headBranch,status,url`
   and pick the entry whose `headBranch` is `vX.Y.Z`. It can take a few
   seconds to appear.
2. `gh run watch <id> --exit-status`. The run is long, so use
   `run_in_background: true` or a long `timeout_ms`.
3. Verify both, and claim RELEASED only if both pass:
   - `npm view agent-afk@X.Y.Z version` prints `X.Y.Z`
   - `gh release view vX.Y.Z --json tagName,url`
4. Landing page (agentafk.com, repo `griffinwork40/agentafk-landing`). Its
   footer version pill and `/changelog` page read a vendored copy of this
   repo's `CHANGELOG.md`. That repo's `sync-changelog.yml` cron mirrors the
   file from agent-afk `main` every 6 hours, so the site catches up on its
   own. To update it now, run
   `gh workflow run sync-changelog.yml -R griffinwork40/agentafk-landing`.
   That makes a bot commit to the landing repo's `main`, which Vercel then
   deploys. After the deploy, check
   `curl -sL https://agentafk.com | grep -oE 'version-pill">v[0-9.]+'`
   shows `vX.Y.Z`. A filled `[Unreleased]` pushed in Phase 3 is harmless,
   because the landing parser skips that section. The landing repo's
   vendored config registry (`content/registry/`,
   `node scripts/sync-registry.mjs` in that repo) is a separate manual sync
   and is not part of a release.
5. The docs site needs no release step. Vercel's Git integration deploys
   `website/` to production on every push to main, whether or not a release
   happened. The site does not read the package version or the CHANGELOG.

## Recovery

- **publish.yml failed, tag already on the remote.** Read the failure with
  `gh run view <id> --log-failed | tail -80`.
  - Flake or registry hiccup: `gh workflow run publish.yml --ref vX.Y.Z`, then
    repeat Phase 7.
  - Real defect: the tag stays as it is. Land the fix on main through a PR,
    then cut a **new** patch release. The tag-vs-package guard and npm's
    immutable version numbers make re-tagging pointless and harmful.
- **release.mjs failed before the push.** Check `git log origin/main..HEAD`
  and `git tag -l vX.Y.Z`. Report the local commit and tag, and ask before
  removing them.

## Terminal verdicts

- **RELEASED**: npm and GitHub Release both show `X.Y.Z`. Evidence: tag,
  publish run URL, npm version.
- **DRY-RUN**: stopped after Phase 4, nothing pushed except a possible
  changelog-prep commit (say so if one was pushed).
- **NOTHING-TO-RELEASE**: no releasable commits since the last tag.
- **BLOCKED**: a preflight check failed. Name the check and the unblock
  condition.
- **PUBLISH-FAILED**: the tag is on the remote but npm does not have the
  version. Include the run URL, the failure head, and which Recovery branch
  applies.
