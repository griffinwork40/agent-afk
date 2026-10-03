#!/usr/bin/env tsx
/**
 * check-engines-node-floor.ts — CI gate for engines.node lower-bound raises.
 *
 * Compares the `engines.node` field in package.json between the most recent
 * git tag (LAST_TAG) and HEAD.  If the minimum Node.js version has been raised,
 * exits 1 so the auto-release workflow classifies the change as a major bump.
 *
 * Usage (called by .github/workflows/auto-release.yml):
 *   tsx scripts/check-engines-node-floor.ts [LAST_TAG]
 *
 *   LAST_TAG defaults to `git describe --tags --abbrev=0` when not supplied.
 *   If there is no previous tag the script exits 0 (no comparison possible).
 *
 * Exit codes:
 *   0 — floor unchanged / lowered / same-ref-unparseable (no action needed)
 *   1 — floor was RAISED, or engines.node CHANGED but could not be parsed
 *       (fail closed — an un-parseable bump may still be a floor raise)
 */

import { execFileSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { nodeFloorStatus, parseNodeFloor } from './lib/engines-node-floor.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function sh(cmd: string): string {
  return execSync(cmd, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function getPackageEnginesNode(ref: string): string | null {
  // Contract: use execFileSync so the caller-supplied ref is passed as a
  // positional argument to git rather than interpolated into a shell command
  // string, preventing command injection. Posix-guard R1 forbids literal sh/bash
  // as exec commands — execFileSync('git', ...) is the correct pattern here.
  try {
    const raw = execFileSync('git', ['show', `${ref}:package.json`], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    const pkg = JSON.parse(raw) as { engines?: { node?: string } };
    return pkg.engines?.node ?? null;
  } catch {
    return null;
  }
}

const lastTag = process.argv[2] ?? (() => {
  try {
    return sh('git describe --tags --abbrev=0');
  } catch {
    return '';
  }
})();

if (!lastTag) {
  console.log('check-engines-node-floor: no previous tag found — skipping comparison.');
  process.exit(0);
}

const oldRange = getPackageEnginesNode(lastTag);
const newRange = getPackageEnginesNode('HEAD');

if (!oldRange || !newRange) {
  console.log(`check-engines-node-floor: could not read engines.node from ${!oldRange ? lastTag : 'HEAD'} — skipping.`);
  process.exit(0);
}

const status = nodeFloorStatus(oldRange, newRange);

if (status === 'changed-unparseable') {
  // Fail closed: engines.node changed between refs but at least one value
  // could not be parsed. We cannot confirm the floor was not raised.
  console.error(
    `check-engines-node-floor: engines.node changed between refs but could not be parsed ` +
    `(${lastTag}: ${JSON.stringify(oldRange)}, HEAD: ${JSON.stringify(newRange)}). ` +
    `Cannot confirm the floor was not raised — treating as BUMP=major. ` +
    `Fix engines.node to use a supported >=X.Y.Z form, or run the Auto Release ` +
    `workflow manually with bump=minor/patch if the range did not raise the floor.`,
  );
  process.exit(1);
}

if (status === 'unparseable') {
  // Both refs have the same raw value and it cannot be parsed, or both are
  // independently unparseable with no change — floor cannot have been raised.
  console.log(
    `check-engines-node-floor: could not parse engines.node as a >=X[.Y[.Z]] range ` +
    `(${lastTag}: ${JSON.stringify(oldRange)}, HEAD: ${JSON.stringify(newRange)}) — skipping.`,
  );
  process.exit(0);
}

const oldFloor = parseNodeFloor(oldRange)!;
const newFloor = parseNodeFloor(newRange)!;
const oldStr = oldFloor.join('.');
const newStr = newFloor.join('.');

if (status === 'raised') {
  console.error(
    `check-engines-node-floor: engines.node minimum raised from ` +
    `${oldRange} (${lastTag}) to ${newRange} (HEAD). ` +
    `Raising the Node.js floor is a compatibility-breaking change — ` +
    `treating as BUMP=major. ` +
    `Run the Auto Release workflow manually with bump=major to publish it, ` +
    `or bump=minor/patch if the detection is a false positive.`,
  );
  console.error(`  Old floor: ${oldStr}  →  New floor: ${newStr}`);
  process.exit(1);
}

console.log(
  `check-engines-node-floor: floor unchanged or lowered ` +
  `(${lastTag}: ${oldRange}, HEAD: ${newRange}) — OK.`,
);
process.exit(0);
