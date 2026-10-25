# Publish workflow

> Companion doc for `.github/workflows/publish.yml`.

## TL;DR

Releases are **manual**. Merging to `main` publishes nothing. A release
happens only when a maintainer pushes a `vX.Y.Z` tag, which fires
`publish.yml` (lint + test + tag-vs-package guardrail + `npm publish
--provenance` + GitHub Release).

The `auto-release.yml` workflow, which bumped, tagged, and published on
every releasable merge to `main`, has been removed.

## Cutting a release

1. Make sure `main` is green in CI and your local `main` matches
   `origin/main`.
2. Fill the `## [Unreleased]` section of `CHANGELOG.md`. In the REPL,
   `/changelog` writes entries from conventional commits since the last
   tag; review and edit them. `scripts/release.mjs` refuses to run on an
   empty `[Unreleased]`.
3. If `engines.node` changed since the last tag, check whether the floor
   was raised (a raised floor is a breaking change, so the release must be
   a major):

   ```bash
   pnpm exec tsx scripts/check-engines-node-floor.ts
   ```

4. Dry-run, then release:

   ```bash
   pnpm release:dry patch   # or minor | major | x.y.z
   pnpm release patch
   ```

   `release.mjs` bumps `package.json`, stamps `[Unreleased]` into a dated
   version heading, commits `chore(release): vX.Y.Z`, tags, and pushes the
   branch and tag with your own credentials.

5. The tag push fires `publish.yml`. Watch it with
   `gh run watch` or in the Actions tab.

Choosing the bump is a human decision now. The Conventional Commits
mapping the old workflow used is still a good default: `!:` or a
`BREAKING CHANGE:` footer means major, `feat:` means minor,
`fix|perf|refactor:` means patch, and docs/chore/test/ci-only means no
release.

## Retrying a failed publish

If `publish.yml` fails after the tag is already on the remote (flaky test,
registry hiccup), re-run it against the existing tag:

```bash
gh workflow run publish.yml --ref vX.Y.Z
```

The "Verify tag matches package.json version" step refuses to publish a
ref whose `package.json` version differs from the tag.

## What `publish.yml` checks

- **Tag vs `package.json` version.** Prevents publishing anything other
  than what the tag points at.
- **Lint** (`pnpm lint`) and **Test** (`pnpm test`). Runs on
  GitHub-hosted `ubuntu-latest`; npm provenance attestation requires a
  public GitHub-hosted runner.
- **Publish** with the npm CLI, not `pnpm publish` (see the Invariant on
  that step in `publish.yml`).

## Incident history (from the auto-release era)

These incidents happened while `auto-release.yml` existed and the release
jobs ran on self-hosted runners. They are kept for context only; neither
condition holds today.

### v3.46.0: orphan tag race

Auto-release's non-atomic `git push` left `v3.46.0` as an orphan tag off
the main lineage, so every later run recomputed `NEXT=3.46.0` and failed
with "tag already exists". Fixed then with `git push --atomic`.
`v3.46.0` was deprecated on npm.

### v3.47.1: import-shape timeouts

Publish's Test step hit the vitest 5s default under self-hosted runner
load. Fixed by PR #579 (`testTimeout: 15_000`). The tag exists but npm
never received it; the change shipped in v3.48.0.

### v3.50.0: assertion-race flake

FS-write-visibility races in `src/agent/worktree-sweep.test.ts` under
double load (CI and publish on the same laptop). Recovered with
`gh workflow run publish.yml --ref v3.50.0` once the runners were idle.

## Cross-references

- `.github/workflows/publish.yml`: the publish workflow
- `.github/workflows/ci.yml`: the PR and `main` test gate
- `scripts/release.mjs`: the release script behind `pnpm release`
- `scripts/check-engines-node-floor.ts`: manual major-bump check for a
  raised Node floor
- `scripts/generate-changelog.mjs`: stamps conventional-commit entries and
  a version heading in one step (formerly called by auto-release)
