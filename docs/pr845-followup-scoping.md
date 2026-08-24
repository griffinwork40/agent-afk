# PR #845 follow-up scoping

**Scope of this document:** pure scoping — no implementation. Written against
`afk/user-scoped-afk-config @ b105b3b4` (confirmed via `git log -1 b105b3b4`
inside this worktree — this IS the branch head, not a stale reference). All
citations are `path:line` from files read in this worktree this session.

PR #845 made the AFK.md tier-3 overlay additive: `loadAfkMd()`
(`src/cli/config/afk-md-tier.ts:87-116`) now concatenates `$AFK_HOME/AFK.md`
and `<cwd>/AFK.md` when both exist and are non-empty, instead of the old
first-found-wins fallback.

## Summary table

| Follow-up | Verdict | Effort | Files touched | Ships with |
|---|---|---|---|---|
| F1 — walk to git root for project tier | **DO-LATER** (needs a product decision first) | M (~150-220 LOC incl. tests) | `src/cli/config/afk-md-tier.ts` (+ new `afk-md-discovery.ts` if extracted), `src/cli/config.test.ts` | Own PR |
| F2 — outer tiers still exclusive | **DO** (option b: warn, not additive) | S-M (~80-120 LOC incl. tests) | `src/cli/config.ts`, `src/cli/config.test.ts` | Own PR (or paired with F3) |
| F3 — in-session provenance listing | **DO** | S (~40-70 LOC incl. tests) | `src/cli/slash/commands/config-doctor.ts` (`renderConfigView`), its test file | Pairs with F2 |
| F4 — realpath the dedup guard | **DO** | S (~30-50 LOC incl. tests) | `src/cli/config/afk-md-tier.ts`, `src/cli/config.test.ts` | **First PR**, paired with F5 |
| F5 — lock triple-part provenance format in tests | **DO** | S (~40-60 LOC, tests only) | `src/cli/shared-helpers.test.ts`, `src/cli/config.test.ts` | Paired with F4 |

No follow-up is INVALID — all five premises were verified true against this
worktree's code (see each section). One premise of the task brief needed
correction: see "Premises checked" at the end of F1.

---

## F1 — Walk up to the git/repo root for the project tier

**Verdict: DO-LATER.** The mechanism is real and the gap is real, but the
walk's stopping rule (git root vs. `$HOME` vs. filesystem root) is a product
decision, not a code question — see "Not checked / needs human decision."
Building the wrong stopping rule now means a breaking change later (the
provenance-path list would grow from 2 to N entries either way, but *which*
N is user-visible and hard to walk back once people commit ancestor
`AFK.md` files expecting a given behavior).

**Premise check.** CONFIRMED true. `loadAfkMd()` probes exactly two fixed
`path.join()` calls, no loop:
```
src/cli/config/afk-md-tier.ts:90  const userPath = join(getAfkHome(), 'AFK.md');
src/cli/config/afk-md-tier.ts:91  const projectPath = join(process.cwd(), 'AFK.md');
```
Grepped the whole `src/` tree for any ancestor-walk pattern that might already
cover this (`dirname` loop, `while` + `parent === current`, etc.) — the only
hits are unrelated: TUI scrollback "ancestor walk" in
`src/cli/_lib/stream-renderer-orchestrator.ts:271` and
`src/cli/commands/interactive/tool-lane.ts:605,718` (agent-context tree
rendering, nothing to do with file discovery), and the write-denylist's
`safeRealpath` ancestor walk (`src/agent/tools/handlers/write-denylist.ts:150-163`,
resolves symlinks for an existing/about-to-exist path, not a config search).
No walk exists today. The task brief's framing of F1 is accurate.

**Touch points.**
- `src/cli/config/afk-md-tier.ts:87-116` (`loadAfkMd`) — replace the single
  `projectPath` probe with a walk from `process.cwd()` upward to a stopping
  point, collecting every `AFK.md` found (or just the nearest, per the
  decision below).
- `src/cli/config/afk-md-tier.ts:12-25` (`AfkMdResult.paths`) — the doc
  comment's "Length 2 only" invariant becomes "Length 1 + N ancestors";
  `systemPromptSource` building in `src/cli/config.ts:160`
  (`afkMd.paths.map((p) => \`afk-md:${p}\`).join('+')`) already generalizes to
  N paths with no code change — confirmed by reading that line, it's a
  `.map().join()` over an array, not special-cased to length 2.
- Would need a git-root resolution helper. Two existing patterns to reuse
  rather than reinvent:
  - `src/agent/worktree.ts:205` — `git(cwd, ['rev-parse', '--show-toplevel'])`
    via `execFileAsync`, async.
  - `src/agent/awareness/workspace-source.ts:45-66` — `spawnSync('git', args,
    { shell: false })`, sync, returns `null` on any failure (no git repo, git
    missing). This is the better model for `afk-md-tier.ts` because
    `loadAfkMd()` is currently fully synchronous (`readFileSync`/`existsSync`)
    and every one of its 39 call-site ancestors (`loadConfig()` itself,
    `src/cli/config.ts:125`) is synchronous too — introducing `async` here
    ripples into `loadConfig()`'s signature and all 20 non-test callers
    (`grep -rln "loadConfig("` → daemon.ts, worktree.ts, interactive.ts,
    chat.ts, index.ts, telegram.ts, provider.ts, and the tier modules
    themselves). A sync `spawnSync` git call keeps `loadConfig()` sync.
  - Neither existing helper resolves "git root," only "worktree toplevel" —
    `--show-toplevel` for a worktree returns the worktree's own root, not the
    superproject if any, which is exactly what "git root" should mean here
    (F1 asks about repo root, not monorepo super-root).

