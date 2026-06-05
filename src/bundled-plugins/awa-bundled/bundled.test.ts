import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Pinned hashes for the bundled skills shipped under awa-bundled/. These
// files mirror — but are NOT byte-equal to — corresponding upstream skills.
// Permanent intentional differences include:
//
//   - Namespace prefixes (upstream plugin-namespaced form → bare `/skill` here)
//   - Sub-agent dispatch identifiers (namespaced form → bare name)
//   - Occasional wording divergence between maintainers
//
// Because byte-equality is a false invariant, this file enforces only the
// pinned-hash snapshot: any unauthored edit to a bundled SKILL.md fails the
// test until the developer explicitly bumps the hash here. That bump is the
// forcing function for cross-repo discipline:
//
//   *** Workflow when bumping a pinned hash ***
//   1. Identify what changed in the bundled SKILL.md.
//   2. Check whether the same change applies upstream.
//   3. If yes → open a parallel PR upstream. Land both before either
//      is released.
//   4. If no → document why the change is bundled-only in the PR description.
//   5. Only then update the hash below.
//
// This convention exists because in November 2026 a critical /ship guardrail
// (the "Branch lock" + "Never push to main" Hard Rules in commit 63f3ed3)
// was added to the bundled mirror but never back-ported to example-plugin. The
// deployed plugin therefore lacked the guardrail until the next sync. This
// test cannot prevent that on its own — but the hash-bump moment forces the
// developer to look at both copies.
const PINNED_HASHES = {
  contract: '0b7febafec024e8dd4404f75e84d21ee72b1b1846d6e2610aaa82ba77f9d6f2d',
  'devils-advocate':
    '84275b097fa3ed270b0b71c87e2dad0366794fd7efc7a47d29abaa85da97f974',
  // gather + parallelize carry a bundled-only `context: load` frontmatter line
  // (2026-06 skill-execution-mode work). `context` is an agent-afk-specific
  // field; Claude Code upstream skills are natively inline/progressive-disclosure,
  // so there is NO upstream counterpart to back-port — permanent bundled-only
  // divergence (allowlisted in INTENTIONAL_DIFFS below). See docs/skill-load-mode.md.
  gather: '26ef18dde7db7c313655b0fe3097f14966763298ff5a2fe643ccf18d0f6b29c0',
  'ground-claim':
    'd877c1e7de08ecb8788677f6a8f3b51f5d48cefefbf4019af2e37ac1484a95bb',
  'ground-state':
    'ae4c167296e96b640a54cd4cd317e5810894cffff6dac3c022b1433dff003105',
  // intent-lock is bundled-only (no upstream counterpart).
  // Hash bumps need no parallel PR — document the change in the
  // commit message instead.
  'intent-lock':
    '7a466075e5a64c1145b97aa24b9a6990a3ee1dc818b93c158433e53d7416aef0',
  // parallelize: bundled-only `context: load` added — see the gather note above.
  parallelize:
    'be8b2a301fe35d86d96d4be6f8418bf497dd9050767a3837cf057d7d5a1cd719',
  // refactor is bundled-only (no upstream example-plugin counterpart); verbatim
  // copy of the user-scope /refactor at ~/.afk/skills/.
  refactor: '23ab4836653159deeafbca45e516af8d43e8c5275535613e36f7bcb2d77de64e',
  research: '0d04d0a05891ed1b63679e5a0237b743364a6165731a8f694c5584ed7661505f',
  review: '816ea27cf665be23c67cf887d639d40e1435954f80ceeb43740bcd7f39c205e7',
  'shadow-verify':
    '8bce741e55be049a196ed6c71efd0acd271f272a8e2202917c3f1243b875eb33',
  ship: '4b9a0e40372c36f953ad6d37347e1682950c9825ca5e312fae4e9b320cde975f',
  // simplify is bundled-only (no upstream example-plugin counterpart).
  simplify:
    'b863890eead7011c90d4f93b65e5a1533c8f88292728ec771f8b128e9535d996',
  spec: 'c08f3b4fbe1f585b1e8354a000e0d2d3a48455ad322c7a27112d509aa9698fe7',
} as const;

