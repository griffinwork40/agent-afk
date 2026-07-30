# Impact map — deleting the `src/skills/_agents/` TS-wrapper layer

Pre-change blast-radius analysis for **ADR 0002 decision item 2**
([`0002-readonly-agent-type-consolidation.md:268-273`](../decisions/0002-readonly-agent-type-consolidation.md)),
which is recorded as *"NOT implemented — moderate blast radius (`audit-fit` builds
its gate from `researchAgent.allowedTools`); wants an `/impact-map` pass first."*
This is that pass.

- **Date:** 2026-07-29
- **Target ref:** `a25984a` (`main`, and worktree `afk/20260729-192445-c98153`)
- **Method:** `/impact-map` — four parallel read-only `research-agent` lanes
  (static importers / transitive reach / test+build+config / equivalence
  feasibility), then inline synthesis with direct maintainer verification of
  every load-bearing claim.
- **Mutation:** none. This document is the only artifact produced.

### Addendum, 2026-07-29 — `audit-fit` deprioritized by the maintainer

After the first pass, the maintainer noted `audit-fit` is *"not a super big
concern … not used often yet."* Local telemetry is stronger than that:
`~/.afk/agent-framework/audit-fit-telemetry.jsonl` contains **exactly one
record**, dated `2026-05-03T01:07:55.313Z`, reporting
`total_artifacts: 1, misfits_count: 0, briefs_written: 0`. The skill does not
appear in the top 25 of `skill-invocations.jsonl`. **One lifetime invocation,
~12 weeks stale, which found nothing.**

Three consequences, folded into the sections below:

1. **Stages 1 and 2 merge into one PR** — the split existed only to isolate
   `audit-fit`'s permission surface, which is not worth isolating at n=1. F4
   therefore *does* pay out in a single change (see C1).
2. **The raw-vs-stripped prompt delta downgrades** from a gated decision to
   "just fix it."
3. **Nothing else moves.** The tier stays HIGH (recomputed ≈20, still 15–39)
   and the hardest blocker is untouched — both are properties of `builtins.ts`,
   the publish bundle, and the eight prompt-level consumers, none of which
   involve `audit-fit`.

This sharpens the meta-finding: ADR 0002 deferred item 2 citing `audit-fit` as
its *"moderate blast radius."* That was the **weakest** item in this entire map.
The reasons item 2 actually warrants care — the `build:dist` bundle-orphan risk
(C3), the eight bare-name `SKILL.md` consumers, and the reversed documented
decision (C2) — are all ones the ADR never named. Item 2 was deferred for
substantially the wrong reason.

---

## Verdict

> **The refactor as literally specified is BLOCKED. A narrowed form is
> technically SAFE but NOT WORTH IMPLEMENTING. Take the one real benefit via a
> separate, much smaller change (Stage 2′).**

The verdict moved twice as evidence came in, so the final position is stated
first and the derivation follows: the wrapper layer is **smaller and more
load-bearing** than ADR 0002 assumes. Deleting it relocates the duplication
rather than removing it (C3), reverses three documented decisions (C1, C2, C4),
and trades a typed dependency for an invisible coupling to a build-script regex.
Its one genuine benefit — F4, `KNOWN_AFK_TOOL_NAMES` 3 → 2 — is separable and
achievable without touching the wrappers at all.

The distinction is the whole finding, so it is stated precisely:

ADR item 2 says construct the builtins *"from the byte-pinned markdown
frontmatter through the generic `parseAgentMarkdown` + `resolveAgentToolAccess`
pipeline."* Read strictly — frontmatter as the **sole** source — it is blocked.
The pinned frontmatter carries exactly three keys (`name`, `description`,
`tools`; [`research-agent.md:2-4`](../../src/skills/_agents/prompts/research-agent.md),
[`git-investigator.md:2-4`](../../src/skills/_agents/prompts/git-investigator.md)),
while today's definitions carry three more, and the SHA-256 byte-pin the ADR
explicitly says to keep (line 293) forbids adding them.

But **two of those three fields already live in `builtins.ts` as literals, not
in the wrapper** — so they do not need frontmatter at all. They simply stay put.
Only `model` genuinely originates in the wrapper, and it can become a literal
alongside them.