**Behavioral contract (proposed, pending the decision below):** walking from
`cwd` up to (whichever stopping point is chosen), collect every readable
non-empty `AFK.md` along the way, nearest-first, then reverse so broadest
lands first in the concatenation (mirrors the existing user→project
ordering, extended). Single-file-found case must stay byte-identical (no
headers) — this is the existing invariant at
`src/cli/config/afk-md-tier.ts:70-77` and must be preserved for back-compat
when the walk finds exactly one file total (user-only or project-only,
matching today).

**Test cases needed:**
- `walks up from a subdirectory and finds the repo-root AFK.md`
- `does not find an AFK.md above the git root` (whichever stop rule wins)
- `combines an ancestor AFK.md with the user-scope AFK.md` (3-way concat —
  exercises whether `systemPromptSource` truly generalizes past 2 entries)
- `stops the walk at $AFK_HOME's own AFK.md without double-reading it` (dedup
  guard interaction — if `$AFK_HOME` is itself an ancestor of `cwd`, which
  is possible if a user launches `afk` from inside `~/.afk`)
- `does not walk when cwd is not inside a git repo` (falls back to the
  current cwd-only probe, git call returns null)
- A perf/behavior case: `memoizes the walk result across repeated loadConfig() calls in one process` (existing `afkMdCache` contract, see below)

**Existing tests that need rewriting:** none of the 11 cases in
`describe('AFK.md auto-discovery', ...)` (`src/cli/config.test.ts:398-641`)
assert "only these two literal paths are checked" as a negative — they mock
`existsSync`/`readFileSync` by suffix match (`s.endsWith('AFK.md')`), which
tolerates an arbitrary number of candidate paths being probed. They should
keep passing unchanged as long as the single/dual-tier shapes they set up
resolve to the same one/two paths. Low risk of needing a rewrite, but every
case should be re-run to confirm mocks don't now also match a spurious
ancestor probe in the test's own tmp/cwd tree.

**Blast radius.** `loadAfkMd()` has exactly one caller in the whole
tree: `src/cli/config.ts:153`. Confirmed via
`grep -rn "loadAfkMd\b" src/` — every other hit is a doc-comment reference.
So the walk change is contained to one file plus its one caller (which
needs no code change, only the `.map()` already generalizing). The
`AfkMdResult.paths` growing past length 2 could theoretically affect any
caller that assumed `paths.length <= 2` — grep found none.

**Risk of silent breakage.** Two real hazards:
1. **Memoization vs. `process.chdir()`.** `afkMdCache` (`src/cli/config/afk-md-tier.ts:27`)
   is a plain module-scope `let`, invalidated only by `resetAfkMdCache()`
   (`:34-36`), called only from `_resetConfigCache()`
   (`src/cli/config.ts:67-73`), called only from test `beforeEach` hooks
   (`src/cli/config.test.ts:120,408`) — **zero production call sites**
   invalidate it. Production DOES call `process.chdir()`: the REPL's
   born-named worktree flow, `pinProcessCwd()`
   (`src/cli/commands/interactive/worktree-autoname.ts:481-496`), fires from
   `finalizeWorktreeCwd` (`:466-472`), invoked by `runFirstTurnAutoname`
   (`:399-457`) on the session's first turn. Today this is harmless for
   `loadAfkMd()`: `resolveBaseSystemPrompt()` is called once at
   `bootstrapSession()` time (`src/cli/commands/interactive/bootstrap.ts:197`),
   BEFORE the worktree chdir happens (chdir is wired into the first-turn hook,
   `src/cli/commands/interactive.ts:447-457`, awaited before `runTurn`) — so
   the cached `cwd`-relative read from the launch dir is what gets baked into
   the session's `systemPrompt` at construction, and is never re-read for that
   session (`AgentSession.systemPrompt` is set once at construction,
   `src/cli/commands/interactive/bootstrap.ts:597` `buildAgentSession`).
   **A walk makes this worse, not better**: today a stale cache after chdir
   only affects a *second* top-level session in the same process (rare outside
   tests); a walk means the cached *set* of ancestor paths is wrong after
   chdir, and — because a walk is more expensive (N `existsSync` + a git
   spawn) than 2 fixed joins — there's more incentive to cache it hard, which
   compounds the existing staleness gap instead of fixing it. This needs an
   explicit decision: either (a) accept the existing staleness contract
   unchanged (single top-level session per process is the assumed shape —
   true for `afk chat`/`afk i`, false for `afk daemon`/`afk farm`/Telegram
   which can run multiple ticks in one process — see daemon's
   `AFK_DAEMON_CWD`, `src/cli/commands/daemon.ts:405-411`, which explicitly
   works around this class of problem for the JSON tier already), or
   (b) wire `resetAfkMdCache()` into `pinProcessCwd()` or `setCwd()`
   (`src/agent/session/agent-session.ts:979-983`, which already documents
   "Does NOT mutate `process.cwd()`" as a deliberate boundary — adding an
   AFK.md cache invalidation there would be a second, narrower crossing of
   that boundary and needs its own justification).
