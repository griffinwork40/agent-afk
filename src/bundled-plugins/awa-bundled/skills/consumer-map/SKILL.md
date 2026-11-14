---
name: consumer-map
description: "Read-only consumer graph and blast-radius analysis — takes either a diff (PR number, patch file, git diff) or a named target (symbol, module, config key) and maps the full consumer surface: direct callers, transitive importers (depth 2), test/config/schema refs, hot paths, and event-pipeline members. Emits a scored Impact Report with a PROCEED / NARROW_SCOPE / HUMAN_GATE verdict before any mutation. Replaces blast-radius and impact-map with a single skill covering both entry points."
argument-hint: "<PR-number | diff-file | symbol | module | config-key> [--repo <path>] [--symbols <comma-list>]"
skills: [contract]
allowed-tools: bash, read_file, grep, glob, agent
failure_modes:
  - diff mode: no diff artifact obtainable (verbal description only, no PR/patch/diff)
  - diff mode: symbols_changed list incomplete (renamed vs. deleted not distinguished)
  - target mode: ambiguous target (multiple symbols share the name across packages)
  - probe context leak (framing or diff hunks accidentally included in probe prompt)
  - uncovered entries in report (verdict emitted before all files/symbols accounted for)
  - verdict ignored and mutations proceed without operator acknowledgment
---

## Overview

`consumer-map` is a pure decision-support skill. It never edits files, never commits changes, and never dispatches write-path skills. Its sole artifact is an Impact Report with a machine-readable verdict.

Two input modes, one pipeline:

- **Diff mode** — pass a PR number, patch file, or `git diff` output. The skill parses the diff to extract `files_touched` and `symbols_changed`, then maps their consumer surface. Use when you have a change and want to know what it hits.
- **Target mode** — pass a symbol name, module path, config key, environment variable, API endpoint, or schema column. The skill resolves the target to concrete file paths and exported symbols, then maps their consumer surface. Use when you are considering a change and want to know who depends on the target.

If the input is ambiguous — a bare number that could be a PR or a line count, a name that matches multiple distinct entities — the skill stops and asks for disambiguation before dispatching any probes.

---

## Wave 1 — Input normalization (inline, ≤5 tool calls, no agent dispatch)

**Diff mode:**
Fetch the diff artifact (via `git diff`, `gh pr diff <N>`, or a passed file path) and parse it directly. Emit a structured manifest:

```json
{ "files_touched": [...], "symbols_changed": [...], "hunk_map": { "<file>": [[start, end], ...] } }
```

`symbols_changed` captures: functions renamed or deleted, exported types modified, function signatures altered. If no diff artifact is obtainable:

> `BLOCKED: no diff artifact — run \`git diff\` or \`gh pr diff <N>\` and pass the output, or use target mode with a symbol name`

**Target mode:**
Resolve `<target>` to a canonical name, source file, and type (function / module / type / config key / env var / schema column / other). Populate `files_touched` with the target's source file(s) and `symbols_changed` with the target's exported names.

If `<target>` is ambiguous — multiple symbols share the name across packages or the string matches more than one distinct entity — halt immediately and request disambiguation. Do not guess.

No probe dispatch occurs before Wave 1 completes and emits a non-empty manifest.

---

## Wave 2 — Parallel consumer probes (3 agents, simultaneous dispatch, context-blind)

All three agents are dispatched in a single tool-use block. Each is read-only and scoped to a single consumer class. Each receives only `files_touched` and `symbols_changed` from the Wave 1 manifest — **no patch framing, no bug description, no diff hunks, no stated intent of the change**. The denial of framing is the mechanism: probes cannot confirm what they cannot see.

**Probe A — Direct callers and importers**
For each symbol in `symbols_changed`, grep the entire repo for call sites, imports, and type references. For each file in `files_touched`, find direct importers. Returns:
- `callsites` — deduplicated `file:line:snippet` list, grouped by file
- `hot_paths` — callsites that reach user-facing surfaces, public APIs, or test fixtures
- `missing_coverage` — symbols with zero test-file callsites
- `event_pipeline_members` — if any touched file participates in an event/message pipeline, name the chain

Covers source files only (excludes test and config files — those are Probe C's domain).

**Probe B — Transitive consumers (depth 2)**
For each direct consumer file found by Probe A's methodology (re-derived independently — Probe B does not see Probe A's output), find their callers and importers one level up. Returns:
- `transitive_consumers` — second-order impact list with `file | importer_count | hub` per entry
- `hub` flag: files imported by ≥5 other modules