| Field | Today's producer | Under a frontmatter-only rewrite |
|---|---|---|
| `name` | wrapper → `builtins.ts:102,128` | **REPRODUCIBLE** — byte-identical to frontmatter `name:` |
| `description` | wrapper → `builtins.ts:105,131` | **REPRODUCIBLE** — byte-identical to frontmatter `description:` |
| `prompt` | `vendoredPromptBody()` → `builtins.ts:106,132` | **ALREADY IS** `parseAgentMarkdown(raw)?.definition.prompt` (`builtins.ts:36`) |
| `tools` | wrapper `allowedTools` + literal append (`builtins.ts:119,133`) | **REPRODUCIBLE** — see the `Agent(...)` note below |
| `source: 'builtin'` | literal (`builtins.ts:103,129`) | **DERIVABLE** — construction-site literal |
| `model: 'sonnet'` | wrapper (`git-investigator.ts:15`) | **needs a literal** — absent from frontmatter |
| `maxToolUseIterations: 50` | **already a `builtins.ts` literal** (`:71,124,141`) | **stays** — never was wrapper-sourced |
| `bashReadOnly: true` | **already a `builtins.ts` literal** (`:146`) | **stays** — never was wrapper-sourced |
| `sourcePath` | wrapper (`research-agent.ts:11`) | **LOST, harmless** — not on `RegisteredAgent` (`types.ts:41-42`); test-only |

`bashReadOnly` deserves emphasis because losing it would be a silent security
regression, not a cosmetic one: it is the mechanical read-only-bash gate on the
**only** Bash-granted builtin, and its enforcement chain is
`parser.ts:188` → `registry.ts:216` → `resolve.ts:212` → `child-config.ts:190`.
It is safe here **only because it is already a `builtins.ts` literal.** Any
implementation that tries to round-trip it through frontmatter hits the pin and
must stop.

### Blast radius: **HIGH** (score 27.5)

```
direct      4 sites × 3   = 12.0
transitive 11 files × 1   = 11.0
test        7 files × 0.5 =  3.5
build/config 2 files × 0.5 =  1.0
                    total = 27.5   → HIGH (15–39)
```

Plus **8 bundled `SKILL.md` files** that dispatch `research-agent` by bare name
— prompt-level consumers outside the score formula that no TypeScript grep
would surface. Per the skill's gate, HIGH ⇒ `NARROW_SCOPE`, which is what the
staged sequence below does.

---

## Corrections to ADR 0002

Three of these contradict the ADR's own prose. Per that document's standing
instruction to distrust its uncited claims (it already retracted F6 and F8 as
measurement errors), the code wins.

### C1 — As the ADR scopes it, item 2 does **not** dissolve F4. Copies go 3 → 3.

The ADR justifies item 2 as *"Dissolves F4 instead of violating it"* (line 271).
It does not, as scoped. All three copies verified:

1. [`to-definition.ts:14-20`](../../src/skills/_agents/to-definition.ts)
2. [`resolve.ts:43-49`](../../src/agent/agents/resolve.ts)
3. `tool-injector.ts:393` (inside `resolveKnownToolNames`)

`vendoredToolAllowlist` is **live** — `audit-fit/index.ts:27,368` and
`audit-fit.test.ts:40,392` — so `to-definition.ts` cannot be deleted wholesale,
and its copy **relocates** rather than disappears. It drops to 2 only if
`audit-fit` also migrates to `resolveAgentToolAccess`, which the ADR does not
scope. A fourth structurally identical expression exists at `nesting.ts:90`.

The `// Invariant:` comment the ADR cites is real and says the duplication is
deliberate ([`resolve.ts:39-42`](../../src/agent/agents/resolve.ts)):

> `// Invariant: mirrors KNOWN_AFK_TOOL_NAMES in skills/_agents/to-definition.ts —`
> `// the known-tool universe a child permission gate can actually receive.`
> `// Duplicated (5 lines) rather than imported to keep the layering direction`
> `// src/agent → src/skills one-way-free for this module.`

