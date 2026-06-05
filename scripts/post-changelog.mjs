#!/usr/bin/env node
/**
 * post-changelog.mjs — Post a Threads update for a given agent-afk release.
 *
 * Usage:
 *   node scripts/post-changelog.mjs [version] [--dry-run]
 *
 * Examples:
 *   node scripts/post-changelog.mjs 3.25.2
 *   node scripts/post-changelog.mjs --dry-run          # uses package.json version
 *   node scripts/post-changelog.mjs 3.25.2 --dry-run
 *
 * Requires:
 *   - `threads` CLI on PATH (symlink at /usr/local/bin/threads → ~/.afk/skills/threads-api/scripts/threads)
 *   - Either AFK_RELEASE_THREADS_TOKEN env var (preferred for CI — routes to a
 *     release-dedicated account) OR ~/.config/threads-cli/config.json (default
 *     fallback for ad-hoc terminal use). The threads CLI's get_token() in
 *     client.py:41 already honors THREADS_ACCESS_TOKEN first, so we forward
 *     AFK_RELEASE_THREADS_TOKEN through as THREADS_ACCESS_TOKEN when set.
 *     Keeping the env-var name distinct (AFK_RELEASE_*) prevents accidental
 *     bleed from local shells that already export THREADS_ACCESS_TOKEN.
 *
 * Optional:
 *   - AFK_RELEASE_THREADS_TOPIC_TAG env var — when set, appends --topic-tag
 *     <value> to the threads CLI argv. Meta-curated tags only (e.g. "Agent AFK").
 *     Invalid/unknown tag values surface as a non-zero exit from the CLI with
 *     the API error in stderr; the existing failure path handles that.
 *
 * Idempotency:
 *   Already-posted versions are tracked in ~/.local/share/threads-data/posted-versions.json.
 *   Re-running for the same version exits 0 without posting.
 *
 * Exit codes:
 *   0 — posted successfully, or already posted (idempotent no-op)
 *   1 — failure (parse error, CLI error, etc.)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const versionArg = args.find((a) => !a.startsWith('--'));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fail(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Resolve version
// ---------------------------------------------------------------------------

let version;
if (versionArg) {
  // Accept with or without leading 'v'
  version = versionArg.replace(/^v/, '');
} else {
  const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));
  version = pkg.version;
}

if (!/^\d+\.\d+\.\d+/.test(version)) {
  fail(`Invalid version: ${version}`);
}

// ---------------------------------------------------------------------------
// Idempotency check
// ---------------------------------------------------------------------------

const stateDir = resolve(homedir(), '.local', 'share', 'threads-data');
const stateFile = resolve(stateDir, 'posted-versions.json');

function loadState() {
  if (!existsSync(stateFile)) return { posted: [] };
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch {
    return { posted: [] };
  }
}

function saveState(state) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

const state = loadState();
if (state.posted.includes(version)) {
  console.log(`Already posted v${version}, skipping.`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Parse CHANGELOG.md for the target version
// ---------------------------------------------------------------------------

const changelogPath = resolve(repoRoot, 'CHANGELOG.md');
const changelog = readFileSync(changelogPath, 'utf8');

/**
 * Extract the markdown section for `version` from the changelog.
 * Returns the lines between `## [X.Y.Z]` and the next `## [` heading.
 */
function extractVersionSection(text, ver) {
  const lines = text.split('\n');
  const startPattern = new RegExp(`^## \\[${ver.replace(/\./g, '\\.')}\\]`);
  const nextVersionPattern = /^## \[/;

  let inSection = false;
  const sectionLines = [];

  for (const line of lines) {
    if (!inSection) {
      if (startPattern.test(line)) {
        inSection = true;
        // Don't include the heading itself — we compose our own
      }
      continue;
    }
    // Stop at the next version heading
    if (nextVersionPattern.test(line)) break;
    sectionLines.push(line);
  }

  return sectionLines;
}

const sectionLines = extractVersionSection(changelog, version);
if (sectionLines.length === 0) {
  fail(`No changelog section found for v${version}`);
}