2. **Monorepo bloat.** A walk from deep inside a large monorepo could surface
   AFK.md files the user didn't intend to load (a sibling package's repo-root
   AFK.md meant for a different subproject). Claude Code's answer to this
   exact problem is `claudeMdExcludes` — AFK has no equivalent today, and
   this follow-up would need one or explicitly defer it.

**Effort: M** — the walk itself is small (~20-40 LOC), but a git-root
resolution helper + its sync/async decision + the ancestor-collection loop +
cache-invalidation decision + the widened test matrix push this past S. Rough
LOC delta: 60-100 in `afk-md-tier.ts` (or a new sibling file if the git-root
helper is non-trivial — see the 350-LOC ceiling note below), 80-120 in tests.

**350-LOC ceiling check.** `afk-md-tier.ts` is 116 LOC today
(`wc -l src/cli/config/afk-md-tier.ts`). Even a generous +100 LOC for the walk
keeps it under 350 — no extraction forced by the ceiling for this file alone.
If the git-root resolution helper grows non-trivial (retry logic, caching,
error taxonomy), it should be its own file per the repo's "pull one whole
concern into a new file" convention (`AFK.md:141-142` project root file, and
issue #782's precedent doing exactly this move for two unrelated
over-ceiling files — `git show d7df7ea2 --stat` in this repo).

---

## F2 — Outer tiers are still exclusive

**Verdict: DO — but option (b) (warn/provenance signal), not option (a)
(make tiers additive).**

**Premise check.** CONFIRMED true, read directly:
```
src/cli/config.ts:144  if (envConfig.systemPrompt !== undefined) {
src/cli/config.ts:145    systemPromptSource = 'env:AFK_SYSTEM_PROMPT';
src/cli/config.ts:146  } else if (jsonConfig.systemPrompt !== undefined && jsonSourcePath !== undefined) {
src/cli/config.ts:147    systemPromptSource = `file:${jsonSourcePath}`;
src/cli/config.ts:148  } else if (merged.systemPrompt === undefined) {
src/cli/config.ts:149    // Neither env nor JSON set systemPrompt — try AFK.md.
```
This is a strict if/else-if chain: setting `AFK_SYSTEM_PROMPT` or
`afk.config.json.systemPrompt` means `loadAfkMd()` (`:153`) is never even
called — confirmed by the `else if (merged.systemPrompt === undefined)` guard
sitting on the THIRD branch, unreachable once either of the first two fires.
Two existing tests exercise exactly this and encode it as the intended
behavior today: `'ignores AFK.md when AFK_SYSTEM_PROMPT env is set'`
(`src/cli/config.test.ts:519-533`) and `'ignores AFK.md when afk.config.json
sets systemPrompt'` (`:535-553`).

**Why (b), not (a).** Recommending against making tiers 1-2 additive with
tier 3:
- **Back-compat risk named in the brief is real.** `AFK_SYSTEM_PROMPT` is
  documented as "Highest-priority overlay" that is "Appended on top of the
  framework base... it augments, never replaces, the base"
  (`src/config/env.ts:568`) — i.e. its contract is already "augments the
  framework," and someone relying on it to fully suppress a stray/legacy
  `AFK.md` (e.g. CI runners, ephemeral containers, a shared machine with
  someone else's `~/.afk/AFK.md`) would silently get unexpected extra content
  in their system prompt. This is a materially different risk profile from
  #845's own fix (concatenating two files the OPERATOR authored themselves
  at two scopes they control) — env/json-vs-AFK.md crosses a "did the person
  setting AFK_SYSTEM_PROMPT know an AFK.md exists" boundary that #845's two
  AFK.md tiers don't.
- **`systemPrompt` is human-tier, not agent-tier**, in the self-service config
  gate: `src/config/settable-keys.ts:226` — `{ path: 'systemPrompt', tier:
  'human', ... }`. This repo already treats "what governs the system prompt"
  as an explicit-human-intent surface, which supports a warn/signal
  (informative) response over an automatic behavior change (additive).
- A warning is also strictly cheaper to build and revert if wrong — additive
  would require deciding an ordering/heading convention for a 3-way (or
  4-way, since JSON path + AFK.md-user + AFK.md-project could all
  theoretically want representation) merge, then living with that contract
  once shipped.

