# Feature Specification: Centralized Env Module + Generated Registry

**Type:** Refactor + Feature | **Saved to:** `docs/specs/env-flag-registry.md`

---

## Decision Log

This spec went through `/devils-advocate` after first draft. The original "daily PR + scanner" design ranked 11/25 vs. the chosen "centralized config module" at 16/25 (Architect option). Concrete drops based on critique:

- **Dropped the daily cron / bot PR machinery.** Bot-authored PRs train auto-merge habits; drift should fail CI at commit time, not open a PR tomorrow. Matches the repo's existing `audit:sdk` precedent.
- **Dropped RELEASE_PAT reuse.** Doc maintenance ≠ release pipeline privileges; no new PAT scope needed.
- **Dropped ESLint.** The repo has no ESLint config (only `tsc --noEmit`). Adding ESLint just for one `no-restricted-syntax` rule is overkill. Substituted: a TypeScript audit script that mirrors `scripts/audit-sdk-dependency.ts` exactly.
- **Kept the centralized module idea (Architect's recommendation).** Single source of truth, typed, future-proof for runtime validation.

---

## Problem Statement

`agent-afk` has **77 distinct env vars across 171 `process.env[...]` reads** scattered through `src/`, with no single source of truth. `docs/reference.md` documents ~20 of them and admits the rest live in `src/`. The result: drift, no machine-readable catalogue, and no future path to runtime validation that wouldn't require touching every call site again.

This spec replaces the scattered reads with a single typed module, makes the registry a derived artifact, and gates new direct `process.env` reads at CI time.

---

## Scope

### In scope

1. **`src/config/env.ts`** — single module with:
   - `env` object: typed lazy property getters, one per env var. `env.AFK_MODEL` replaces `process.env['AFK_MODEL']` at every call site.
   - `ENV_REGISTRY` const: array of typed metadata records (name, description, type, required, default, example, category).
   - Returns raw strings; parsing (`parseInt`, boolean coercion) stays at call sites for now. Runtime validation is a future change isolated to this file.

2. **Migration of 171 call sites** across ~50 files. Mechanical text replacement: `process.env['X']` → `env.X`, with `import { env } from '<path>/config/env.js'`. Parallelized across 4–5 directory clusters.

3. **`scripts/audit-env-access.ts`** — mirrors `scripts/audit-sdk-dependency.ts` pattern:
   - Scans `src/` for any `process.env.*` reference outside `src/config/env.ts`.
   - Maintains a small allowlist for legitimate dynamic-access call sites (e.g., `src/agent/tools/handlers/bash.ts` forwards `process.env` to child processes).
   - `--check` mode (CI): exit nonzero on unauthorized direct reads.
   - Default mode: emit drift report.

4. **Generated artifacts** — `scripts/render-env-registry.mjs`:
   - Reads `ENV_REGISTRY` from `src/config/env.ts`.
   - Writes `docs/env-registry.json` (machine-readable) and `docs/env-registry.md` (human table).
   - Run via `pnpm scan:env`; committed to git so docs stay in sync.

5. **CI integration**: add `pnpm audit:env:check` step to `.github/workflows/ci.yml` `lint-build` job, alongside existing `pnpm lint`.

6. **`/doctor` integration**: import `ENV_REGISTRY` directly from `src/config/env.ts`; warn only on `required: true` vars absent at startup. **Drop** the unknown-var warning (per synthesis: noise on launch).

7. **`docs/reference.md`** env-var section → replaced with a pointer to `docs/env-registry.md`.

### Out of scope

- **Runtime feature-flag library** (no `isEnabled('AFK_FOO')` toggle abstraction). This is a discovery/catalogue layer.
- **Zod/typebox runtime validation.** The module is structured to make this a future single-file change.
- **Plugin env vars.** Plugins live under `~/.afk/plugins/`; tracking them requires their own scanner.
- **`example-plugin` env vars.** Different repo.
- **Daily PR automation.** Dropped — drift fails CI, doesn't accumulate.

---

## Module Shape

```typescript
// src/config/env.ts

export interface EnvVarMeta {
  name: string;
  description: string;
  type: 'string' | 'number' | 'boolean' | 'json';
  required: boolean;
  default?: string;
  example?: string;
  category: 'model' | 'auth' | 'telegram' | 'paths' | 'debug' | 'daemon' | 'worktree' | 'misc';
}

export const ENV_REGISTRY: readonly EnvVarMeta[] = [
  {
    name: 'AFK_MODEL',
    description: 'Override the Anthropic model for agent turns. Accepts short aliases or full model IDs.',
    type: 'string',
    required: false,
    default: 'sonnet',
    example: 'claude-opus-4-5',
    category: 'model',
  },
  // ... 76 more
];

/**
 * Single read-point for every env var the runtime touches. Lazy property
 * getters mean tests that mutate `process.env` (and runtime dotenv loaders
 * that fire after import) see the live value on access.
 *
 * Migration target: every `process.env['X']` outside this file should be
 * replaced with `env.X`. CI gate: `pnpm audit:env:check`.
 */
export const env = {
  get AFK_MODEL(): string | undefined { return process.env['AFK_MODEL']; },
  // ... 76 more
};
```

**Why lazy getters, not eager constants:**
- Tests mutate `process.env` per-case via `beforeEach`. Eager constants would freeze test state at import time.
- `dotenv` may not have loaded at import time (it loads inside `loadConfig()`); eager reads would see undefined.
- Mirrors the existing `loadCredential()` pattern in `src/cli/config.ts`.

**Why raw strings, not parsed types:**
- Migration stays mechanical and one-pass; no decisions about parse semantics per-site.
- Parsing logic already lives at call sites (`parseInt`, `=== '1'`, `.toLowerCase()`); leave it there.
- Future runtime-validation refactor is then orthogonal: change `env.X` to return parsed types, update call sites in a second pass.

---

## Audit Script Contract

```typescript
// scripts/audit-env-access.ts (mirrors audit-sdk-dependency.ts)

const ALLOWED_DIRECT_ACCESS = [
  'src/config/env.ts',             // the module itself
  // Add other call sites with explicit comments. Allowlist intentionally small.
];

// Plus inline allowlist entries (with rationale) for:
//   - src/agent/tools/handlers/bash.ts  forwards process.env to child process
//   - src/agent/tools/handlers/web-scrape.ts  takes env as injectable opt
```

Scanner finds any TS file matching `process\.env\.\w+|process\.env\[['"][\w_]+['"]\]` outside the allowlist. CI gate exits nonzero on unauthorized hits.

---

## Migration Wave Plan

Sequential phases 1 & 2 (foundation), then phase 3 is **parallel waves** by directory cluster. Each wave is independent and gets the same instructions.

| Phase | Work | Parallel | Duration |
|-------|------|----------|----------|
| 1 | Write `src/config/env.ts` (registry + env object) | No | Sequential |
| 2 | Write `scripts/audit-env-access.ts` + `scripts/render-env-registry.mjs` | No | Sequential |
| 3 | Migrate call sites — 5 directory clusters | **Yes (5-way)** | Parallel |
| 4 | Wire CI + package.json scripts + `/doctor` + `docs/reference.md` | Partial | Mostly parallel |
| 5 | Verify: `pnpm lint && pnpm test && pnpm audit:env:check` | No | Sequential |

**Wave clusters** (phase 3):
- W1: `src/cli/**/*.ts` (excluding `src/cli/config.ts` which gets manual care)
- W2: `src/agent/tools/**/*.ts` + `src/agent/providers/**/*.ts`
- W3: `src/agent/mcp/**/*.ts` + `src/agent/session/**/*.ts` + `src/agent/trace/**/*.ts`
- W4: `src/telegram/**/*.ts`
- W5: `src/skills/**/*.ts` + `src/improve/**/*.ts` + `src/utils/**/*.ts` + remaining root

---

## Success Criteria

1. `pnpm audit:env:check` passes — every `process.env` read in `src/` is either inside `src/config/env.ts` or in the explicit allowlist with rationale.
2. `pnpm lint` (`tsc --noEmit`) passes.
3. `pnpm test` — all existing tests pass; new test verifies `ENV_REGISTRY` and `env` object stay in sync (every getter key has a matching registry entry).
4. `docs/env-registry.json` and `docs/env-registry.md` regenerate idempotently — two runs of `pnpm scan:env` produce zero diff.
5. CI workflow runs `pnpm audit:env:check` on every push.
6. `/doctor` warns when a `required: true` var is absent at startup.
7. `docs/reference.md`'s env-var section is a one-liner pointer to `docs/env-registry.md`.
8. The "ADR" note in `src/config/env.ts` JSDoc explicitly identifies this as the foundation for future runtime validation (zod/typebox), so the next refactor is single-file.

---

## Key Constraints

| Constraint | Detail |
|---|---|
| **No new runtime dep** | Audit script + registry renderer are `.ts`/`.mjs` in `scripts/`, never imported by runtime. |
| **No new dev dep** | Reuse `typescript` (already there) and existing `tsx` runner. No ESLint, no AST library — regex + TypeScript Compiler API like `audit-sdk-dependency.ts`. |
| **Idempotent generation** | `docs/env-registry.json` sorted alphabetically by `name`; re-run produces zero diff. |
| **Backward compat** | The migration touches no behavior — every `env.X` access returns the same value `process.env['X']` did. Tests should not break. |
| **Drop the daily PR** | Drift is a build break, not a tomorrow problem. |
| **Audit allowlist stays tiny** | Only 3–4 known dynamic-access sites get exceptions; each has an inline `// audit-env-access: allow ...` comment with rationale. |

---

## ADR Note (lands inside `src/config/env.ts` JSDoc)

> This module is the single read-point for every environment variable the
> runtime consumes. Today it returns raw strings; parsing happens at call
> sites for back-compat. The intended next refactor is to wrap each getter
> in a zod schema (`z.string().optional().parse(process.env.X)` etc.) so
> runtime validation surfaces at startup, not at first-use. That refactor
> is a single-file change here — no call site needs to update unless the
> parse semantics change.

---

## Risk Register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Migration introduces subtle regressions (typo in var name, missed call site) | Medium | Per-wave `pnpm lint && pnpm test` before merging waves; final `pnpm audit:env:check` catches misses. |
| Dynamic env access (e.g., `process.env[key]` in loops) gets accidentally rewritten | Low | Allowlist is explicit and small; agents instructed to skip ambiguous patterns and report them. |
| `dist/` build needs the JSON registry but `docs/env-registry.json` isn't copied | Low | `/doctor` reads `ENV_REGISTRY` directly from `src/config/env.ts` (compiled to `dist/`), not from a JSON file — no copy step needed. |
| Future contributor adds new `process.env` outside the module | Low | CI gate catches it on PR; merge is blocked. |
| Tests that mock `process.env` break because of lazy getter caching | Very Low | Lazy getters re-read every access — no caching layer, no staleness. |
