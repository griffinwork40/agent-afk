#!/usr/bin/env node
/**
 * release.mjs — minimal repo-native release script
 *
 * Usage: pnpm release <patch|minor|major|x.y.z> [--dry-run]
 *
 * What it does (in order, each step gated on the previous succeeding):
 *   1. Verify clean working tree on `main` (or override branch via RELEASE_BRANCH).
 *   2. Verify CHANGELOG.md has an "## [Unreleased]" section with non-empty content.
 *   3. Compute the next version (or use the explicit one provided).
 *   4. Bump package.json via `pnpm version --no-git-tag-version` (no auto-tag — we tag ourselves after CHANGELOG rewrite).
 *   5. Rewrite CHANGELOG: rename `[Unreleased]` → `[X.Y.Z] - YYYY-MM-DD`, insert fresh empty `[Unreleased]` block above it.
 *   6. git add + commit `chore(release): vX.Y.Z`.
 *   7. git tag vX.Y.Z.
 *   8. git push origin <branch> --follow-tags.
 *
 * The existing .github/workflows/publish.yml fires on the tag push and handles
 * lint, test, npm publish (with provenance), and GitHub Release creation.
 *
 * --dry-run prints every step without mutating anything.
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const bumpArg = args.find((a) => !a.startsWith('--'));

if (!bumpArg) {
  console.error('Usage: pnpm release <patch|minor|major|x.y.z> [--dry-run]');
  process.exit(1);
}

const releaseBranch = process.env.RELEASE_BRANCH ?? 'main';

function sh(cmd, opts = {}) {
  if (dryRun && opts.mutates) {
    console.log(`[dry-run] $ ${cmd}`);
    return '';
  }
  const result = execSync(cmd, { cwd: repoRoot, encoding: 'utf8', stdio: opts.inherit ? 'inherit' : 'pipe', ...opts });
  // execSync returns null when stdio is 'inherit' — caller doesn't need the output in that case.
  return result == null ? '' : result.toString().trim();
}

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

// 1. Clean tree + correct branch
const status = sh('git status --porcelain');
const dirty = status
  .split('\n')
  .filter(Boolean)
  // Allow untracked files (??), block any tracked changes
  .filter((line) => !line.startsWith('??'));
if (dirty.length > 0) {
  fail(`Working tree has tracked changes:\n${dirty.join('\n')}\nCommit or stash before releasing.`);
}

const branch = sh('git rev-parse --abbrev-ref HEAD');
if (branch !== releaseBranch) {
  fail(`On branch '${branch}', expected '${releaseBranch}'. Override with RELEASE_BRANCH=<name> if intentional.`);
}

// Make sure local is up to date with origin
sh('git fetch origin --tags');
const localSha = sh(`git rev-parse ${branch}`);
const remoteSha = sh(`git rev-parse origin/${branch}`);
if (localSha !== remoteSha) {
  fail(`Local ${branch} (${localSha.slice(0, 7)}) diverges from origin/${branch} (${remoteSha.slice(0, 7)}). Pull/push first.`);
}

// 2. CHANGELOG must have non-empty [Unreleased]
const changelogPath = resolve(repoRoot, 'CHANGELOG.md');
const changelog = readFileSync(changelogPath, 'utf8');
const unreleasedMatch = changelog.match(/## \[Unreleased\][^\n]*\n([\s\S]*?)(?=\n## \[)/);
if (!unreleasedMatch) {
  fail('No "## [Unreleased]" section found in CHANGELOG.md');
}
const unreleasedBody = unreleasedMatch[1].trim();
if (!unreleasedBody) {
  fail('"## [Unreleased]" section is empty — nothing to release.');
}

// 3. Compute next version
const pkgPath = resolve(repoRoot, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const currentVersion = pkg.version;

function bumpSemver(version, kind) {
  const [major, minor, patch] = version.split('.').map(Number);
  if (kind === 'major') return `${major + 1}.0.0`;
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  if (kind === 'patch') return `${major}.${minor}.${patch + 1}`;
  if (/^\d+\.\d+\.\d+$/.test(kind)) return kind;
  fail(`Invalid bump '${kind}'. Use patch|minor|major|x.y.z`);
}

const nextVersion = bumpSemver(currentVersion, bumpArg);
const tag = `v${nextVersion}`;

// Tag must not already exist
const existingTags = sh('git tag --list').split('\n').filter(Boolean);
if (existingTags.includes(tag)) {
  fail(`Tag ${tag} already exists.`);
}

console.log(`Releasing ${currentVersion} → ${nextVersion} (tag ${tag}) on ${branch}${dryRun ? ' [dry-run]' : ''}`);
console.log(`Unreleased section preview:\n---\n${unreleasedBody}\n---\n`);

// 4. Bump package.json (no auto-tag, we tag after CHANGELOG rewrite)
sh(`pnpm version ${nextVersion} --no-git-tag-version`, { mutates: true, inherit: true });

// 5. Rewrite CHANGELOG
const today = new Date().toISOString().slice(0, 10);
const newChangelog = changelog.replace(
  /## \[Unreleased\][^\n]*\n/,
  `## [Unreleased]\n\n## [${nextVersion}] - ${today}\n`
);
if (dryRun) {
  console.log(`[dry-run] would rewrite CHANGELOG.md: [Unreleased] → [${nextVersion}] - ${today}`);
} else {
  writeFileSync(changelogPath, newChangelog);
}

// 6. Commit
sh('git add package.json CHANGELOG.md', { mutates: true, inherit: true });
sh(`git commit -m "chore(release): ${tag}"`, { mutates: true, inherit: true });

// 7. Tag
sh(`git tag -a ${tag} -m "${tag}"`, { mutates: true, inherit: true });

// 8. Push
sh(`git push origin ${branch} --follow-tags`, { mutates: true, inherit: true });

console.log(`\n✓ Released ${tag}`);
console.log(`  → CI: https://github.com/griffinwork40/agent-afk/actions`);
console.log(`  → npm: https://www.npmjs.com/package/agent-afk`);
