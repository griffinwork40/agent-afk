import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Contract: pinned hashes for the bundled skills shipped under awa-bundled/.
// Some of these files also exist in a separate upstream plugin repo, but they
// are NOT byte-equal to it and byte-equality is a false invariant: namespace
// prefixes differ (upstream plugin-namespaced form → bare `/skill` here),
// sub-agent dispatch identifiers differ, and wording diverges between
// maintainers. So the only guard here is the pinned-hash snapshot: any
// unauthored edit to a bundled SKILL.md fails the test until the developer
// explicitly bumps the hash below.
//
// That bump is also the forcing function for cross-repo discipline, since no
// automated check compares the copies:
//
//   *** Workflow when bumping a pinned hash ***
//   1. Identify what changed in the bundled SKILL.md.
//   2. Check whether the same change applies to an upstream copy, if one exists.
//   3. If yes → open a parallel PR upstream. Land both before either
//      is released.
//   4. If no → document why the change is bundled-only in the PR description.
//   5. Only then update the hash below.
//
// This convention exists because in November 2026 a critical /ship guardrail
// (the "Branch lock" + "Never push to main" Hard Rules in commit 63f3ed3) was
// added to the bundled mirror but never back-ported upstream. The deployed
// plugin therefore lacked the guardrail until the next sync. This test cannot
// prevent that on its own — but the hash-bump moment forces the developer to
// look at both copies.
const PINNED_HASHES = {
  // automate: afk-native scheduled-run skill (create_schedule + send_telegram +
  // `afk service install daemon`). Vendored byte-equal from the upstream
  // framework plugin at the time it was bundled.
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
  // (context: load preserved). Bundled-only body; nothing to back-port.
  'devils-advocate':
    'ae6f17e553e865d7bfb734bed455d89f4cbbcdd6304ef6a8f8a38679a441600e',
  // diagnose is bundled-only (no upstream counterpart). It ships
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
  // divergence. See docs/skill-load-mode.md.
  gather: '26ef18dde7db7c313655b0fe3097f14966763298ff5a2fe643ccf18d0f6b29c0',
  'ground-claim':
    'e3ceabc8d6b9b19526eb30441c17e763b56cb779d7549f54b45835b06a90fb8b',
  // ground-state carries TWO bundled-only frontmatter lines after the merge of
  // the read-only-skill feature (PR #5) and the 2026-06 load-by-default flip
  // (PR #7): `read-only: true` (forked child gets the RECON tool allowlist +
  // mutating-bash guard) AND `context: fork` (pins it to forking so the recon
  // wave keeps dispatching). The upstream ground-state has neither layer, so
  // both lines are permanent bundled-only divergence.
  'ground-state':
    'b04da3abfa4f79d4599928f62896143b88fb9751f0d0d26ca0eb27134f9ba17a',
  // intent-lock is bundled-only (no upstream counterpart).
  // Hash bumps need no parallel PR — document the change in the
  // commit message instead.
  'intent-lock':
    'ecb4477a40c5f7a64b79779e01a6186f834dd3d4dc59c13a5c4e4b12191cf13b',
  // parallelize: bundled-only `context: load` added — see the gather note above.
  parallelize:
    'be8b2a301fe35d86d96d4be6f8418bf497dd9050767a3837cf057d7d5a1cd719',
  // refactor is bundled-only (no upstream counterpart); verbatim
  // copy of the user-scope /refactor at ~/.afk/skills/.
  // Hash bumped (#611): the contract-extractor's `test_commands` example was
  // changed from the pnpm footgun form `pnpm test -- --grep "AuthService"` (under
  // pnpm 10 the `--` drops the arg and runs the FULL suite) to scoped forms
  // (`pnpm test <file>` / `pnpm test -t "AuthService"`) plus a note to never emit
  // the `--` form. Bundled-only — mirror into the user-scope /refactor at
  // ~/.afk/skills/ if it drifts back.
  refactor: '3adf801b9a61eba80afd34fef1e8c78a892ec07256dabb073370622a62d1b40f',
  research: 'abe79d75a5f3c74696ef002293dbe8714e446f8955de97089d1005f1e70bc269',
  // History: /review Wave 1 no longer mandates a `git show` re-read (#726,
  // #777); severity and disposition split into separate axes with an explicit
  // `blocking` field, never-overridable security/data-integrity mediums, and a
  // pre-downgrade assignment-order invariant (#937). Review of #936 then
  // widened that invariant to every downgrade path (not just the two it
  // named), exempted a downgrade-preserved `blocking: true` from the low/nit
  // external-constraint rule it contradicted, and put the merge-decision rule
  // in Wave 2's receives list.
  // Full rationale: docs/bundled-plugins.md#review-726
  review: 'c457514e7576427dfe327dbdca347909f5ed34b321b9185c9f51663acac99295',
  // History: /shadow-verify gained the confidence-trigger + composition-axis
  // verdicts (#52, #187).
  // Full rationale: docs/bundled-plugins.md#shadow-verify-52
  'shadow-verify':
    '663fe29a42b7825416a39f4077192f5bc49bcd6802a565d2f02dc5ff751e829a',
  // Hash bumped 2026-06: Phase 4 (commit) + Phase 8 (PR) switched from the
  // `--body "$(cat <<'EOF' … EOF)"` heredoc-in-command-substitution antipattern
  // to the file-based form (`git commit -F` / `gh pr create --body-file`). The
  // heredoc tripped whenever a commit/PR body contained backticks, `$(`, or
  // quotes (markdown bodies almost always do) — the shell parsed them before
  // git/gh ran, failing the call or recording a mangled/truncated body. The
  // file-based form matches the safe convention already used in src/agent/gh.ts.
  // BACK-PORT GAP: the same fix should still land in the upstream /ship skill.
  ship: '4b082cdcbfe51453a20edd03231b473812775a7cc452b661bb786ff9735f0066',
  // simplify is bundled-only (no upstream counterpart).
  simplify:
    'ce720df16e81eff5e6022db38067d376f2177e08a9783fc377e04cf520c7bf3c',
  spec: '167e7cbb84de5b716efa11bb9f20a6e4b940f6f9a6d1812a7fbd735dae4f67dd',
} as const;