type SkillName = keyof typeof PINNED_HASHES;

const SKILLS = Object.keys(PINNED_HASHES) as SkillName[];

// ── Namespace-normalized drift detection ──────────────────────────────────────
//
// Workspace root is four levels above __dirname (src/bundled-plugins/awa-bundled).
// example-plugin is a sibling of agent-afk at the workspace root level.
// This mirrors the pattern used in src/skills/_agents/vendored.test.ts.
const WORKSPACE_ROOT = join(__dirname, '../../../..');

// Upstream source paths relative to WORKSPACE_ROOT.
// intent-lock, simplify, refactor are bundled-only — no upstream comparison row.
const UPSTREAM_PATHS: Partial<Record<SkillName, string>> = {
  contract: 'example-plugin/plugins/framework/skills/contract/SKILL.md',
  gather: 'example-plugin/plugins/framework/skills/gather/SKILL.md',
  'ground-claim': 'example-plugin/plugins/framework/skills/ground-claim/SKILL.md',
  'ground-state': 'example-plugin/plugins/framework/skills/ground-state/SKILL.md',
  research: 'example-plugin/plugins/framework/skills/research/SKILL.md',
  ship: 'example-plugin/plugins/framework/skills/ship/SKILL.md',
  spec: 'example-plugin/plugins/framework/skills/spec/SKILL.md',
  'devils-advocate':
    'example-plugin/plugins/example-plugin/skills/devils-advocate/SKILL.md',
  parallelize: 'example-plugin/plugins/example-plugin/skills/parallelize/SKILL.md',
  review: 'example-plugin/plugins/example-plugin/skills/review/SKILL.md',
  'shadow-verify':
    'example-plugin/plugins/example-plugin/skills/shadow-verify/SKILL.md',
};

