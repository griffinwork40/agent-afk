#!/usr/bin/env tsx
/**
 * Recompute SHA-256 hash pins for vendored and bundled skill files.
 *
 * Two test files hard-code pinned hashes that guard against undocumented edits:
 *
 *   src/skills/_agents/vendored.test.ts     — 3 vendored agent prompt files
 *   src/bundled-plugins/awa-bundled/bundled.test.ts — 14 bundled SKILL.md files
 *
 * Both compute hashes as: createHash('sha256').update(rawContent).digest('hex')
 * with NO normalization applied before hashing.
 *
 * Usage:
 *   pnpm fix:pins             # recompute and rewrite stale pins in both test files
 *   pnpm fix:pins:check       # exit nonzero if any pin would change (CI gate)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const isCheck = process.argv.includes('--check');

// ── Hash helper ────────────────────────────────────────────────────────────────

function computeHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

// ── Target file definitions ────────────────────────────────────────────────────

interface PinTarget {
  /** Absolute path to the test file containing PINNED_HASHES */
  testFile: string;
  /** Map from pin key to absolute path of the source file to hash */
  pins: Record<string, string>;
}

// vendored.test.ts: hashes src/skills/_agents/prompts/<name>.md
// Path logic from test: join(__dirname, '../../../src/skills/_agents/prompts', `${name}.md`)
// where test __dirname = src/skills/_agents — so paths resolve from repo root as below.
const vendoredPromptsDir = join(repoRoot, 'src/skills/_agents/prompts');
const vendoredTarget: PinTarget = {
  testFile: join(repoRoot, 'src/skills/_agents/vendored.test.ts'),
  pins: {
    'research-agent': join(vendoredPromptsDir, 'research-agent.md'),
    contract: join(vendoredPromptsDir, 'contract.md'),
    'git-investigator': join(vendoredPromptsDir, 'git-investigator.md'),
  },
};

// bundled.test.ts: hashes src/bundled-plugins/awa-bundled/skills/<name>/SKILL.md
// Path logic from test: join(__dirname, 'skills', name, 'SKILL.md')
// where test __dirname = src/bundled-plugins/awa-bundled
const bundledSkillsDir = join(repoRoot, 'src/bundled-plugins/awa-bundled/skills');
const bundledTarget: PinTarget = {
  testFile: join(repoRoot, 'src/bundled-plugins/awa-bundled/bundled.test.ts'),
  pins: {
    automate: join(bundledSkillsDir, 'automate/SKILL.md'),
    contract: join(bundledSkillsDir, 'contract/SKILL.md'),
    'devils-advocate': join(bundledSkillsDir, 'devils-advocate/SKILL.md'),
    gather: join(bundledSkillsDir, 'gather/SKILL.md'),
    'ground-claim': join(bundledSkillsDir, 'ground-claim/SKILL.md'),
    'ground-state': join(bundledSkillsDir, 'ground-state/SKILL.md'),
    'intent-lock': join(bundledSkillsDir, 'intent-lock/SKILL.md'),
    parallelize: join(bundledSkillsDir, 'parallelize/SKILL.md'),
    refactor: join(bundledSkillsDir, 'refactor/SKILL.md'),
    research: join(bundledSkillsDir, 'research/SKILL.md'),
    review: join(bundledSkillsDir, 'review/SKILL.md'),
    'shadow-verify': join(bundledSkillsDir, 'shadow-verify/SKILL.md'),
    ship: join(bundledSkillsDir, 'ship/SKILL.md'),
    simplify: join(bundledSkillsDir, 'simplify/SKILL.md'),
    spec: join(bundledSkillsDir, 'spec/SKILL.md'),
  },
};

const TARGETS: PinTarget[] = [vendoredTarget, bundledTarget];

// ── PINNED_HASHES block rewriter ───────────────────────────────────────────────
//
// Invariant: The rewrite must only change hex string values for known keys and
// must not disturb surrounding comments, key order, indentation, quoting style,
// or the `as const` suffix. We locate the block by its open/close boundaries
// and replace each hash literal with a targeted regex that matches only the
// 64-char hex string value for that exact key.
//
// The regex for each key handles both single-line style:
//   contract: 'abc123...',
// and wrapped style (value on the next line):
//   'devils-advocate':
//     'abc123...',
// Both patterns end with either a trailing comma or the closing `}`.
// We replace only the 64-char hex string in the value position.