type SkillName = keyof typeof PINNED_HASHES;

const SKILLS = Object.keys(PINNED_HASHES) as SkillName[];

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

    it('intent-lock preserves all signal classes and reconstructed-goal lock', () => {
      const content = readBundled('intent-lock');
      for (const heading of [
        '**Ambiguous referents**',
        '**Unverified characterizations**',
        '**Identity assumptions**',
        '**Code-vs-runtime dual referent**',
        '**No task statement at all**',
      ]) {
        expect(content).toContain(heading);
      }
      expect(content).toContain('**Lock format (reconstructed goal):**');
      expect(content).toContain(
        '> Reading [fragment] as: [reconstructed task statement] (from [evidence]).',
      );
    });

    // Invariant: #726 — Wave 1 of /review dispatches `research-agent`, which has
    // no Bash. Any mandate to run a git command inside the Wave 1 section forces
    // each agent to nest a `git-investigator` just to run it, silently doubling a
    // declared 2-agent wave into 4+ sessions and cascading into 429s.
    //
    // This cannot be written as "the Wave 1 section contains no `git ...`": the
    // Invariant block legitimately QUOTES `git show` to explain what must not be
    // mandated, and Wave 1.5 / target-resolution run in the orchestrator where git
    // is correct. So assert the guard clauses are PRESENT — reintroducing the
    // mandate means deleting them, which this catches.
    it('review Wave 1 keeps the no-git citation contract (#726)', () => {
      const content = readBundled('review');
      const start = content.indexOf('**Wave 1 — Full review');
      const end = content.indexOf('**Wave 1.5 —');
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);

      const waveOne = content.slice(start, end);
      expect(waveOne).toContain('do **not** run git');
      expect(waveOne).toContain('**Invariant — why Wave 1 does not run git.**');
      expect(content).toContain('**Concurrency floor —');
      // Wave 1.5 stays inline in the orchestrator, never a fourth sub-agent.
      expect(content).toContain(
        '**Wave 1.5 — Citation + absence-claim verification (INLINE',
      );
    });

    // Invariant: severity and disposition are separate axes (#937). The two
    // never-overridable medium classes and the pre-downgrade assignment order
    // are the whole point of the split — a later edit that drops either one
    // reopens the bypass it closed, and the file hash alone cannot say which
    // clause went missing.
    it('review keeps the severity/disposition split (#937)', () => {
      const content = readBundled('review');

      // Disposition is an explicit per-finding field, not a tier threshold.
      expect(content).toContain('**Wave 1 assigns** an explicit `blocking: true|false`');
      expect(content).toContain(
        'Emit **DO NOT MERGE** when one or more findings carry `blocking: true`',
      );

      // Neither never-overridable medium class may be waived.
      expect(content).toContain(
        'A `medium` in the `security` dimension is **never** overridable to `false`',
      );
      expect(content).toContain(
        'material data-integrity risk or a likely production failure under normal usage is **never** overridable to `false`',
      );

      // A downgrade lowers severity, never disposition — otherwise the two
      // clauses above are bypassable without invoking an override at all.
      expect(content).toContain('**Invariant — assignment order.**');
      expect(content).toContain('assigned from the **pre-downgrade** severity');
      expect(content).toContain(
        'keeps the `blocking` value its pre-downgrade severity earned',
      );

      // An overridden disposition gets an independent reader.
      expect(content).toContain('whose `blocking` value departs from the default table');

      // The invariant covers EVERY downgrade path, not just the two it
      // originally named — the reachability rule drops two tiers in one step.
      expect(content).toContain('downgraded by **any** downgrade rule in this file');
      expect(content).toContain('two tiers in one step');

      // A downgrade-preserved `blocking: true` is not an override, so it is
      // exempt from the low/nit external-constraint rule it would otherwise
      // contradict.
      expect(content).toContain('is **not** an override and needs no justification clause');
      expect(content).toContain('· blocking preserved from pre-downgrade <severity>');

      // Wave 2 emits the verdict, so its receives list carries the rule.
      expect(content).toContain('**the merge-decision rule and its counts format below**');
    });
  });
});