**Consequence:** the F4 benefit is real but does not come from deleting the
wrappers — it comes from migrating `audit-fit`.

**Revised per the addendum:** since `audit-fit` is effectively unused (one
lifetime run), that migration no longer needs its own PR or its own impact-map.
Fold it into the single change and F4 *does* drop 3 → 2, making the ADR's stated
justification true — just not for the reason the ADR gives. The benefit is
contingent on touching `audit-fit`, which the ADR's scoping explicitly excluded.

### C2 — Item 2 reverses a deliberate, documented decision the ADR never mentions.

[`builtins.ts:27-37`](../../src/agent/agents/builtins.ts) states the opposite
policy explicitly:

> *"Tools/description stay sourced from the wrapper constants (the vendored
> contract diagnose already relies on), **NOT from the file's frontmatter**."*

This is not fatal — the values are byte-identical today, so the reversal is
currently a no-op — but it is a documented intent with a named dependant, and
the ADR treats the wrapper layer as accidental scaffolding rather than as a
choice. Whoever implements this must retire that comment deliberately, not
silently.

### C3 — The two build scripts are absent from the ADR, and one carries the only genuine new risk.

- [`scripts/update-hash-pins.ts`](../../scripts/update-hash-pins.ts) —
  **SURVIVES.** It never parses the wrapper `.ts` files; it reads only the three
  prompt `.md` paths (`:46,50-52`) and `vendored.test.ts` (`:48`). Deleting the
  five wrappers has zero effect. It does hardcode both paths, so *moving* the
  prompts dir would break it (`readFileSync` throws at `:151`).