function rewritePins(
  source: string,
  pins: Record<string, string>,
  newHashes: Record<string, string>,
): string {
  let result = source;

  for (const key of Object.keys(pins)) {
    const newHash = newHashes[key];
    if (newHash === undefined) continue;

    // Escape the key for use in a regex (hyphens need escaping in char classes
    // but are safe in a character sequence — the only special chars in our keys
    // are hyphens, which are literal outside character classes).
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Match the key (quoted or bare) followed by an optional colon+whitespace
    // on the same line, then optionally a newline+whitespace (wrapped style),
    // then a 64-char hex string in single quotes.
    //
    // Group 1: everything from the key through the opening quote of the hash
    // Group 2: the 64-char hex value (the only thing we replace)
    // Group 3: the closing quote (and optional trailing comma)
    const pattern = new RegExp(
      `('${escapedKey}'|${escapedKey})` +   // key: quoted or bare
      `(:[^']*?')`                          + // colon + optional whitespace/newline + opening quote
      `([0-9a-f]{64})`                      + // current 64-char hex hash (group 3)
      `('[,]?)`,                              // closing quote + optional comma
      'g',
    );

    result = result.replace(pattern, (_match, keyPart, middle, _oldHash, tail) => {
      return `${keyPart}${middle}${newHash}${tail}`;
    });
  }

  return result;
}

// ── Main ───────────────────────────────────────────────────────────────────────

interface StalePin {
  testFile: string;
  key: string;
  sourceFile: string;
  currentHash: string;
  freshHash: string;
}

const stalePins: StalePin[] = [];

for (const target of TARGETS) {
  const source = readFileSync(target.testFile, 'utf8');
  const newHashes: Record<string, string> = {};

  // Compute fresh hash for every key
  for (const [key, srcPath] of Object.entries(target.pins)) {
    const content = readFileSync(srcPath, 'utf8');
    newHashes[key] = computeHash(content);
  }

  // Extract current pinned hashes from the test file by finding each key's value
  for (const [key, srcPath] of Object.entries(target.pins)) {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(
      `(?:'${escapedKey}'|${escapedKey})` +
      `:[^']*?'` +
      `([0-9a-f]{64})` +
      `'`,
    );
    const match = pattern.exec(source);
    const currentHash = match?.[1] ?? '';
    const freshHash = newHashes[key] ?? '';

    if (currentHash !== freshHash) {
      stalePins.push({
        testFile: target.testFile.replace(repoRoot + '/', ''),
        key,
        sourceFile: srcPath.replace(repoRoot + '/', ''),
        currentHash,
        freshHash,
      });
    }
  }

  // In write mode, rewrite the test file if any pins changed for this target
  if (!isCheck) {
    const rewritten = rewritePins(source, target.pins, newHashes);
    if (rewritten !== source) {
      writeFileSync(target.testFile, rewritten, 'utf8');
      console.log(`Updated pins in ${target.testFile.replace(repoRoot + '/', '')}`);
    }
  }
}

// ── Report results ─────────────────────────────────────────────────────────────

if (stalePins.length === 0) {
  console.log('All hash pins are up to date.');
  process.exit(0);
} else if (isCheck) {
  console.error(`${stalePins.length} stale hash pin(s) found:\n`);
  for (const pin of stalePins) {
    console.error(`  [${pin.testFile}] key: ${pin.key}`);
    console.error(`    source file : ${pin.sourceFile}`);
    console.error(`    pinned hash : ${pin.currentHash}`);
    console.error(`    actual hash : ${pin.freshHash}`);
    console.error('');
  }
  console.error('Run `pnpm fix:pins` to regenerate.');
  process.exit(1);
} else {
  // Write mode: already rewrote above — just summarise what changed
  for (const pin of stalePins) {
    console.log(`  [${pin.testFile}] ${pin.key}: ${pin.currentHash.slice(0, 12)}… → ${pin.freshHash.slice(0, 12)}…`);
  }
}
