# Publish workflow — history & trust model

> Companion doc for `.github/workflows/publish.yml`. Source of truth for
> the design decision to NOT re-run the test suite at publish time.

## TL;DR

`publish.yml` runs Lint + tag-vs-package guardrail + `pnpm publish` — it
**does not** re-run the test suite. CI on the release commit (via
`ci.yml`) is the test gate. Re-adding a test step here would re-create
the double-load problem documented below.

## The double-load problem

Both `ci.yml` and `publish.yml` are pinned to `runs-on: [self-hosted, afk]`,
which resolves to two macOS arm64 runners (`runner-afk-1`, `runner-afk-2`)
registered on the same physical laptop.

When a PR is merged to `main`, the auto-release dance fires:

1. The merge commit hits `main` → `ci.yml` runs lint+build+test → all green
   (this is the gate the PR was reviewed against).
2. `auto-release.yml` fires on the same merge commit, computes the next
   version, writes a `chore(release): vX.Y.Z` commit + annotated tag, and
   pushes both with `--follow-tags --atomic`.
3. The release commit hits `main` → `ci.yml` fires again on the release
   commit.
4. The tag push → `publish.yml` fires.

Steps 3 and 4 happen within seconds of each other, both targeting
`[self-hosted, afk]`. With only two runners, one ends up running the
full vitest suite for `ci.yml` while the other runs the full vitest
suite for `publish.yml` — both on the same laptop, both doing real I/O
(git worktree ops, FS writes, big imports). The contention exposes
timing-sensitive tests that pass cleanly on an idle runner.

## Incident history

Three releases were blocked by this pattern:

### v3.46.0 (5/29 morning) — orphan tag race

Auto-release's non-atomic `git push` left `v3.46.0` as an orphan tag
pointing off the main lineage. `git describe --tags` then returned
`v3.45.3` instead of `v3.46.0`, so the next run kept recomputing
`NEXT=3.46.0` → "tag already exists" → permanent lock.

Fixed by switching to `git tag --list 'v*' --sort=-v:refname | head -1`
and `git push --atomic`. See `.github/workflows/auto-release.yml`
"Determine bump level from commits" step.

`v3.46.0` was deprecated on npm.

### v3.47.1 (5/29 09:00Z) — import-shape timeouts

Publish's Test step failed at the vitest 5s default on:

- `src/cli/interactive-lifecycle.test.ts > ... > repaints current stats on demand and after clearScreen restart` (5033ms)
- `src/cli/commands/interactive/resume-swap.test.ts > ... > bootstrap exports buildAgentSession (the function used in requestResume closure)` (5019ms)

The second is literally `await import('./bootstrap.js')` + `expect(typeof
mod.buildAgentSession).toBe('function')`. The 5s ceiling caught the
transitive import-graph cost under self-hosted-runner load — not a
real hang.

Tag `v3.47.1` exists; npm never received it. v3.48.0 shipped from a
different commit ~10h later when load was lower; the v3.47.1 change
(#564 between-turn slash output routing) shipped as part of v3.48.0
anyway, so users didn't see the gap.

Fixed by PR #579 (`vitest.config.ts: testTimeout: 15_000`). Merged
post-incident.

### v3.50.0 (5/29 19:30Z) — assertion-race flake

Publish's Test step failed with **assertion errors** (not timeouts) in
10 tests across `src/agent/worktree-sweep.test.ts`:

```
× empty-detection > classifies a worktree with no commits and no dirty files as empty 58ms
  → expected +0 to be 1
× stale-clean-preserves-branch > removes stale clean worktree via worktree remove but does NOT delete branch 28ms
  → expected false to be true
× base-sha-fallback > classifies correctly without .afk-worktree-meta.json present 7ms
  → expected 0 to be greater than 0
```

Each test completed in 6–75 ms — well under any timeout. The
failures are FS-write-visibility races: the test's `beforeEach`
creates a tmpdir + writes files, then the implementation under test
reads the directory; under load the directory listing returns
empty before the writes are visible.

PR #579's `testTimeout` bump does NOT fix this flavor (it's not a
timeout).

Concurrent `ci.yml` run on the same release commit also failed,
with a different test file: 7 tests in `src/agent/worktree.test.ts`
(real `git worktree` ops) hit ~10s timeouts.

Recovery: `gh workflow run publish.yml --ref v3.50.0`. The re-fire
completed in 2m1s with all steps green — runners were idle by then.

## Why dropping the Test step is safe

1. **`ci.yml` already gates the release commit.** It runs on every
   push to `main`, including release commits. The `if:` guard in
   `auto-release.yml` only suppresses auto-release recursion — it
   does not suppress CI.

2. **Release commits cannot regress tests.** They are auto-generated
   and only modify two files:
   - `package.json` — version field bumped from `X.Y.Z` → `X.Y.Z+1`.
   - `CHANGELOG.md` — release notes prepended.

   No test in this repo exercises either file's content. The release
   commit's parent (the merged PR commit) already passed the full
   test suite under CI.

3. **The tag-vs-package-version guardrail stays.** publish.yml's
   "Verify tag matches package.json version" step prevents publishing
   anything other than what the tag points at — protects against
   `workflow_dispatch` against a stale branch.

4. **Lint stays.** `tsc --noEmit` runs in ~30s with no I/O races,
   catches type-safety regressions in the release commit (e.g. if
   the changelog generator somehow injected invalid syntax — has
   never happened, but cheap to verify).

## What to do if you want a test gate back

Don't re-add `pnpm exec vitest run` here — that re-introduces the
double-load. Instead, gate Publish on CI's conclusion for the same
commit:

```yaml
- name: Wait for CI on this commit
  run: |
    SHA="${GITHUB_SHA}"
    for i in $(seq 1 30); do
      CI_STATUS=$(gh api "repos/${GITHUB_REPOSITORY}/commits/${SHA}/check-runs" \
        --jq '.check_runs[] | select(.name == "Test") | .conclusion')
      if [ "$CI_STATUS" = "success" ]; then exit 0; fi
      if [ "$CI_STATUS" = "failure" ]; then exit 1; fi
      sleep 10
    done
    exit 1
  env:
    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

This waits for CI's `Test` job to finish (up to 5 minutes), fails fast
on CI failure, and consumes ~0 runner cycles compared to a full vitest
re-run. Not added in this PR because the trust model above makes it
unnecessary — but documented here for the future contributor who
might want belt-and-suspenders.

## Cross-references

- `.github/workflows/publish.yml` — the workflow
- `.github/workflows/ci.yml` — the actual test gate
- `.github/workflows/auto-release.yml` — what creates the release
  commits and tags
- `vitest.config.ts` — `testTimeout: 15_000` (PR #579)
- Hot-memory fact "Publish-gate flake (5/29)" — quick-reference for
  recovery procedure