**Touch points.**
- `src/cli/config.ts:139-162` — after resolving `systemPromptSource` via the
  existing if/else-if chain, add a check: if tier 1 or 2 won AND `loadAfkMd()`
  (called unconditionally now, side-effect-free besides the memoized disk
  read) would have returned non-null, surface that fact. Two candidate
  mechanisms:
  - Add a new field to `CliConfig` (`src/cli/config/types.ts`), e.g.
    `shadowedAfkMdPaths?: string[]`, populated whenever a higher tier wins
    over a present AFK.md. Non-breaking additive field.
  - Push a warning string into a warnings-collection surface. The REPL
    already has exactly this pattern for other config surprises:
    `bootWarnings` (`src/cli/commands/interactive/bootstrap.ts:280`, drained
    by `drainBootWarnings()`,
    `src/cli/commands/interactive/boot-warnings.ts:26-31`). `loadConfig()`
    itself has no warnings channel today (it's a pure function returning
    `CliConfig`), so wiring straight into `bootWarnings` would require either
    threading a callback into `loadConfig()` (breaking its 20+ call sites'
    call shape) or having each of the ~5 real call sites
    (`chat.ts`, `interactive.ts`/`bootstrap.ts`, `daemon.ts`, `telegram.ts`,
    `index.ts`) independently check the new `shadowedAfkMdPaths` field and
    push their own bootWarning/console.warn — more consistent with the
    existing "each surface renders for itself" pattern (see `/doctor`'s
    shared `runDoctorChecks()` returning data, not printing —
    `src/cli/commands/doctor-checks.ts:217-238`).
  - Recommend: `CliConfig.shadowedAfkMdPaths?: string[]` (data field) +
    each surface's existing warning-render path consumes it. This is the
    "config.ts stays pure, surfaces render" convention already established.

**Behavioral contract:** `loadConfig()`'s systemPrompt resolution stays
byte-identical (still if/else-if, still tier 1 > 2 > 3 exclusive) — this is
NOT a behavior change to what governs the actual prompt, only an added
diagnostic signal about what got shadowed. `AFK_SYSTEM_PROMPT`/
`afk.config.json.systemPrompt` continue to fully replace tier 3 with no
runtime behavior change; the new field only reports that fact so it's no
longer silent.

**Test cases needed:**
- `reports shadowedAfkMdPaths when AFK_SYSTEM_PROMPT wins over a present AFK.md`
- `reports both paths shadowed when AFK_SYSTEM_PROMPT wins over a combined user+project AFK.md`
- `reports no shadowedAfkMdPaths when AFK_SYSTEM_PROMPT is set and no AFK.md exists` (no false positive)
- `reports shadowedAfkMdPaths when afk.config.json.systemPrompt wins over AFK.md`
- A REPL-level or `/doctor`-level test asserting the new signal renders somewhere (once F3's integration point is chosen — F2 and F3 share the natural output surface)

**Existing tests needing rewriting:** none — the two exclusivity tests
(`src/cli/config.test.ts:519-533`, `:535-553`) assert `config.systemPrompt`
and `config.systemPromptSource`, which do not change under option (b). A new
assertion on `shadowedAfkMdPaths` would be *added* to those same `it()`
blocks or a new sibling `it()`, not a rewrite.

**Blast radius.** `loadConfig()` has 20 non-test call sites
(`grep -rln "loadConfig(" src/ | grep -v test`), but adding an optional field
to `CliConfig` is additive/non-breaking for every one of them — none
destructure `CliConfig` exhaustively (all consumption sites use
`cliConfig.<specificField>` access, not a exhaustiveness-checked switch).
Confirmed by reading `src/cli/config.ts:164-194` — the `CliConfig` object
literal itself is built with conditional spreads (`...(x !== undefined ? {x} : {})`),
so a new optional field is a one-line addition with no ripple.

**Risk of silent breakage:** low. The main risk is scope creep into "should
this become the additive behavior after all" mid-implementation — worth
locking the warn-only decision before writing code (see the shipping-shape
section: pairs well with F3 since both surface provenance data).

**Effort: S-M.** Rough LOC delta: ~30-50 in `config.ts` + `types.ts`, ~50-70
in tests. The design/decision work (which field, which surfaces render it)
is the bulk of the cost, not the code.

---

## F3 — In-session provenance listing

**Verdict: DO.**

**Premise check.** CONFIRMED true on both halves of the claim:
1. `systemPromptSource` is real and does encode which paths contributed —
   `src/cli/config.ts:160`:
   `systemPromptSource = afkMd.paths.map((p) => \`afk-md:${p}\`).join('+');`
   — and `resolveBaseSystemPrompt()` layers it further with the framework
   marker (`src/cli/shared-helpers.ts:111-124`, producing e.g.
   `framework+afk-md:<user>+afk-md:<project>`).
2. It is genuinely only surfaced via `--dump-prompt`/`AFK_DUMP_PROMPT` today.
   Grepped every non-test, non-doc-comment reference to `systemPromptSource`:
   it flows into `AgentConfig.systemPromptSource`
   (`src/agent/types/config-types.ts:214`, explicitly commented
   "Provenance-only... Must NOT be forwarded to the SDK options object"),
   consumed by exactly one runtime site,
   `src/agent/providers/anthropic-direct/index.ts:500`
   (`source: config.systemPromptSource ?? 'none'`), which feeds directly into
   `dumpIfEnabled()` (`src/agent/session/prompt-dump.ts:271-328`) — gated on
   the `AFK_DUMP_PROMPT` env var. No slash command, no status line, no
   `/debug` field references it. Confirmed `renderDebugBanner()`
   (`src/cli/debug-banner.ts:27-62`) — the closest existing "what did this
   session load" surface — reads `SessionMetadata` fields (`sessionId`,
   `model`, `permissionMode`, `cwd`, `tools`, `mcpServers`, `skills`,
   `plugins`, `slashCommands`, `apiKeySource`), and `SessionMetadata`
   (`src/agent/types/session-types.ts:57-71`) has **no** `systemPromptSource`
   field — it's populated exclusively from the SDK's `session.init` event
   (`src/agent/session/stream-consumer.ts:277-296`), not from `CliConfig`,
   so `/debug` structurally cannot show it without new plumbing.