- [`scripts/esbuild-plugin-inline-prompts.mjs`](../../scripts/esbuild-plugin-inline-prompts.mjs) —
  **`pnpm build:dist` still passes, but Pattern A becomes dead code, and this is
  the real constraint on the implementation.** Pattern A (`:172-224`) exists
  specifically to rewrite the wrappers' `readFileSync(join(__dirname,
  '<literal>.md'), 'utf8')` shape (`:112`), and those three wrappers are the only
  production files using it. Pattern B (`buildPromptTable`, `:57-88`) skips
  `_`-prefixed directories (`:62`), so `_agents/prompts/` **never** enters the
  lookup table.

  **Therefore:** after the wrappers are deleted, the surviving
  `_agents/prompts/*.md` are **bundle-orphaned** under `build:dist` — nothing
  inlines them, and the runtime `readFileSync` that used to reach them is gone.

  **And the constraint is sharper than "keep the same shape" — it is
  parameterization-sensitivity.** `tryResolveReadFileSyncPath` (`:110-129`)
  requires every argument after `__dirname`/`here` to be a **string literal**:
  each part must match `^['"](.+)['"]$`, and the transform is skipped unless
  `parts.every(p => p !== null)` (`:120`). Whitespace and newlines are tolerated
  (`\s*` throughout `:112`), so formatting is safe — but a variable, a constant,
  or a template literal is not.

  This is a trap, because the natural shape of "construct both builtins from
  markdown" is a parameterized helper:

  ```ts
  // Looks obviously correct. Silently breaks the published bundle.
  const loadVendored = (name: string) =>
    readFileSync(join(__dirname, '../../skills/_agents/prompts', `${name}.md`), 'utf8');
  ```

  That yields a `null` part, no match, no inlining, and a published artifact
  that reads a file which was never shipped. To keep Pattern A working, the
  replacement must hardcode **one literal read per agent** — which is
  structurally what the wrapper files already are.

  **Consequence for the whole refactor:** Stage 1 does not eliminate the
  per-agent duplication, it *relocates* it into `builtins.ts` in a form that
  must stay hardcoded-per-agent to keep the bundler working. The wrapper layer
  is not purely redundant scaffolding — it is, in part, the stable home for a
  bundler-coupled literal read. `pnpm build` (non-dist) is unaffected —
  `copy-prompts.js:17-32` copies all `src` `.md` unconditionally — so **this
  failure is invisible to the default build and would only surface in the
  published npm artifact.**

### C4 — Item 2 reverses commit `a34216f` (#625), which is 2 weeks old

Verified against the live upstream 2026-07-29 (see "Upstream verification"
below). On 2026-07-15, [`a34216f`](https://github.com/griffinwork40/agent-afk/commit/a34216f)
*"chore(agents): remove inert `model:` frontmatter from vendored agent prompts"*
**deleted `model: sonnet` from both prompts**, with this rationale:

> *"This frontmatter is inert for routing: the prompt body is consumed via
> `vendoredPromptBody()` (which strips YAML frontmatter) and the bundled agents'
> registered definitions in `src/agent/agents/builtins.ts` do not read
> frontmatter `model` … The line implied a model pin that has no effect."*

That change is only correct **because** `builtins.ts` sources from the wrapper
constants. Item 2 inverts that premise: under a frontmatter-sourced
construction, `model:` stops being inert and must be re-added — reversing a
two-week-old decision, and now as a **coordinated two-repo change plus a
re-pin**, since the prompts are byte-shared with `griffinwork40/awa-private`.

**Pattern worth naming.** This is the *third* documented decision item 2
reverses (C1's `// Invariant:`, C2's `builtins.ts:27-37` docstring, and now
#625). All three moved deliberately **away** from frontmatter-sourcing for these
agents. ADR 0002 acknowledges none of them. That does not make item 2 wrong —
the wrapper duplication is real — but it means item 2 is a reversal of a
sustained direction, not the cleanup of an accident, and should be argued as
such.

---

## Upstream verification (2026-07-29)

The byte-pin's upstream was checked directly, closing the equivalence lane's
explicit gap (*"did not check whether upstream sources for these `.md` files
carry `model`/`bash` keys"*).

**Topology.** The marketplace is `griffinwork40/awa-private` (PRIVATE), cached
locally at `~/.afk/plugins/cache/agent-framework-private/` — the directory name
is a local alias, the git remote is `awa-private`. It ships two plugins:
`awa-private` (`agents/research-agent.md`, `agents/git-investigator.md`) and
`awa-dev` (`agents/qualify.md`). Cache HEAD `ce27e45`.

| check | result |
|---|---|
| `research-agent.md` vendored vs upstream | **IDENTICAL** — `80993a5f28dbcc9f…` |
| `git-investigator.md` vendored vs upstream | **IDENTICAL** — `d1f186b82574641a…` |
| `contract.md` upstream counterpart | **NONE** — pin is self-referential |
| upstream frontmatter keys | exactly `name`, `description`, `tools` |
| upstream ships `model:` or `bash:` | **NO** — neither key, in either agent |

Three consequences:

1. **ADR falsifier 1 is NOT triggered.** Upstream still ships both agents and
   the hashes match, so the pin is a live sync guard against real divergence,
   not a self-referential tax. The ADR's *"keep the SHA-256 byte-pin"* stands on
   verified ground.
2. **The ADR's `contract.md` parenthetical is confirmed** — no upstream
   counterpart, so that one pin genuinely is self-referential.
3. **Stage 1's `builtins.ts` literals are required, not merely preferred.** The
   frontmatter-only construction has no upstream path today, and per C4 the
   obvious workaround (add the keys upstream, re-pin) reverses #625.

---

## Consumer map

### DIRECT (code dependency, non-test) — 2 files, 4 import sites

| file:line | symbol | properties read |
|---|---|---|
| `builtins.ts:20-21` | `researchAgent`, `gitInvestigator` | `.name` (`:102,128`), `.description` (`:105,131`), `.systemPrompt` (`:106,132`, via `vendoredPromptBody`), `.allowedTools` (`:119,133`), `.model` (`:134`) |
| `audit-fit/index.ts:26-27` | `researchAgent`, `vendoredToolAllowlist` | `vendoredToolAllowlist(researchAgent.allowedTools)` (`:368`); `researchAgent.systemPrompt` **raw** (`:415`) |

Comment-only, no code dependency: `resolve.ts:39`, `builtins.ts:9,69`,
`bundled.test.ts:154`. **Zero** production consumers of `contract` or of the
barrel `_agents/index.ts` — nothing in `src/` imports the barrel at all.

### TRANSITIVE — 11 non-test files, no overflow

`builtinAgents()` (`builtins.ts:99`, fresh map per call) → `registry.ts:243-244`
(seeded at the **bottom** of precedence) → four bootstrap surfaces:
`telegram.ts:309`, `bootstrap.ts:344`, `daemon.ts:125`, `chat.ts:506` → threaded
as `ctx.agentRegistry` (`subagent-executor.ts:204`).

Resolution at dispatch is a plain `Map.get` — `subagent-executor.ts:425` — and
an unresolved `agent_type` is a **hard error** at `:426-434`, confirming ADR F2.

Hubs: `agents/index.ts` (8 importers), `subagent-executor.ts` (21),
`skill-bridge.ts` (17).

**Shape-change observers** — five read sites, so a change to definition *shape*
(not values) is visible on every dispatch path: `child-config.ts:160` (`model`),
`:222` (`maxTurns`), `:233` (`maxToolUseIterations`), `:276` (`prompt`);
`tool-def.ts:35` (`description` → the **model-visible** `agent` tool schema);
`registry.ts:145-148` (`bashReadOnly`, `tools`).

### PROMPT-LEVEL — 8 `SKILL.md` files (invisible to type checking)

`review` (×4), `devils-advocate` (×3), `refactor` (×2), `research` (×2),
`shadow-verify`, `ship`, `simplify`, `diagnose` — all dispatch `research-agent`
by bare name.

**Notable:** **zero** bundled `SKILL.md` dispatches `git-investigator` by name.
It is reached only via the nested `Agent(git-investigator)` grant
(`builtins.ts:119`, gated `subagent-executor.ts:447-464`). This also bears on
ADR **item 1** (the collapse): `git-investigator` has no prompt-level consumer
surface to migrate.

### TEST — 7 files

`vendored.test.ts` is the concentration of risk: it pins the three prompt
hashes at `:12-16` (tests `:35-51`, **no wrapper dependency**), but **17 of 20
`it()` blocks** import `./index.js` and assert on the wrapper objects
(`:55-90`, `:100-128`, `:138-182`). *"Keep the byte-pin"* **is** compatible with
deleting the wrappers — the file reduces to the byte-equal snapshot block.

Value-pinned assertions needing rewrite: `researchAgent.allowedTools` ==
5-element array (`:95`), `gitInvestigator.allowedTools` == 4-element (`:133`),
`.name` (`:143,177`), `.sourcePath` (`:162,169,186`), and
`audit-fit.test.ts:392-413`.

### CONFIG / CI — none

`package.json`, `tsconfig*`, `vitest.config.ts`, `.github/workflows/*` contain
no reference; everything is glob-based (`include: ["src/**/*"]`). Two adjacent
hygiene findings, both independent of this refactor:

