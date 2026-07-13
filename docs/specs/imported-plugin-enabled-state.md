# Spec: Honor Source Enabled/Disabled State for Imported Plugins

**Type:** Feature (behavioral fix + small config-shape change)
**Repo:** Public core (`griffinwork40/agent-afk`) — land directly in the public checkout
**Branch:** `afk/imported-plugin-enabled-state` (off `origin/main`)
**Status:** Implemented — v1 (Claude-only, pure-mirror). Full suite green; opened as a PR. Design refined from the draft during implementation (AFK-index override dropped — see §3/§4).

---

## 1. Problem Statement

When a user trusts Claude Code (or Codex) via `afk migrate`, AFK live-scans that tool's plugin directory on **every** session and loads **every** plugin it finds — including plugins the user has explicitly **disabled** in the source tool. The disabled state is silently ignored.

Verified mechanism:

- `afk migrate` writes only an `importFrom` trust-flag block into `afk.config.json`; it copies nothing (`src/cli/commands/migrate.ts:6-10`). So "the plugins" are never brought into `~/.afk` — they are read in place.
- Each session, `scanAllPluginRoots()` scans four roots and reads the imported roots with `trustAll: true` (`src/agent/tools/skill-bridge.ts:351-358`).
- `trustAll` bypasses the enabled-gate entirely (`src/agent/plugins-scanner.ts:135-146`): for a trusted root, every directory containing `.claude-plugin/plugin.json` is loaded unconditionally. The scan never reads Claude Code's `enabledPlugins` or Codex's `[plugins]` state (zero `enabledPlugins` references repo-wide).
- `trustAll` was a deliberate design ("the user opted into the whole binary; AFK has no index to consult" — `plugins-scanner.ts:68-74`). Honoring the *source's own* disabled state simply fell outside that model. This is an oversight, not intent. No test covers a source-disabled plugin.

Impact: a plugin the user turned off in Claude Code still injects its skills/commands/agents into every AFK session — surprising, and (for a plugin the user disabled deliberately) unwanted.

---

## 2. Goals

1. When scanning a **trusted imported root**, skip plugins that are **disabled in the source tool**, so AFK mirrors the source's enabled/disabled state ("state stays the same"). The source tool (Claude Code) is the single source of truth for its own plugins' enabled state; AFK follows it.
2. Ship with tests for the source-disabled path (there are none today).

## 3. Non-Goals