**Real integration point (grepped, not invented).** `src/cli/slash/commands/`
holds `afk`, `allow-dir`, `bgsub`, `changelog`, `config-doctor`, `editor`,
`fork`, `info` (owns `/cost /tokens /history /model /tools /mcp /debug
/usage /limits`), `init`, `keys`, `name`, `plan`, `reauth`, `resume`, `retry`,
`search`, `sh`, `stats`, `theme`, `thinking`, `todo`, `transcript`,
`worktree`. Of these, **`/config view`**
(`src/cli/slash/commands/config-doctor.ts:139-190`, rendering logic
`renderConfigView()` at `:33-94`) is the closest existing "show resolved
configuration" surface — it already prints model/provider/api-key-source/
thinking/effort/permission-mode plus a table of env vars
(`:79-92`), all read fresh at call time with zero side effects (it reads
`env.*` directly and `resolveCliPermissionMode()`, which is explicitly
documented as side-effect-free — `src/cli/config.ts:96-107`). `/debug`
(`src/cli/slash/commands/info.ts:516-531`) is the other candidate but is
wired to live SDK session metadata (`ctx.session.current.waitForInitialization()`),
which as shown above does not carry `systemPromptSource` — extending it would
require a new plumbing path from `CliConfig` into `SessionMetadata`, a larger
change than extending `/config view`, which can call `loadConfig()`
(memoized, side-effect-free after the first real call) directly.