- **No CI job runs `fix:pins:check`** — the scripts exist
  (`package.json:58-59`) but no workflow invokes them, so the byte-pin is
  developer-invoked only. Worth its own issue.
- Coverage floors (`vitest.config.ts:53-58`) are set ~1pt below current and may
  shift when wrapper lines leave the coverage set; CI runs `test:coverage`
  (`ci.yml:121`).

### Safe zones (zero reference)

`src/browser`, `src/cli` (except the depth-2 bootstrap hops), `src/config`,
`src/improve`, `src/insights`, `src/service`, `src/telegram` (except `:55,309`),
`src/utils`, `src/web`, `src/__test-utils__`, plus `tests/`, `themes/`,
`prompts/`, `assets/`, `.github/`. Within `src/agent`, only
`agents/{builtins,resolve}.ts`; within `src/skills`, only `audit-fit/index.ts`.

---

## Verified non-issue: no permission widening in `audit-fit`

The wrapper's `allowedTools` is a deliberate **5-tool read-only base** that
omits `Agent(git-investigator)` (`research-agent.ts:12-18`), while the pinned
frontmatter's `tools:` includes it — 6 entries. `builtins.ts:119` reconstructs
the 6 by appending. So the two sources differ, and `audit-fit` reads the
5-entry base to build an inspector gate: sourcing `tools` from frontmatter
instead *looks* like it would widen that gate.