- **No copying of plugin files** into `~/.afk`. The live-scan-in-place model stays; we only add a filter.
- **No AFK-side override for imported plugins (as-built refinement).** Foreign plugins live in the source tool's dir and are not in AFK's `.index.json`; adding an AFK toggle would create two competing sources of truth. The user manages an imported plugin's enabled state **in its home tool** (toggle in Claude Code → AFK mirrors it next session). AFK's own `~/.afk/plugins` plugins keep their existing `afk plugin enable|disable`, unchanged.
- **Codex is out of scope for v1.** Codex plugin import is detection-only today (`migrate.ts:165`); its enabled-state format is known (`~/.codex/config.toml` → `[plugins."name@marketplace"].enabled`) but wiring it is a follow-up phase.
- **No new persistence model.** No writes at all on the scan path — the filter is read-only.
- **No project/local/managed Claude settings.** Only the user-global `~/.claude/settings.json` is read (matches AFK's home-dir, cwd-independent import model — `import-sources.ts:147-156`). Repo-scoped `enabledPlugins` is not consulted.

---

## 4. Approach & Key Decisions

**Chosen approach (as-built): pure source-state mirroring for imported roots.** During implementation the "AFK-index override" from the original draft was dropped (see Non-Goals) — imported plugins aren't in AFK's index, so an override would create two sources of truth. The source tool stays authoritative; AFK reads and follows it. This is a smaller, read-only change than the drafted mirror+override.

Resolution order for a plugin in a trusted imported root (in `walk`, trusted branch):

1. **Mirror the source.** Read the source tool's enabled-map; if the plugin key is present and `false` → skip. If present and `true` → load.
2. **Else default enabled.** No source signal (no `settings.json`, plugin absent from `enabledPlugins`, empty map, or a binary with no enable-state) → load. Preserves today's behavior; backward compatible (fail-open).

### Key decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | v1 = Claude Code only; Codex deferred | Codex import is detection-only today; Claude is where the pain is. |
| D2 | Pure mirror; source tool is the single source of truth for imported plugins | Matches operator's "keep state the same"; avoids two competing toggles; keeps the scan path read-only. |
| D3 | Reuse `indexKeyForPath` (`plugins-scanner.ts:218`) to derive the plugin key | It already yields `<marketplace>:<pluginName>` for cache layout — the exact pieces needed to build Claude's `<pluginName>@<marketplace>` lookup key. No new parsing. |
| D4 | Absent-from-`enabledPlugins` ⇒ enabled (v1) | Claude's true semantics fall back to the plugin's `defaultEnabled` (default `true`). v1 approximates with "absent = enabled" and documents the edge; resolving real `defaultEnabled` per `plugin.json` is a hardening follow-up (see Open Questions). |
| D5 | Malformed/unreadable `settings.json` ⇒ fail **open** (load all) | Never let a bad source file break plugin loading; matches the defensive posture of `loadImportFromConfig` (`import-sources.ts:166-169`). |
| D6 | Tag `resolveImportedRoots().pluginRoots` with its source binary | The scanner must know which source config to consult per root. Mirror the existing `skillRoots: { dir, origin }[]` pattern (`import-sources.ts:211-216`) rather than re-deriving the binary from the path inside the scanner. |

### Format-transform (the matching key — D3)

- AFK cache-layout key (from `indexKeyForPath`): `"<marketplace>:<pluginName>"`.
- Claude `enabledPlugins` key: `"<pluginName>@<marketplace>"` (`~/.claude/settings.json`, values are booleans).
- Transform: `mp:name` ⟷ `name@mp`. Build the lookup key from the scanner's already-computed marketplace + name.

---

## 5. Interface

### 5.1 New: source enabled-state reader (`src/config/import-sources.ts`)

```ts
/** Map of source-tool plugin key → enabled. Key format is the SOURCE tool's
 *  native format (Claude: "<pluginName>@<marketplace>"). Absent key ⇒ no signal. */
export type SourceEnabledMap = ReadonlyMap<string, boolean>;

/** Read a trusted binary's own plugin enabled/disabled state. v1 implements
 *  claude-code (reads ~/.claude/settings.json `enabledPlugins`); other binaries
 *  return an empty map (no signal ⇒ default-enabled). Fail-open on any error. */
export function readSourceEnabledState(
  binary: ImportSourceBinary,
  home?: string,        // injectable for tests
): SourceEnabledMap;
```

Add a `pluginEnabledState?: (home: string) => SourceEnabledMap` field to `SourcePathMap` / `SOURCE_MAPS` (`import-sources.ts:62-92`) so the reader is table-driven per binary, consistent with `pluginRoots` / `mcpConfigCandidates`.

### 5.2 Changed: tag plugin roots by binary (`src/config/import-sources.ts`)

`ResolvedImportRoots.pluginRoots` changes from `string[]` to:

```ts
pluginRoots: { dir: string; binary: ImportSourceBinary }[];
```

Populated in `resolveImportedRoots` (`import-sources.ts:206-210`), mirroring `skillRoots`. **Consumer to update:** `src/agent/tools/skill-bridge.ts:356-357` (the only `.pluginRoots` consumer — `.mcpConfigs` / `.skillRoots` consumers are unaffected).

### 5.3 Changed: scanner accepts a source enabled-map (`src/agent/plugins-scanner.ts`)

```ts
export function scanLocalPlugins(
  dir?: string,
  opts?: { trustAll?: boolean; sourceEnabled?: SourceEnabledMap },
): SdkPluginConfig[];
```

- Thread `sourceEnabled` into `walk()`.
- In the trusted-root branch (was the `if (!trustAll)` bypass), the trusted path now gets its own block: build the source key via `sourceEnabledKey(indexKeyForPath(...))` (`mp:name` → `name@mp`); skip only when `sourceEnabled.get(key) === false`; else load. No AFK-index read on the trusted path (pure mirror).
- **Cache-key fix:** fold a stable digest of `sourceEnabled` into the scan cache key so a trusted scan with a source-disabled plugin doesn't alias a prior unfiltered result. (Within a session the map is stable, so this is a correctness guard, not a perf hit.)

### 5.4 Reused as-is (no change)

- `indexKeyForPath()` (`plugins-scanner.ts`) — key derivation, plus a new tiny `sourceEnabledKey()` helper for the `mp:name` → `name@mp` transform.
- `readIndex()` (`index-store.ts`) — unchanged; the trusted path no longer consults it (AFK's index does not track foreign plugins). `index-store.ts` and `plugin.ts` are **not touched** by this change.

---

## 6. File Map

| File | Change |
|------|--------|
| `src/config/import-sources.ts` | Add `SourceEnabledMap`, `readSourceEnabledState`, Claude `settings.json` `enabledPlugins` parser; add `pluginEnabledState` to `SourcePathMap`; change `pluginRoots` shape to `{dir,binary}[]`. |
| `src/config/import-sources.test.ts` | Tests for the reader (present/absent/disabled/malformed) + new `pluginRoots` shape. |
| `src/agent/plugins-scanner.ts` | Add `sourceEnabled` opt; apply resolution order in the trusted-root branch; fold into cache key. |
| `src/agent/plugins-scanner.test.ts` | Tests for source-disabled skip, source-enabled load, absent-default, per-plugin mirroring, cache-key non-aliasing, flat-layout key, empty-map fail-open. |
| `src/agent/tools/skill-bridge.ts` | Update the `.pluginRoots` consumer to pass `{ trustAll: true, sourceEnabled: readSourceEnabledState(binary) }` per root. |
| `docs/specs/imported-plugin-enabled-state.md` | This spec. |
| `docs/env-registry.*` | No change expected (no new env var). Run `pnpm scan:env:check` to confirm. |

---

## 7. Test Plan

Functional (new coverage — none existed before) — **all implemented & green**:

- [x] A cache plugin the source tool disabled is **not** loaded from a trusted root.
- [x] A cache plugin the source tool enabled **is** loaded.
- [x] A plugin **absent** from the source map is loaded (no signal ⇒ default-enabled).
- [x] Per-plugin mirroring in one scan (one enabled loads, one disabled skips).
- [x] `sourceEnabled` is folded into the cache key so a filtered scan does not alias a prior unfiltered trusted scan.
- [x] A flat-layout trusted plugin the source disabled is skipped (key = dir name).
- [x] An empty `sourceEnabled` map disables nothing (fail-open).
- [x] Reader: `enabledPlugins` parsed to a `name@mp → bool` map; missing / malformed / non-object / non-boolean all fail-open; Codex returns empty.

Quality gates — **all passing**:

- [x] Full suite green: 626 files, 11,389 passed / 14 skipped / 0 failed (`vitest run`).
- [x] `tsc --noEmit` clean (strict).
- [x] `pnpm audit:sdk:check` + `audit:env:check` + `scan:env:check` all pass.
- [x] No `@anthropic-ai/sdk` runtime import added (only a `type`-only import of `SourceEnabledMap` into the scanner).

---

## 8. Open Questions

1. **Q1 — `defaultEnabled` fidelity (D4).** v1 treats "absent from `enabledPlugins`" as enabled. True Claude semantics resolve absent → the plugin's `defaultEnabled` (from `plugin.json` / marketplace, default `true`, Claude ≥ v2.1.154). Ship v1 with "absent = enabled" and document, or read `defaultEnabled` per plugin now? (Recommendation: ship approximation, hardening follow-up.)
2. **Q2 — RESOLVED (docs + issue evidence).** Claude Code copies **installed** plugins to `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/.claude-plugin/plugin.json` (docs: "copies it to `~/.claude/plugins/cache`"; anthropics/claude-code#8, #14815) and keys `enabledPlugins` as `<plugin>@<marketplace>`, where the cache dir-name IS the marketplace token (#17061: `cache/superpowers-dev/` ↔ `superpowers@superpowers-dev`). This is exactly AFK's `indexKeyForPath` cache layout (`cache/<mp>/<plugin>[/<version>]` → `mp:plugin`), so the `mp:name` → `name@mp` transform matches real installs. Locked by a real-layout test. The empty `~/.claude/plugins/marketplaces/` dir is the marketplace *catalog clone*, not the installed-plugin cache (see the new observation below). Still not validated against a machine with an actually-disabled plugin (this dev machine has zero installed Claude plugins), but the path/key contract is now doc-confirmed.
3. **Q3 — RESOLVED (as-built).** The AFK-side override for imported plugins was dropped; the source tool is authoritative (see Non-Goals). No `setEnabled`/`upsertPlugin` on the scan path, so the "first-time override throws" problem no longer applies. Revisit only if a per-AFK override is later requested.
4. **Q4 — surfacing in `afk plugin list`.** Should imported (foreign-root) plugins appear in `afk plugin list` with an origin tag and their mirrored state? Nice-to-have for discoverability; not required for the core fix. Deferred.
5. **Q5 — Codex phase.** Scope the follow-up: `~/.codex/config.toml` `[plugins."name@mp"].enabled` + `features.plugins` master switch, gated on Codex plugin import graduating past detection-only.
6. **Q6 — `marketplaces/` catalog over-inclusion (pre-existing, separate).** Observed during validation: `~/.claude/plugins/marketplaces/<mp>/` is a full clone of the marketplace repo (its `plugins/<name>/` may contain `.claude-plugin/plugin.json` for *non-installed* catalog entries). The existing `trustAll` scan may therefore already load catalog plugins that were never installed — independent of enabled state. This fix does not address it (a plugin under `marketplaces/…` derives a flat key, not `<name>@<mp>`, so it isn't matched against `enabledPlugins`). Not a regression from this change; flagged as a distinct follow-up (the scan arguably should only descend `cache/`, not `marketplaces/`, for imported Claude roots).

---

## 9. Epistemic Confidence

- **High** — the current mechanism and every cited file:line (scan path, `trustAll` bypass, existing enable/disable infra, key derivation). Read directly from source this session.
- **High** — source formats: Claude `~/.claude/settings.json` `enabledPlugins: {"name@marketplace": bool}` and Codex `config.toml` `[plugins]` (official docs + Codex Rust source `config_toml.rs`).
- **High (upgraded from Medium)** — the `marketplace` token equivalence (Q2). Claude's own docs confirm installed plugins live at `~/.claude/plugins/cache/<mp>/<plugin>/<version>/` and issue #17061 shows the cache dir-name is the `@<marketplace>` token in `enabledPlugins` — exactly AFK's cache-layout key. Locked by a real-layout unit test. Residual: not exercised against a machine with an actually-disabled installed plugin (none on this dev box); failure mode is fail-open (over-inclusion), never a crash.
- **Observation** — `~/.claude/plugins/marketplaces/` (catalog clone) vs `cache/` (installed) distinction surfaced a separate pre-existing over-inclusion question (Q6), out of scope here.
- **Time-sensitive** — both plugin systems are evolving; field *names* are stable but *precedence* rules are in flux (Claude project/local/managed scopes; Codex curated/remote account-synced state). v1 deliberately scopes to user-global Claude only to sidestep this.
- **Human judgment needed** — Q1 (defaultEnabled fidelity vs. ship-now) and Q4 (list surfacing) are product calls, not code-forced.