**Recommendation: extend `/config view`**, not a new slash command. Rationale:
lower blast radius (one function, already renders exactly this class of
data), matches the "check which files loaded" framing from the Claude Code
comparison (`/context` → Memory files is CC's answer; `/config view` is
AFK's nearest analog for "what governs this session"), and avoids a second
command name to remember.

**Behavioral contract:** `renderConfigView()` gains a new block (after the
existing "Environment variables" table) showing: the resolved
`systemPromptSource` string (via `loadConfig().systemPromptSource`), and —
if F2 ships first or alongside — the `shadowedAfkMdPaths` warning. No change
to any existing rendered line; purely additive rows.

**Test cases needed** (extend `src/cli/commands/config-doctor.test.ts` or
wherever `renderConfigView` is tested — confirm exact file at implementation
time):
- `/config view shows the resolved systemPromptSource when AFK.md is active`
- `/config view shows the combined afk-md:<user>+afk-md:<project> form when both tiers resolve`
- `/config view shows "none" or omits the row when no overlay is configured`
- `/config view shows the env:AFK_SYSTEM_PROMPT / file:<path> forms for the other two tiers`
- (paired with F2) `/config view surfaces a shadowed-AFK.md warning when a higher tier wins`

**Existing tests that would need rewriting:** none identified — this is a
pure addition to `renderConfigView()`'s output; no existing assertion pins
the exact set of lines it prints (would need to verify at implementation
time whether a snapshot test exists — none found in this recon pass, but the
file wasn't exhaustively read for its own `.test.ts` sibling; flagged as not
fully checked below).

**Blast radius.** `renderConfigView` is called from 4 sites inside
`config-doctor.ts` itself (`:148, 156, 164, 186`) — all within the same file,
all existing call sites, no external callers (confirmed:
`grep -rn "renderConfigView"` only in this file). Essentially zero blast
radius outside the one file plus its test.

**Risk of silent breakage:** very low — additive rendering only.

**Effort: S.** Rough LOC delta: ~20-30 in `config-doctor.ts`, ~30-50 in
tests (assuming a test file needs light extension — not independently
verified to exist; see "Not checked" below).

---

## F4 — `realpath` the dedup guard

**Verdict: DO.**

**Premise check.** CONFIRMED true, read directly:
```
src/cli/config/afk-md-tier.ts:96  const projectContent = projectPath === userPath ? null : readAfkMdCandidate(projectPath);
```
`userPath` and `projectPath` are both `path.join()` outputs
(`:90-91`), never `realpathSync`'d. A symlinked `$AFK_HOME` pointing at `cwd`
(or vice versa), or a case-variant path on a case-insensitive filesystem
(macOS default APFS), would make `projectPath === userPath` evaluate `false`
even though they resolve to the same inode — both `readAfkMdCandidate()`
calls would succeed, duplicating the entire file's content under both the
"Personal configuration" and "Project configuration" headers. The ONLY
existing test for this guard,
`'does not duplicate content when $AFK_HOME/AFK.md and cwd/AFK.md resolve to
the same file'` (`src/cli/config.test.ts:496-517`), sets
`process.env['AFK_HOME'] = process.cwd()` — a literal string-identical
case, never a symlink or case-variant. Confirmed no symlink/case-insensitivity
test exists anywhere in the repo for this guard (`grep -n "symlink\|
case-insensitive\|case-variant\|APFS" src/cli/config.test.ts
src/cli/config/afk-md-tier.ts` → zero hits in either file).

**Touch points.**
- `src/cli/config/afk-md-tier.ts:90-96` — replace the raw `===` with a
  realpath-based comparison. The repo already has a proven pattern for
  exactly this: `safeRealpath()`
  (`src/agent/tools/handlers/write-denylist.ts:137-164`) — never throws,
  walks up to the nearest existing ancestor for a not-yet-existing path, and
  is already used for denylist entries. `realpathSafe()`
  (`src/agent/tools/handlers/_cwd-utils.ts:25-36`) is a near-duplicate in a
  different module (agent-layer tool handlers) — using either requires an
  import from `src/agent/tools/handlers/` into `src/cli/config/`, which is
  an unusual direction (CLI importing from agent/tools) worth flagging;
  more likely the right move is a small local realpath-with-fallback inlined
  in `afk-md-tier.ts` (it's ~10-15 LOC, not worth a cross-layer import for) or
  promoted to a shared low-level path util if a third caller ever wants it.
- Error handling for non-existent paths: **required**, because
  `readAfkMdCandidate()` already treats a missing file as `null`
  (`:44-45`, `if (!existsSync(path)) return null;`) — the dedup check
  currently runs on the RAW paths regardless of existence
  (`projectPath === userPath` at `:96` executes even if neither file exists).
  A naive `realpathSync(userPath) === realpathSync(projectPath)` would THROW
  when either path doesn't exist (the common case — most repos have only
  one AFK.md or none), breaking `loadAfkMd()` for the majority of callers.
  The fix must only realpath-compare when BOTH paths exist (gate on
  `existsSync` first, matching the existing `readAfkMdCandidate` control
  flow), falling back to the current lexical `===` when either or both are
  absent (in which case the dedup question is moot anyway — you can't
  duplicate a file that isn't there).

**Behavioral contract:** when both `$AFK_HOME/AFK.md` and `<cwd>/AFK.md`
exist on disk and resolve (via realpath) to the same file — whether by
literal path equality, a symlink, or (on a case-insensitive filesystem) a
case-variant path — the content is read and counted once, matching today's
single-tier byte-identical output contract
(`src/cli/config/afk-md-tier.ts:70-77`). When either path doesn't exist,
behavior is unchanged (no realpath call attempted, existing `null`
short-circuit in `readAfkMdCandidate` still governs).

**Test cases needed:**
- `treats a symlinked $AFK_HOME/AFK.md pointing at cwd/AFK.md as the same file (no duplication)`
- `treats a case-variant path as the same file on the current filesystem`
  (this one is filesystem-dependent — case-insensitivity is a macOS APFS
  default, not universal; the test should either mock `realpathSync` to
  return a lowercased path regardless of platform, or skip on Linux CI —
  needs a decision at implementation time, flagged below)
- `still treats two distinct real files at different paths as two tiers` (regression guard — must not over-merge)
- `does not throw when one of the two AFK.md paths does not exist` (regression guard for the "gate on existsSync first" fix)
- `does not throw when neither AFK.md exists` (regression guard, mirrors existing `'does not throw when no AFK.md exists anywhere'`, `src/cli/config.test.ts:632-641`)

**Existing tests needing rewriting:** the existing dedup test
(`src/cli/config.test.ts:496-517`) should keep passing unchanged — it's a
subset of the new realpath-based check (literal string equality is also
realpath equality when neither path involves a symlink). No rewrite forced,
but worth re-running to confirm the `mockedExistsSync`/`mockedReadFileSync`
mocking pattern doesn't also need `realpathSync` mocked once the
implementation adds that call (currently unmocked in the `vi.mock('fs', ...)`
factory at `src/cli/config.test.ts:62-73` — `realpathSync` is NOT in the
mocked export list, so a test that exercises the new code path would fall
through to the REAL `realpathSync`, which is probably fine for a genuine
temp-dir symlink test but needs adding to the mock factory if a case wants
to simulate realpath behavior without touching real disk).

**Blast radius.** Same as F1 — `loadAfkMd()` has exactly one caller
(`src/cli/config.ts:153`). Zero external blast radius.

**Risk of silent breakage:** very low if the existsSync-gate is respected;
HIGH if it isn't (an ungated `realpathSync` call would throw on the common
single-tier-or-no-tier case and take down `loadConfig()` for every caller —
this is the one thing to get right in review).

**Effort: S.** Rough LOC delta: ~15-25 in `afk-md-tier.ts`, ~40-60 in tests
(the case-insensitivity test needs either a real temp-dir fixture or a
mocked `realpathSync`, which adds a bit of setup weight).

---

## F5 — Lock the triple-part provenance format in tests

**Verdict: DO.**

**Premise check.** CONFIRMED true on both halves.
1. The triple-part format is genuinely produced:
   `resolveBaseSystemPrompt()` (`src/cli/shared-helpers.ts:111-124`) builds
   `source = \`framework+${overlaySource ?? 'unknown'}\`` (`:119`) where
   `overlaySource` is whatever `loadConfig().systemPromptSource` resolved to
   — which, per `src/cli/config.ts:160`, can itself already be the two-part
   `afk-md:<user>+afk-md:<project>` string. Composed together this yields
   `framework+afk-md:<user>+afk-md:<project>` — a genuine triple-part (really
   N+1-part) provenance string.
2. Only the single-path form is asserted in `shared-helpers.test.ts`. Read
   the full `describe('resolveBaseSystemPrompt', ...)` block
   (`src/cli/shared-helpers.test.ts:127-167`) — three `it()`s:
   `:143-152` asserts `source === 'framework+afk-md:/repo/AFK.md'` (single
   path), `:154-160` asserts `'framework'` (no overlay), `:162-166` asserts
   `'framework+env:AFK_SYSTEM_PROMPT'` (env tier, also single-segment).
   **None** constructs a `fakeConfig` with a `+`-joined
   `systemPromptSource` to verify the combined-tier case survives
   `resolveBaseSystemPrompt()`'s own string-building unchanged. Confirmed via
   `grep -n "framework+afk-md" src/` — the only test hit is line 151, the
   single-path case.

**Additional post-#845 behaviors implemented but not test-locked** (per the
brief's explicit ask to flag more than just the provenance format):

1. **Dedup comparison semantics** — covered by F4 above (symlink/case-variant
   untested).
2. **Asymmetric blank** (one tier blank/whitespace-only, the other
   populated) — CONFIRMED untested. The existing whitespace test
   (`'treats empty or whitespace-only AFK.md as absent'`,
   `src/cli/config.test.ts:617-630`) makes BOTH `$AFK_HOME/AFK.md` and
   `<cwd>/AFK.md` return the same whitespace-only string
   (`mockedReadFileSync().mockImplementation((p, ...args) => { if
   (String(p).endsWith('AFK.md')) return '   \n\t  '; ...`, `:622-624` — the
   `endsWith('AFK.md')` match fires for BOTH paths identically). There is no
   test where user-scope is blank and project-scope is populated (or vice
   versa) to confirm the single populated tier surfaces alone with no
   header (per the `readAfkMdCandidate` `null`-on-blank contract,
   `src/cli/config/afk-md-tier.ts:44-52`, and the `else if
   (projectContent !== null)` / `else if (userContent !== null)` branches at
   `:106-109` — logically this should already work correctly by inspection,
   but "implemented correctly" and "test-locked" are different claims).
3. **`--dump-prompt` rendering of combined tiers** — CONFIRMED untested.
   `src/agent/prompt-dump.test.ts` exists and tests `dumpIfEnabled()`
   extensively (grepped: 20+ `it()`s calling `dumpIfEnabled(payload)`), but
   none constructs a `payload.provenance.systemPrompt.source` with a
   `+`-joined combined-tier string to verify the dump file/stderr JSON
   renders it intact (dumpIfEnabled treats `provenance` as an opaque
   pass-through object per `src/agent/session/prompt-dump.ts:293-299`, so
   this is lower-risk than #1/#2 — there's no string-parsing of the
   provenance value anywhere in the dump path, only JSON serialization of
   whatever string it's handed — but it's still an explicit brief callout
   worth a locking test given zero coverage today).

**Touch points.**
- `src/cli/shared-helpers.test.ts:127-167` — add a 4th `it()` to
  `describe('resolveBaseSystemPrompt', ...)` using `fakeConfig('...',
  'afk-md:/home/user/AFK.md+afk-md:/repo/AFK.md')` and asserting
  `source === 'framework+afk-md:/home/user/AFK.md+afk-md:/repo/AFK.md'`.
- `src/cli/config.test.ts` — add an asymmetric-blank case near the existing
  `describe('AFK.md auto-discovery', ...)` block (`:398-641`), and a triple
  form is already indirectly covered by the existing combine test
  (`:470-494`) but its assertion (`:493`) only checks `config.systemPromptSource`
  (the two-part `loadConfig()`-level string), not the further-composed
  `resolveBaseSystemPrompt()` triple form — that composition only happens
  one layer up, hence needing the `shared-helpers.test.ts` addition instead.
- `src/agent/prompt-dump.test.ts` — add a case with a combined-tier
  `provenance.systemPrompt.source` string, assert it appears unmangled in
  the dumped JSON (file or stderr mode, whichever pattern the existing tests
  use).

**Behavioral contract:** none — this follow-up changes zero production code,
only adds test coverage. That is the entire point (lock current behavior so
a future refactor can't silently flatten it).

**Test cases needed:** (see touch points above — three new `it()`s across
three files.)

**Existing tests needing rewriting:** none — purely additive.

**Blast radius:** zero (test-only change).

**Risk of silent breakage:** none from this change itself; this IS the
mitigation for a risk that already exists (an unlocked format is one refactor
away from silent flattening).

**Effort: S.** Rough LOC delta: ~15-20 per new test, ~45-60 total across the
three files.

---

## Shipping-shape recommendation

**Ship F4 + F5 together, first, in one small PR.**
Rationale: both are small (S), both touch the same test file
(`src/cli/config.test.ts`) and closely related code
(`src/cli/config/afk-md-tier.ts` for F4; `src/cli/shared-helpers.test.ts` +
`src/agent/prompt-dump.test.ts` for F5 — no production code at all for F5).
Combined they are a pure hardening pass with the best value-to-risk ratio in
the set: F4 closes an actual (if narrow) correctness bug with a security
flavor (duplicated content isn't a leak, but a symlink-based dedup bypass is
exactly the kind of thing this repo's `AFK.md:141-142` "no unmocked
`realpathSync`" hygiene convention exists to catch — see the parallel
precedent at `src/agent/tools/handlers/_cwd-utils.ts:16-24`'s comment about
symlink escape being a real containment concern), and F5 adds zero risk
while directly protecting F4's own new behavior from a future silent
regression. **This should be first**: it's the safest, smallest, and most
self-contained change, and locking the provenance format before touching
anything else (F1, F2) means those later PRs inherit a green regression net
instead of writing on sand.

**F2 + F3 pair naturally into a second PR.** Both are about provenance
*visibility* — F2 produces the "a higher tier is shadowing your AFK.md"
signal, F3 is the surface that displays it (`/config view`). Shipping them
together avoids a dead-field problem (F2 alone adds a `CliConfig` field
nothing renders; F3 alone has nothing new to show without F2). Order within
the PR: F2's `shadowedAfkMdPaths` field first (data), F3's render addition
second (display) — same commit-ordering logic PR #845 itself likely used
(data model, then consumers).

**F1 deserves its own PR, and should ship last (or not yet).** It is the
only follow-up that changes a *public contract* — `AfkMdResult.paths` growing
past a fixed length of ≤2, a new git-dependency in a previously pure-fs
function, and a genuinely open product question (stopping rule) that a
maintainer should answer before code is written, not after. Bundling it with
anything else risks the smaller, lower-risk PRs waiting on that decision.
Recommend treating F1 as DO-LATER until the "Not checked / needs human
decision" question below is resolved, then scoping it as its own follow-up
pass (possibly re-running this same scoping exercise once the stopping rule
is chosen, since the effort/test-matrix estimate above is contingent on that
answer).

**Best value-to-risk ratio to do first: F4+F5** (as above) — small, testable,
self-contained, and it improves the safety net for every subsequent change
in this whole cluster.

---

## Not checked / needs human decision

**Needs a human product/UX decision (not a code question):**
- **F1's stopping rule.** Git root only, or keep walking to `$HOME`/filesystem
  root like Claude Code? The brief itself names this as "arguably a taste
  call" and this scoping pass agrees — it trades determinism/no-bloat
  (stop at git root) against Claude-Code parity and cross-repo personal
  conventions (keep walking). Recommend: default to git-root-only (safer,
  matches "AFK.md is project-scoped" framing already in the docs), with the
  `$AFK_HOME` tier remaining the separate "walk past the repo" mechanism —
  but this is exactly the call a maintainer should make explicitly, not
  something this document should silently decide.
- **F1's "every ancestor or just the nearest."** Concatenating every
  ancestor mirrors Claude Code most faithfully but multiplies the
  monorepo-bloat risk named above; "just the nearest non-empty" is a
  smaller, more conservative change with less parity to the comparison
  report's framing. Not decided here.
- **F2's exact wording/placement of the shadow-warning** — where it should
  appear (boot-time banner? `/config view` only? both?) is a UX call once
  the DO-vs-DO-LATER verdict (already made: DO, option b) is confirmed.
- **F4's case-insensitivity test strategy** — real temp-dir fixture
  (platform-dependent, would need to skip/adapt on Linux CI) vs. mocked
  `realpathSync` (portable, less "real" coverage). Not decided here.

**Not checked in this pass (explicit gaps):**
- Whether `src/cli/slash/commands/config-doctor.ts` has its own dedicated
  `.test.ts` file and its exact current assertions — I located the render
  function and its 4 call sites but did not exhaustively read a
  `config-doctor.test.ts` (if one exists under a different name) to confirm
  today's test surface before scoping F3's additions. Recommend a quick
  `glob` for `**/config-doctor*.test.ts` (or wherever `renderConfigView` is
  tested — possibly folded into a broader `config-command.test.ts`, which
  does exist per `src/cli/commands/config-command.test.ts` found in this
  repo's `src/cli/commands/` listing but not read) at implementation time.
- Did not run `pnpm test`, `pnpm lint`, or `pnpm build` — per the hard
  constraint, dependencies are not installed in this worktree. All findings
  are from static reading only; no test was executed to confirm current
  green/red status beyond what's inferable from the code and existing
  assertions.
- Did not check whether `docs/env-registry.md`/`.json` (the generated env
  docs) or any CI workflow would need regeneration for F1 if it introduces
  a new env var (it doesn't need one per the current design — the walk is
  cwd-derived, no new `AFK_*` var proposed here — but if the human decision
  above lands on "add an opt-out env var," the `ENV_REGISTRY`
  (`src/config/env.ts:98`) + `pnpm scan:env` regeneration step
  (documented at `AFK.md:9-24`) would become a required touch point not
  currently scoped).

**Out-of-scope finding worth flagging to the maintainer (not one of the five,
found incidentally while grounding F1-F3):** the public docs at
`website/content/docs/configuration/afk-md.mdx:22-30`,
`website/content/docs/configuration/overview.mdx:40-44,81,127`, and
`website/content/docs/how-it-works.mdx:12,90` all still describe the
**pre-#845 exclusive first-found-wins** AFK.md behavior ("searched in
order... first found wins", "If AFK_SYSTEM_PROMPT is set... AFK.md is not
loaded" framed as the ONLY exclusivity, no mention of the additive tier-3
behavior #845 shipped). This is stale documentation from #845 itself, not a
new follow-up bug — but it means users reading the public docs today get an
inaccurate description of current behavior. Worth a docs-only fix
independent of (and probably before) any of F1-F5, since it's zero-risk and
currently actively misleading.