It does not. `normalizeToolToken` (`tool-injector.ts:107-123`) resolves a token
by exact match against the known-name set, then by a case-insensitive lookup in
`LEGACY_TOOL_ALIASES` (`:81-93`, 11 keys: `read`, `edit`, `write`, `bash`,
`grep`, `glob`, `ls`, `list`, `webfetch`, `websearch`, `webbrowse`). The token
`Agent(git-investigator)` carries its parenthetical scope, so it cannot
exact-match the bare `agent` entry in the set (`to-definition.ts:18`), and no
alias key contains `agent`. It returns `undefined` and is **dropped**
fail-closed, exactly as `to-definition.ts:30-31` documents.

Both sources therefore normalize to the identical
`{read_file, grep, glob, web_scrape}`, and `audit-fit.test.ts:392-404` holds
unchanged. Verified directly rather than inferred, because it is the one place
this refactor could silently widen a permission gate.

---

## One real behavioural delta

`audit-fit/index.ts:415` interpolates `researchAgent.systemPrompt` **raw —
frontmatter block included** — into its inspector system prompt, whereas
`builtins.ts:106` strips it via `vendoredPromptBody`. Centralizing on parsed
output silently removes that frontmatter from `audit-fit`'s inspector prompt.

Almost certainly an improvement (frontmatter in a system prompt is noise).

**Downgraded per the addendum.** The original recommendation — "an explicit,
tested decision rather than a side effect" — assumed a live skill. At one
lifetime invocation, that is ceremony. **Just fix it to the stripped form** to
match `builtins.ts`, note it in the commit message, and move on. Keep one
assertion so the behaviour is pinned going forward, since `audit-fit` may see
more use later and this is the kind of asymmetry that becomes load-bearing
silently.

---

## Recommended sequence

**Revised per the addendum: two stages, not three.** The original Stage 2
(migrating `audit-fit`) existed only to isolate a permission surface that turns
out to have one lifetime invocation. It folds into Stage 1, which is what makes
the F4 payout real.

**Stage 0 — free (`LOW`).** Delete `toAgentDefinition`
(`to-definition.ts:45-71`) and its barrel re-export (`index.ts:4`). Confirmed
dead: zero call sites repo-wide, and its own docstring says
*"⚠️ NOT CURRENTLY WIRED"* (`:49`). The only other mention is ADR 0002 itself.

**Stage 1 — the refactor (`MEDIUM`). RECOMMENDATION: do not implement as
specified.** The cost/benefit inverted once C3's parameterization constraint and
C4's third reversal were established. What Stage 1 actually buys, net:

- it **relocates** the per-agent duplication into `builtins.ts` rather than
  removing it (C3 — the bundler needs one literal read per agent);
- it converts a **typed, type-checked** dependency into an **untyped coupling to
  a build-script regex**, whose failure mode is invisible to `pnpm lint`,
  `pnpm test`, and `pnpm build`, and surfaces only in the published npm artifact;
- it reverses three documented decisions (C1, C2, C4);
- its headline benefit (F4, 3 → 2) comes from the `audit-fit` migration, which
  is separable and can be taken **without** deleting the wrappers.

The honest summary: the wrapper layer is smaller and more load-bearing than ADR
0002 assumes, and deleting it trades a visible duplication for an invisible one.
**Take the F4 win separately (Stage 2′ below) and leave the wrappers alone.**

If it is implemented anyway, the steps and constraints are below and all six are
load-bearing. In `builtins.ts`, source `name`,
`description`, `tools`, and `prompt` from `parseAgentMarkdown` over the pinned
`.md`; keep `model`, `maxToolUseIterations`, `bashReadOnly`, and
`source: 'builtin'` as literals (two already are). Then delete
`research-agent.ts`, `git-investigator.ts`, `contract.ts`, and `index.ts`.
Constraints, all load-bearing:

1. **Preserve the `readFileSync(join(__dirname, '<literal>.md'), 'utf8')`
   syntactic shape** at the new read site, or `build:dist` ships a bundle that
   reads a missing file (C3). Verify with `pnpm build:dist` plus an actual
   run of the published entry point — **not** `pnpm build`, which masks it.