// ---------------------------------------------------------------------------
// Parse subsections (Added, Changed, Fixed, Removed)
// ---------------------------------------------------------------------------

/**
 * Parse the section lines into a map of { sectionName -> bullet[] }.
 * Bullet text strips the leading `- ` and trailing ` (hash)` commit suffix.
 */
function parseSections(lines) {
  // Desired display order
  const ORDER = ['Added', 'Changed', 'Fixed', 'Removed'];
  const sections = {};
  let current = null;

  for (const line of lines) {
    const headingMatch = line.match(/^### (.+)/);
    if (headingMatch) {
      current = headingMatch[1].trim();
      sections[current] = [];
      continue;
    }
    if (current && line.startsWith('- ')) {
      // Strip trailing commit hash like ` (abc1234)` or ` (#123) (abc1234)`
      const text = line
        .slice(2)
        .replace(/\s+\([0-9a-f]{7,}\)$/, '')
        .replace(/\s+\(#\d+\)\s+\([0-9a-f]{7,}\)$/, '')
        .replace(/\s+\(#\d+\)$/, '')
        .trim();
      if (text.startsWith('Merge ')) continue;
      if (text) sections[current].push(text);
    }
  }

  // Return in canonical order, omitting empty/absent sections
  return ORDER.filter((name) => sections[name] && sections[name].length > 0).map((name) => ({
    name,
    bullets: sections[name],
  }));
}

const sections = parseSections(sectionLines);
if (sections.length === 0) {
  fail(`No bullet entries found in changelog section for v${version}`);
}

// ---------------------------------------------------------------------------
// Format the Threads post
// ---------------------------------------------------------------------------

const MAX_CHARS = 500;

// Invariant: the footer URL must be visible on every post regardless of
// truncation. The body is sized against MAX_CHARS - FOOTER.length so a
// trailing '…' (when bullets overflow) lands BEFORE the footer, never
// after. Threads auto-linkifies bare domains, so no `https://` prefix
// needed — keeps the footer compact (14 chars including the leading
// blank line).
const FOOTER = '\n\nagentafk.com';

/**
 * Build the post text from the parsed sections.
 * If it exceeds MAX_CHARS, drop trailing bullets one at a time until it fits,
 * then append '…'. The footer URL is appended last and always preserved.
 */
function formatPost(ver, parsedSections) {
  const header = `agent-afk v${ver}`;
  const bodyBudget = MAX_CHARS - FOOTER.length;

  // Build lines for each section
  const bodyLines = [];
  for (const { name, bullets } of parsedSections) {
    bodyLines.push('');
    bodyLines.push(name);
    for (const b of bullets) {
      bodyLines.push(`• ${b}`);
    }
  }

  const fullText = header + bodyLines.join('\n');
  if (fullText.length <= bodyBudget) return fullText + FOOTER;

  // Truncate: drop bullets from the end until it fits (with '…')
  // Work with a flat list of all bullet lines tagged by section
  const allBulletLines = [];
  for (const { name, bullets } of parsedSections) {
    for (const b of bullets) {
      allBulletLines.push({ section: name, text: `• ${b}` });
    }
  }

  // Binary-search style: drop from the tail
  while (allBulletLines.length > 0) {
    allBulletLines.pop();

    // Rebuild from remaining bullets
    const grouped = {};
    for (const { section, text } of allBulletLines) {
      if (!grouped[section]) grouped[section] = [];
      grouped[section].push(text);
    }

    const truncatedLines = [];
    for (const { name } of parsedSections) {
      if (!grouped[name]) continue;
      truncatedLines.push('');
      truncatedLines.push(name);
      for (const t of grouped[name]) truncatedLines.push(t);
    }

    const candidate = header + truncatedLines.join('\n') + '\n…';
    if (candidate.length <= bodyBudget) return candidate + FOOTER;
  }

  // Edge case: header alone exceeds budget (shouldn't happen with sane versions)
  return (header + '\n…').slice(0, bodyBudget) + FOOTER;
}

const postText = formatPost(version, sections);

// ---------------------------------------------------------------------------
// Dry-run output
// ---------------------------------------------------------------------------

if (dryRun) {
  console.log('--- DRY RUN — would post to Threads ---\n');
  console.log(postText);
  console.log(`\n--- ${postText.length} / ${MAX_CHARS} chars ---`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Post to Threads via CLI
// ---------------------------------------------------------------------------

// Invariant: AFK_RELEASE_THREADS_TOKEN, when set, MUST route the post to a
// release-dedicated account — not the default ~/.config/threads-cli/config.json
// token. The threads CLI's get_token() (client.py:41) honors THREADS_ACCESS_TOKEN
// first; we forward AFK_RELEASE_THREADS_TOKEN under that name and ONLY for this
// spawn. Keeping the AFK_RELEASE_* name distinct in our process env prevents
// accidental bleed from a developer shell that already exports
// THREADS_ACCESS_TOKEN for ad-hoc use.
const releaseToken = process.env['AFK_RELEASE_THREADS_TOKEN'];
const tokenSource = releaseToken ? 'AFK_RELEASE_THREADS_TOKEN' : '~/.config/threads-cli/config.json (default)';
// Optional topic tag — passed to the threads CLI as --topic-tag. Meta's API
// rejects unknown/uncurated tags with a 400; when the spawn returns non-zero
// the existing error path surfaces the stderr verbatim, so debugging an
// invalid tag value is straightforward.
const topicTag = (process.env['AFK_RELEASE_THREADS_TOPIC_TAG'] ?? '').trim();
const tagSuffix = topicTag ? ` with topic tag "${topicTag}"` : '';
console.log(`Posting v${version} to Threads via ${tokenSource}${tagSuffix}...`);

const spawnEnv = { ...process.env };
if (releaseToken) {
  spawnEnv['THREADS_ACCESS_TOKEN'] = releaseToken;
}

// Build argv. spawnSync's array form means each element is passed literally;
// the topic tag value can contain spaces ("Agent AFK") without any quoting
// or escaping concern — it's argv[3], not a shell token.
const spawnArgs = ['post', postText];
if (topicTag) {
  spawnArgs.push('--topic-tag', topicTag);
}

// Invariant: pass postText as an argv element via spawnSync, NOT as part of a
// shell command string. Two bugs the old execSync(`threads post "${escaped}"`)
// path produced:
//   1. Shell metacharacters in the body (backticks, $, \) were evaluated by
//      /bin/sh even though wrapped in double quotes. A changelog bullet like
//      `truncated` flag for overflow produced `truncated: command not found`
//      and silently stripped the word from the published post.
//   2. The threads CLI's publish_flow does a hardcoded time.sleep(30) between
//      container-create and publish for TEXT posts (threads_cli/publish.py:81).
//      With the prior 30_000ms execSync timeout, Node killed the subprocess at
//      exactly t=30s — the moment Python finished its sleep — so the publish
//      API call never executed. Every text post failed with ETIMEDOUT.
// Fix: spawnSync with an array (no shell interpolation) + 60_000ms timeout
// (30s sleep + publish call + headroom). When the upstream CLI's sleep is
// reduced, this timeout can come back down.
const result = spawnSync('threads', spawnArgs, {
  encoding: 'utf8',
  timeout: 60_000,
  env: spawnEnv,
});
if (result.error) {
  fail(`threads CLI failed: ${result.error.message}`);
}
if (result.status !== 0) {
  const stderr = (result.stderr ?? '').trim();
  const stdout = (result.stdout ?? '').trim();
  fail(`threads CLI exited ${result.status}: ${stderr || stdout || '(no output)'}`);
}
console.log(`Posted: ${(result.stdout ?? '').trim()}`);

// ---------------------------------------------------------------------------
// Record idempotency
// ---------------------------------------------------------------------------

state.posted.push(version);
saveState(state);
console.log(`Recorded v${version} in ${stateFile}`);