// Normalize both copies before comparing, removing all permanent intentional
// namespace shifts (upstream plugin-prefixed forms → bare skill names here).
//
// After normalization, any remaining diff is either real drift (a change
// landed in one mirror but not the other) or an explicitly allowlisted
// intentional divergence documented in INTENTIONAL_DIFFS below.
function normalize(content: string): string {
  return content
    .replace(/\/framework:/g, '/')
    .replace(/\/example-plugin:/g, '/')
    .replace(/`framework:/g, '`')
    .replace(/`example-plugin:/g, '`')
    .replace(/"framework:/g, '"')
    .replace(/"example-plugin:/g, '"');
}

// INTENTIONAL_DIFFS: per-skill array of RegExp patterns.  A normalized diff
// line matching any pattern for that skill is silently accepted — the line is
// removed from BOTH sides before comparison (each pattern is applied to both
// the bundled and upstream line arrays independently).
//
// *** Adding an entry here requires an inline comment justifying why the
// divergence is intentional.  "It seems fine" is NOT sufficient — if you
// cannot defensibly justify it, surface it as unclassified drift in the PR
// body instead. ***
const INTENTIONAL_DIFFS: Partial<Record<SkillName, RegExp[]>> = {
  // devils-advocate, parallelize, shadow-verify:
  //   Both sides contain a "Sub-agent contract" invocation line immediately
  //   after the frontmatter block, but they use different plugin namespaces:
  //
  //     Bundled:  /contract          (resolves to the co-bundled contract skill)
  //     Upstream: /agent-workflow-amplifiers:contract  (third-party plugin ns)
  //
  //   The `normalize()` function only strips framework and `example-plugin:`
  //   prefixes; it intentionally does NOT touch `agent-workflow-amplifiers:`
  //   because that is a distinct third-party plugin, not a namespace shift of
  //   the same plugin.  Both copies invoke the same logical skill — the
  //   difference is which plugin registry entry resolves the name.  This is
  //   intentional structural divergence: bundled uses self-contained routing;
  //   upstream relies on the agent-workflow-amplifiers plugin being installed.
  //
  //   Pattern rationale: we match both the bare `/contract` line (bundled side)
  //   and the namespaced `/agent-workflow-amplifiers:contract` line (upstream
  //   side) so both are removed before the equality check.
  'devils-advocate': [
    // Bundled side: bare /contract invocation (no plugin prefix).
    /^\/contract$/,
    // Upstream side: /agent-workflow-amplifiers:contract invocation.
    /\/agent-workflow-amplifiers:contract/,
  ],
  parallelize: [
    // Same structural divergence as devils-advocate — different contract
    // skill namespace on bundled vs upstream.
    /^\/contract$/,
    /\/agent-workflow-amplifiers:contract/,
    // Bundled-only agent-afk execution-mode field (no upstream equivalent —
    // Claude Code skills are natively inline). See docs/skill-load-mode.md.
    /^context: load$/,
  ],
  'shadow-verify': [
    // Same structural divergence as devils-advocate.
    /^\/contract$/,
    /\/agent-workflow-amplifiers:contract/,
  ],

  // gather: bundled-only `context: load` execution-mode field (no upstream
  // equivalent — Claude Code skills are natively inline). See docs/skill-load-mode.md.
  gather: [/^context: load$/],

  // research — 1-line divergence, #441 back-port gap:
  //   "if the research-agent is not available" (bundled) vs
  //   "if the private plugin is not installed" (upstream).
  //   Bundled users have no concept of "private plugin" — the research-agent
  //   IS bundled, so "not available" is the correct user-facing phrase.  The
  //   upstream wording assumed plugin-based deployment context.  This divergence
  //   is intentional for bundled context; upstream should ideally adopt a
  //   context-neutral phrasing.  Flagged for #441 reconciliation.
  research: [
    /if the research-agent is not available/,
    /if the private plugin is not installed/,
  ],

  // ship — 3 divergences, all #441 back-port gaps:
  //
  //   1. Phase 3 heading:
  //        Bundled: "Phase 3 — Draft commit message."
  //        Upstream: "Phase 3 — Draft commit message (user-approval gate)."
  //      The "(user-approval gate)" annotation was added in upstream but not
  //      back-ported to bundled.  Both copies have the same behavior (no
  //      approval gate); the annotation is a clarifying label.  Real drift,
  //      flagged for #441 back-port.
  //
  //   2. Phase 3 body prose:
  //        Bundled: "Print the draft message + file list to the user as
  //          info-only output, then **immediately** invoke Phase 4.
  //          **This is not a gate. Do not ask "does this look good?" Do not
  //          wait for approval.** The user surface is one continuous turn:
  //          draft → commit → push → PR URL."
  //        Upstream: "Surface the draft message + file list to the user for
  //          visibility, then proceed immediately to commit. Do not wait for
  //          approval."
  //      Upstream simplified the prose; semantics are identical.  Real drift
  //      (editorial improvement in upstream not back-ported).  Flagged for #441.
  //
  //   3. Phase 5 Never-push-main bullet order:
  //        Bundled: bullet appears after "Non-fast-forward rejection" bullet.
  //        Upstream: bullet appears before "Upstream unset" bullet (earlier).
  //      Same safety rule, different list position.  Real drift (harmless
  //      reordering).  Flagged for #441 back-port.
  ship: [
    // Heading divergence (1 above).
    /Phase 3 — Draft commit message\./,
    /Phase 3 — Draft commit message \(user-approval gate\)\./,
    // Prose divergence (2 above) — match the diverging body paragraph.
    /Print the draft message \+ file list to the user as info-only output/,
    /then \*\*immediately\*\* invoke Phase 4\./,
    /\*\*This is not a gate\. Do not ask "does this look good\?" Do not wait for approval\.\*\*/,
    /The user surface is one continuous turn: draft → commit → push → PR URL\./,
    /Surface the draft message \+ file list to the user for visibility/,
    /then proceed immediately to commit\. Do not wait for approval\./,
    // Bullet ordering divergence (3 above).
    /\*\*Never\*\* `git push origin main` \(or `master`\)\. Pushing the feature branch is the only allowed form\./,
  ],

  // review — namespace-only divergence (back-port landed; #441 closed):
  //   The bundled review is now the de-namespaced mirror of upstream
  //   example-plugin review. The previously-allowlisted #441 drift —
  //   Wave 1.5 (citation + absence-claim verification), reviewed-ref
  //   capture / SHA pinning, the citation-requirement block, the severity
  //   sort-order block, epistemic scope disclosure, and the ref:<sha>
  //   finding-schema fields — has been back-ported into bundled; and the
  //   api-compat reachability + absence-claim grounding gates were ported
  //   the other way into upstream (example-plugin#40). Both
  //   copies now carry the full superset, so the only remaining divergence
  //   is the same contract-namespace shift as devils-advocate / parallelize
  //   / shadow-verify: bundled uses /contract (self-contained routing),
  //   upstream uses /agent-workflow-amplifiers:contract (third-party ns).
  review: [
    // Bundled side: bare /contract invocation (no plugin prefix).
    /^\/contract$/,
    // Upstream side: /agent-workflow-amplifiers:contract invocation.
    /\/agent-workflow-amplifiers:contract/,
  ],
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function computeHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function bundledPath(name: SkillName): string {
  return join(__dirname, 'skills', name, 'SKILL.md');
}

function readBundled(name: SkillName): string {
  return readFileSync(bundledPath(name), 'utf8');
}

function upstreamAbsPath(name: SkillName): string | null {
  const rel = UPSTREAM_PATHS[name];
  if (!rel) return null;
  return join(WORKSPACE_ROOT, rel);
}

function upstreamAvailable(name: SkillName): boolean {
  const abs = upstreamAbsPath(name);
  return abs !== null && existsSync(abs);
}

// isAllowlisted returns true if the given line matches any pattern in the
// skill's INTENTIONAL_DIFFS entry.
function isAllowlisted(line: string, name: SkillName): boolean {
  const patterns = INTENTIONAL_DIFFS[name] ?? [];
  return patterns.some((re) => re.test(line));
}

// diffLines computes the symmetric difference between two ordered line arrays:
// lines that are in `aLines` but not `bLines` (bundled-only), and lines that
// are in `bLines` but not `aLines` (upstream-only).  Returns the two sets.
// This is intentionally set-based (not position-sensitive) to avoid false
// positives from harmless reorderings of identical content.
function diffLines(
  aLines: string[],
  bLines: string[],
): { bundledOnly: string[]; upstreamOnly: string[] } {
  const aCount = new Map<string, number>();
  const bCount = new Map<string, number>();
  for (const l of aLines) aCount.set(l, (aCount.get(l) ?? 0) + 1);
  for (const l of bLines) bCount.set(l, (bCount.get(l) ?? 0) + 1);

  const bundledOnly: string[] = [];
  const upstreamOnly: string[] = [];

  for (const [l, cnt] of aCount) {
    const excess = cnt - (bCount.get(l) ?? 0);
    for (let i = 0; i < excess; i++) bundledOnly.push(l);
  }
  for (const [l, cnt] of bCount) {
    const excess = cnt - (aCount.get(l) ?? 0);
    for (let i = 0; i < excess; i++) upstreamOnly.push(l);
  }

  return { bundledOnly, upstreamOnly };
}

// ── Test suites ───────────────────────────────────────────────────────────────

describe('bundled skills', () => {
  describe('pinned-hash snapshot tests', () => {
    for (const name of SKILLS) {
      it(`${name} bundled copy matches pinned hash`, () => {
        const content = readBundled(name);
        const hash = computeHash(content);
        expect(hash).toBe(PINNED_HASHES[name]);
      });
    }
  });

  describe('skill inventory invariants', () => {
    it('covers every bundled skill directory', () => {
      // Sentinel: if a new skill is added to awa-bundled/skills/ but not
      // PINNED_HASHES, this test fails — forcing the author to register it.
      const skillsDir = join(__dirname, 'skills');
      const entries = readdirSync(skillsDir)
        .filter((name) => statSync(join(skillsDir, name)).isDirectory())
        .sort();
      const registered = [...SKILLS].sort();
      expect(entries).toEqual(registered);
    });
  });

  // ── Namespace-normalized drift comparison ──────────────────────────────────
  //
  // Each test below compares a bundled SKILL.md against its upstream
  // counterpart after normalization (namespace prefixes stripped) and
  // allowlisting (known intentional divergences removed).
  //
  // The test is skipped — NOT failed — when example-plugin is not co-located
  // (e.g. standalone CI clone).  The pinned-hash tests above still guard
  // against local-only edits.  These tests guard against the cross-repo case:
  // a change landing in one mirror without being back-ported to the other.
  //
  // Workflow when a test fails here:
  //   1. Is the diff intentional?  Add a justified entry to INTENTIONAL_DIFFS.
  //   2. Is it real drift?  Land the back-port and re-run.  Then bump the hash.
  //   3. Is it unclassifiable?  Surface it as unclassified drift in the PR body.
  describe('namespace-normalized drift comparison (skipped if example-plugin not co-located)', () => {
    // Invariant: for every mirrorable skill, after normalize() and after
    // removing allowlisted lines, the bundled and upstream copies must be
    // line-for-line identical.  Any remaining difference is a back-port gap.

    const mirrorableSkills = SKILLS.filter(
      (s) => s !== 'intent-lock' && s !== 'simplify' && s !== 'refactor',
    );

    for (const name of mirrorableSkills) {
      it.skipIf(!upstreamAvailable(name))(
        `${name}: normalized bundled matches normalized upstream (after allowlist)`,
        () => {
          // Contract: upstreamAbsPath is non-null when upstreamAvailable() is true.
          const abs = upstreamAbsPath(name) as string;
          const bundledRaw = readBundled(name);
          const upstreamRaw = readFileSync(abs, 'utf8');

          const bundledLines = normalize(bundledRaw).split('\n');
          const upstreamLines = normalize(upstreamRaw).split('\n');

          // Compute symmetric difference: lines unique to each side.
          // Context lines (identical on both sides) are ignored — we only care
          // about lines that changed.
          const { bundledOnly, upstreamOnly } = diffLines(
            bundledLines,
            upstreamLines,
          );

          // Remove allowlisted divergences from each side.
          const unexpectedBundledOnly = bundledOnly.filter(
            (l) => !isAllowlisted(l, name),
          );
          const unexpectedUpstreamOnly = upstreamOnly.filter(
            (l) => !isAllowlisted(l, name),
          );

          if (
            unexpectedBundledOnly.length > 0 ||
            unexpectedUpstreamOnly.length > 0
          ) {
            const lines: string[] = [
              `--- bundled (normalized, non-allowlisted unique lines)`,
              `+++ upstream (normalized, non-allowlisted unique lines)`,
            ];
            for (const l of unexpectedBundledOnly) lines.push(`-${l}`);
            for (const l of unexpectedUpstreamOnly) lines.push(`+${l}`);

            throw new Error(
              `Namespace-normalized drift detected in ${name}.\n` +
                `  Bundled:  ${bundledPath(name)}\n` +
                `  Upstream: ${abs}\n` +
                `  If the diff is intentional, add a justified entry to INTENTIONAL_DIFFS['${name}'].\n` +
                `  If it is real drift, back-port the change and bump the pinned hash.\n\n` +
                lines.join('\n'),
            );
          }
        },
      );
    }
  });
});