2. Do **not** touch the prompt `.md` files. Adding frontmatter breaks pins
   `80993a5f…` / `d1f186b8…` (`vendored.test.ts:13,15`).
3. Reduce `vendored.test.ts` to the byte-equal snapshot block (`:34-52`) and
   add shape tests against the new construction path.
4. Retire the `builtins.ts:27-37` docstring deliberately (C2).
5. Migrate `audit-fit` off `vendoredToolAllowlist` onto `resolveAgentToolAccess`
   in the same PR, then delete `to-definition.ts` entirely —
   `KNOWN_AFK_TOOL_NAMES` 3 → 2. This is the step that delivers the ADR's stated
   F4 benefit; it was a separate stage until telemetry showed `audit-fit` has one
   lifetime run. Keep `audit-fit.test.ts:392-413`'s assertions green — the
   normalized set must stay exactly `{read_file, grep, glob, web_scrape}`.
6. Fix the `audit-fit` prompt to the stripped form and pin it with one assertion.

**Stage 2′ — the recommended alternative to Stage 1 (`LOW`).** Take the F4 win
without touching the wrappers or the bundler. Migrate `audit-fit` off
`vendoredToolAllowlist` onto `resolveAgentToolAccess`, delete
`to-definition.ts` (taking `toAgentDefinition` with it, so this subsumes Stage
0), and leave `research-agent.ts` / `git-investigator.ts` / `contract.ts` /
`index.ts` in place. Result: `KNOWN_AFK_TOOL_NAMES` 3 → 2, the dead fossil gone,
zero change to `builtins.ts`, zero bundler risk, zero reversals. This delivers
the only benefit ADR item 2 actually names, at a fraction of the blast radius.
Keep `audit-fit.test.ts:392-413` green — the normalized set must stay exactly
`{read_file, grep, glob, web_scrape}`.

**Explicitly not now.** Adding `model` / `bash: read-only` /
`maxToolUseIterations` to the pinned frontmatter. It breaks the upstream sync
guard for zero gain, since all three are expressible as construction-site
literals and two already are.

---

## What would change this verdict

1. ~~Upstream starts shipping `model:` / `bash:` frontmatter~~ — **tested
   2026-07-29, not satisfied.** Upstream carries exactly `name`, `description`,
   `tools`; both prompts are byte-identical to the vendored copies. Since the
   maintainer *owns* the upstream (`griffinwork40/awa-private`), adding the keys
   and re-pinning is technically available — but it reverses #625 (C4) and
   requires a coordinated two-repo change. Re-check only if upstream changes for
   an independent reason.
2. ~~`audit-fit` is retired or stops consuming `researchAgent`~~ — **realized
   2026-07-29.** Telemetry showed one lifetime invocation, so the stages merged
   and F4 drops to 2 within the single change. If `audit-fit` later grows real
   usage *before* this lands, re-split it and re-map its gate.
3. ADR **item 1** (collapsing the two agent types) lands first → `git-investigator`
   disappears as a distinct type → this map's git-investigator half is void and
   should be re-run. Item 1 and item 2 overlap in `builtins.ts`; sequencing them
   in the same file without re-mapping will conflict.
4. Pattern A in the esbuild plugin is removed as dead code before Stage 1 →
   constraint 1 becomes unsatisfiable and the prompts need an explicit
   `build:dist` copy path instead.

## References

- [ADR 0002 — read-only agent-type consolidation](../decisions/0002-readonly-agent-type-consolidation.md)
- Target layer: [`src/skills/_agents/`](../../src/skills/_agents/)
- Primary consumer: [`src/agent/agents/builtins.ts`](../../src/agent/agents/builtins.ts)
- Named blast radius: [`src/skills/audit-fit/index.ts`](../../src/skills/audit-fit/index.ts)
- Pipeline: `src/agent/agents/parser.ts`, `src/agent/agents/resolve.ts`
- Build: [`scripts/esbuild-plugin-inline-prompts.mjs`](../../scripts/esbuild-plugin-inline-prompts.mjs),
  [`scripts/update-hash-pins.ts`](../../scripts/update-hash-pins.ts)
