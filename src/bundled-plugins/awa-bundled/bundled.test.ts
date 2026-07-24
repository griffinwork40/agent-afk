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
  // automate: afk-native scheduled-run skill (create_schedule + send_telegram +
  // `afk service install daemon`). Mirrors the upstream framework plugin;
  // vendored byte-equal, so no INTENTIONAL_DIFFS entry is needed. Drift row is
  // wired in UPSTREAM_PATHS below (skips until example-plugin is co-located).
  automate: '93380f58316e607f6b95b27a9c2375f0a5403f3a42eb695d0490b50225d8838c',
  contract: '0ea822d8124f5fc55103a3e5e6d0fcb43889bf3f089bc722350da02ecf4f960f',
  // Hash re-bumped during PR #187 review: the Merge section now routes the
  // second convergence condition (≥2 critics agree on the same alternative) to
  // Wave 3.5 — prose-consistency fix only; no behavior change to the guard.
  // Hash re-bumped: ported the private-plugin refinements — Wave 3.5 now names
  // the verifier type explicitly (`subagent_type: "research-agent"`), adds the
  // re-rank cap (escalate to the user if OVERRIDE recurs after 2 re-ranks),
  // scopes the guard OFF when `dissent = true`, notes its CONFIRMED/OVERRIDE
  // verdicts are internal to Wave 3.5 (distinct from shadow-verify's vocab),
  // and states the 3-way terminal decision (original / ≠original+≥2-critic
  // convergence / ≠original+1-critic) explicitly. No frontmatter change
  // (context: load preserved). Bundled-only body; no upstream back-port row.
  'devils-advocate':
    'd301929f02180b742700060d0de094b84ffafab9e16c771b20ee0eba76cd1238',
  // diagnose is bundled-only (no upstream example-plugin counterpart). It ships
  // as the agent-driven /diagnose (context: fork) that replaced the retired
  // vendored TS orchestrator (src/skills/diagnose/). Hash bumps need no parallel
  // PR — document the change in the commit message instead.
  // Hash bumped: ported the private-plugin refinement — the per-hypothesis
  // worktree step now dispatches with `isolation: "worktree"` instead of the
  // manual `worktree` create/`cwd`/remove dance. The prior copy asserted "the
  // `agent` tool has NO `isolation` parameter", which is FALSE for the current
  // codebase (schemas.ts defines the isolation enum ["none","worktree"];
  // subagent-executor.isolation.test.ts + input-parse.ts confirm it is honored
  // at any depth, incl. nested inside a forked skill). Behavior-preserving prose
  // correction; frontmatter (context: fork) unchanged.
  diagnose: '9a54f97470dce8adec5f1456f881aebe1bb550ee6f201ab9d63cccfd8a316096',
  // gather + parallelize carry a bundled-only `context: load` frontmatter line
  // (2026-06 skill-execution-mode work). `context` is an agent-afk-specific
  // field; Claude Code upstream skills are natively inline/progressive-disclosure,
  // so there is NO upstream counterpart to back-port — permanent bundled-only
  // divergence (allowlisted in INTENTIONAL_DIFFS below). See docs/skill-load-mode.md.
  gather: '26ef18dde7db7c313655b0fe3097f14966763298ff5a2fe643ccf18d0f6b29c0',
  'ground-claim':
    'e3ceabc8d6b9b19526eb30441c17e763b56cb779d7549f54b45835b06a90fb8b',
  // ground-state carries TWO bundled-only frontmatter lines after the merge of
  // the read-only-skill feature (PR #5) and the 2026-06 load-by-default flip
  // (PR #7): `read-only: true` (forked child gets the RECON tool allowlist +
  // mutating-bash guard) AND `context: fork` (pins it to forking so the recon
  // wave keeps dispatching). Both lines are allowlisted in
  // INTENTIONAL_DIFFS['ground-state'] below so the normalized-drift test passes.
  'ground-state':
    'a9d6da1956a60dd4362eecb26321998b0e512db40d571671e9b4427bfb8e5d6e',
  // intent-lock is bundled-only (no upstream counterpart).
  // Hash bumps need no parallel PR — document the change in the
  // commit message instead.
  'intent-lock':
    'a0844035c011205eaab9b61e793c4dbe32a48eea0f84ae9fa7b7b4a59e801066',
  // parallelize: bundled-only `context: load` added — see the gather note above.
  parallelize:
    'be8b2a301fe35d86d96d4be6f8418bf497dd9050767a3837cf057d7d5a1cd719',
  // refactor is bundled-only (no upstream example-plugin counterpart); verbatim
  // copy of the user-scope /refactor at ~/.afk/skills/.
  // Hash bumped (#611): the contract-extractor's `test_commands` example was
  // changed from the pnpm footgun form `pnpm test -- --grep "AuthService"` (under
  // pnpm 10 the `--` drops the arg and runs the FULL suite) to scoped forms
  // (`pnpm test <file>` / `pnpm test -t "AuthService"`) plus a note to never emit
  // the `--` form. Bundled-only — mirror into the user-scope /refactor at
  // ~/.afk/skills/ if it drifts back.
  refactor: '3adf801b9a61eba80afd34fef1e8c78a892ec07256dabb073370622a62d1b40f',
  research: 'abe79d75a5f3c74696ef002293dbe8714e446f8955de97089d1005f1e70bc269',
  review: 'f313e3779af068a623692473abab2300938db8da3ebf3e2998d47fcb21ee9627',
  // Hash bumped 2026-06-09 (PR #52): records the confidence-trigger enhancement
  // landed in this branch's commit 1e35850 — adds high-confidence language
  // ("confident", "certain", "clearly", ≥80%) as a verification trigger in its
  // own right, a three-way CONFIRMED/REFUTED/UNVERIFIABLE verdict with
  // [was: …]/[needs-human-review] annotations, and a bounded 3-round retry loop.
  // The behavior change is intentional; this records the new content.
  // Hash re-bumped during PR #52 review: the frontmatter description used YAML
  // escape sequences that parseSkillMetadata (tool-injector.ts) renders
  // literally — replaced with a literal ≥ and unquoted terms so the
  // model-facing description is clean.
  // Hash re-bumped during PR #187 review: the Merge section now enumerates the
  // new UNVERIFIED-COMPOSITION / UNVERIFIED-ECHO-CHAMBER verdict states — prose-
  // consistency fix only; no behavior change to the composition-axis guard.
  // Hash re-bumped: ported the private-plugin refinements — the Merge section
  // now frames UNVERIFIED-COMPOSITION / UNVERIFIED-ECHO-CHAMBER as produced by
  // the Composition-axis guard (not individual verifiers) with the specific
  // tags [needs-human-review: composition boundary unchecked] / [echo-chamber
  // suspected]; the guard gains the REFUTED-exemption parenthetical (a refuted
  // claim already halts action, so its boundary-blindness is safe) and the
  // echo-chamber loop-cap escalation (UNVERIFIED-ECHO-CHAMBER [loop-cap-reached]
  // when the 3-round cap is exhausted). Bundled frontmatter/description
  // preserved verbatim (kept the literal-quote description, NOT the reference's
  // escaped-quote form).
  'shadow-verify':
    '01bddcdd5446943f6fe4694a2cdbb669ab194dc0765d3630899755bc65530b9a',
  // Hash bumped 2026-06: Phase 4 (commit) + Phase 8 (PR) switched from the
  // `--body "$(cat <<'EOF' … EOF)"` heredoc-in-command-substitution antipattern
  // to the file-based form (`git commit -F` / `gh pr create --body-file`). The
  // heredoc tripped whenever a commit/PR body contained backticks, `$(`, or
  // quotes (markdown bodies almost always do) — the shell parsed them before
  // git/gh ran, failing the call or recording a mangled/truncated body. The
  // file-based form matches the safe convention already used in src/agent/gh.ts.
  // BACK-PORT GAP: the same fix should land in the upstream example-plugin /ship
  // skill (drift test is skipped here — example-plugin not co-located).
  ship: 'e778f20e30cb24edd04e2fa25b939c21db2b49b95ad0e0076be0e49dae8a34a3',
  // simplify is bundled-only (no upstream example-plugin counterpart).
  simplify:
    'ce720df16e81eff5e6022db38067d376f2177e08a9783fc377e04cf520c7bf3c',
  spec: '167e7cbb84de5b716efa11bb9f20a6e4b940f6f9a6d1812a7fbd735dae4f67dd',
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
  automate: 'example-plugin/plugins/framework/skills/automate/SKILL.md',
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
    // Bundled-only agent-afk execution-mode field. LOAD (not fork): the current
    // agent orchestrates the critic wave and the advisory recommendation feeds
    // ITS OWN decision (structurally identical to /parallelize). The critics +
    // synthesizer stay independent as dispatched sub-agents either way, so fork
    // adds an orchestration layer without adding independence. (Moved fork→load
    // by user review, 2026-06.) Claude Code skills are natively inline → no
    // upstream counterpart. See docs/skill-load-mode.md.
    /^context: load$/,
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
    // Bundled-only `context: fork` pin — independence of the verifier wave
    // requires an isolated context, so it must keep forking after the
    // load-by-default flip. See devils-advocate note.
    /^context: fork$/,
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
    // Bundled-only `context: fork` pin — research fans out parallel
    // context-gathering sub-agents and must keep that work in an isolated
    // context after the load-by-default flip. See devils-advocate note.
    /^context: fork$/,
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
    // Bundled-only `context: fork` pin — /ship is a heavy multi-phase release
    // orchestrator kept in an isolated context after the load-by-default flip.
    // See devils-advocate note.
    /^context: fork$/,
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
    // Bundled-only `context: fork` pin — review dispatches parallel dimension
    // agents and must keep that work isolated after the load-by-default flip.
    // (Already carried `context: fork` before the flip; allowlisted here for
    // the co-located drift comparison.) See devils-advocate note.
    /^context: fork$/,
    // argument-hint divergence — bundled-only `--post {github,telegram}` flag.
    // `/review --post` is an agent-afk dispatch-layer publishing feature (PR #35,
    // 7830a0f) handled in src/cli/slash/plugin-skills.ts; the upstream
    // example-plugin review skill has NO --post publisher, so its argument-hint
    // omits the flag. Anchored on the stable line prefix so it removes the
    // argument-hint line from BOTH sides (bundled w/ --post, upstream w/o),
    // leaving the rest of the line guarded. No upstream back-port applies —
    // the feature does not exist there. (bundled.test.ts workflow option 4.)
    /^argument-hint: "\[diff\|pr-url\|pr-number/,
  ],

  // ground-state — TWO bundled-only frontmatter lines, both allowlisted:
  //   1. `read-only: true` (read-only-skill feature): the marker the agent-afk
  //      runtime keys on to give ground-state's forked reconnaissance subagent a
  //      restricted RECON tool allowlist (no write_file/edit_file) plus a
  //      mutating-bash guard — enforcing the "never edits files" constraint that
  //      was previously prose-only (the subagent had FULL write tools and was
  //      observed making 22 edit_file + 27 bash calls in one session).
  //   2. `context: fork` (2026-06 load-by-default flip): pins ground-state to
  //      forking so its recon wave keeps dispatching.
  //   The upstream ground-state SKILL.md has neither layer yet, so both lines are
  //   bundled-only. When upstream adopts either, mirror the frontmatter there and
  //   drop the matching pattern. Flagged for cross-repo reconciliation.
  'ground-state': [/^read-only: true$/, /^context: fork$/],
  spec: [/^context: fork$/],

  // ground-claim: bundled-only `context: load` field. Unlike the fork-pinned
  // skills, ground-claim dispatches NO sub-agents — it is a pre-answer guard
  // that must run in the caller's context to see the reasoning it grounds
  // (a forked guard cannot inspect the parent's accumulated context). A
  // /devils-advocate review (2026-06) flagged the original fork pin as a
  // semantic error and moved it to load. Claude Code skills are natively
  // inline → no upstream counterpart. See docs/skill-load-mode.md.
  'ground-claim': [/^context: load$/],
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
      (s) =>
        s !== 'intent-lock' &&
        s !== 'simplify' &&
        s !== 'refactor' &&
        s !== 'diagnose',
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