Stops at depth 2 to bound scope. If depth-2 fan-out exceeds 80 files, truncate and note `TRANSITIVE_OVERFLOW`.

**Probe C — Test, config, schema, and CI consumers**
Search test files, fixture data, env files, `.env.example`, CI config, migration files, schema definitions, and any JSON/YAML/TOML config referencing any symbol or file from the manifest by name or key. Returns separate sub-lists:
- `test_sites` — test files that exercise the target
- `mock_sites` — mocks, stubs, or fixture data referencing the target
- `config_keys` — config, env, or schema references
- `migration_refs` — migration files touching the target
- `ci_refs` — CI/CD config referencing the target

---

## Wave 3 — Synthesis gate (inline, no agent dispatch)

After all three probes complete, merge and deduplicate across all maps.

**Completeness check:** every entry in `files_touched` and every symbol in `symbols_changed` must appear in at least one report section before a verdict is emitted. A report with uncovered entries is incomplete — loop back to targeted re-probing (max one additional pass) before declaring `BLOCKED: incomplete coverage`.

**Classify every site:**

| Class | Source |
|---|---|
| `DIRECT` | Probe A direct import/call site |
| `TRANSITIVE` | Probe B second-order consumer |
| `TEST` | Probe C test or mock site |
| `CONFIG` | Probe C config, env, schema, or migration ref |
| `EXTERNAL` | Any site outside the repo root (submodule, vendored dep) |

**Compute impact score:**

```
score = (direct_count × 3) + (transitive_count × 1) + (test_count × 0.5) + (config_count × 0.5)
```

**Map score to tier:**

| Score | Tier |
|---|---|
| < 5 | `LOW` |
| 5–14 | `MEDIUM` |
| 15–39 | `HIGH` |
| ≥ 40 | `CRITICAL` |

**Map tier to verdict:**

| Tier | Verdict |
|---|---|
| `LOW` or `MEDIUM` | `PROCEED` — consumer surface is well-understood |
| `HIGH` | `NARROW_SCOPE` — recommend scoping the change to a subset of consumers before invoking a write-path skill |
| `CRITICAL` | `HUMAN_GATE` — do not dispatch refactor/forge/mint until a human reviews the report |

---

## Output structure

Emit a single structured Impact Report:

```
## Impact Report

### Input mode                    ← diff | target
### Files touched (N)             ← from Wave 1
### Symbols changed (N)           ← from Wave 1
### Consumer map                  ← table of file | class | distance | hub | safe-to-ignore
### Hot paths at risk             ← callsites reaching public API / user surface (Probe A)
### Blast-radius amplifiers       ← shared utilities (≥3 importers) + event pipeline members (Probe A)
### Transitive reach              ← hub files + depth-2 fan-out summary (Probe B)
### Test and config surface       ← test_sites, mock_sites, config_keys, migration_refs, ci_refs (Probe C)
### Coverage gaps                 ← symbols with zero test callsites (Probe A)
### Safe zones                    ← modules/directories confirmed to have no dependency on the target
### Impact tier                   ← LOW | MEDIUM | HIGH | CRITICAL with score breakdown
### Verdict                       ← PROCEED | NARROW_SCOPE | HUMAN_GATE
```

For `NARROW_SCOPE`: append a **Regression test list** — the specific test files and test names that cover the affected callsites, derived from Probe A's `callsites` map and Probe C's `test_sites`. These are mandatory reading for anyone applying the change.

---

## Decision gates

- **Ambiguous input** → stop before Wave 1, request disambiguation. Do not guess.
- **CRITICAL tier** → emit `HUMAN_GATE` and halt. Do not chain into any write-path skill automatically.
- **TRANSITIVE_OVERFLOW** → flag in report, cap transitive list at 80 entries, note that the true impact is larger than scored.
- **Empty result** (zero consumers found) → report `LOW` tier but note the search surface so the caller can judge whether the grep was exhaustive.
- **Incomplete probe** — if any Wave 2 probe does not return within its timeout, mark that consumer class as `INCOMPLETE` in the report rather than silently omitting it. An `INCOMPLETE` class cannot count toward a `PROCEED` verdict — the tier is computed on known data, but the verdict is capped at `NARROW_SCOPE` until the incomplete class is resolved.
- **Uncovered entries** — if the completeness check fails after one re-probe pass, emit `BLOCKED: incomplete coverage` rather than a tier verdict on partial data.
