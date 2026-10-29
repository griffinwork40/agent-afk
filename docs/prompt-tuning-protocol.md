# Prompt-Tuning Protocol

> Gate-first, leaf-first, measured rollout for `system-prompt.md` changes.
>
> **Origin:** paranoid-critic governance model from a devils-advocate analysis
> of five cache-breakage incidents in 30 days (PRs #4217, #3923, #4072, #4198,
> #4372). Formalised in issue #4450.

---

## Why this protocol exists

`system-prompt.md` propagates to every session simultaneously with no rollback
signal. The assembly pipeline is fragile to block-ordering changes and
content edits: a single bad merge can silently break prompt-cache hits across
every surface (CLI, Telegram, daemon, web) until a human notices elevated costs
or degraded behaviour in telemetry.

The existing `AFK_FRAMEWORK_PROMPT_FILE` env var already provides the
infrastructure for variant testing. The narration-directive A/B experiment
(`src/agent/narration-directive.ts:17–24`, 10 episodes per environment, 2026-09-27)
is the established template. This document formalises those patterns into a
mandatory gate-first protocol.

---

## The four pillars

### 1. Env-flag gating

Every prompt variant **must** be gated behind an env flag before it touches
any checked-in file. Use the two vars together:

| Var | Purpose |
|-----|---------|
| `AFK_PROMPT_EXPERIMENT` | Names the active experiment (e.g. `"explore-rewrite"`). |
| `AFK_PROMPT_EXPERIMENT_ARM` | Arm assignment: `"control"` or `"treatment"`. |

Typical invocation (run each arm 10 times with `afk whatif`):

```sh
# Control arm (baseline prompt)
afk whatif \
  --env AFK_PROMPT_EXPERIMENT=explore-rewrite \
  --env AFK_PROMPT_EXPERIMENT_ARM=control \
  -- <task>

# Treatment arm (candidate variant)
afk whatif \
  --env AFK_PROMPT_EXPERIMENT=explore-rewrite \
  --env AFK_PROMPT_EXPERIMENT_ARM=treatment \
  -- <task>
```

Runtime helpers (`src/agent/prompt-experiment.ts`):

```ts
import { isPromptExperimentActive, getPromptVariant } from './prompt-experiment.js';

if (isPromptExperimentActive('explore-rewrite')) {
  const arm = getPromptVariant('explore-rewrite'); // 'control' | 'treatment'
  // branch on arm …
}
```

`getPromptVariant` defaults to `'control'` when `AFK_PROMPT_EXPERIMENT_ARM` is
missing or unrecognised — a missing assignment never silently enrolls a session
in treatment.

**Never** set either var persistently in `afk.env`. A stale value blocks
every surface until removed (same failure mode as `AFK_FRAMEWORK_PROMPT_FILE`).

---

### 2. Leaf-first targeting

Test on leaf prompts **before** touching `system-prompt.md`:

1. `GENERAL_PURPOSE_PROMPT` — the general-purpose subagent prompt.
2. `EXPLORE_PROMPT` — the Explore agent prompt.
3. Surface-specific directive appends (like `NARRATION_DIRECTIVE`).
4. `system-prompt.md` — only after the leaf experiment passes.

Leaf experiments are cheaper to roll back (one file, one surface) and their
blast radius is bounded to a single agent type.

---

### 3. Measured rollout (10 episodes per arm)

Follow the narration-directive A/B template:

- **10 episodes per arm** per environment (control × 10, treatment × 10).
- Record the metric of interest for every episode (e.g. narration rate, task
  success, token cost).
- Compare arm distributions before merging the variant to the checked-in file.
- Document results in the PR body (episode counts, raw rates, delta, caveats).

Minimum evidence bar before graduating a variant to `system-prompt.md`:
- ≥ 10 episodes per arm.
- A clear directional signal on the primary metric.
- No regression on secondary metrics (cost, cache-hit rate, task success).

---

### 4. Hard veto list

The following dimensions **must not** be varied through this protocol. Changing
them risks silent cache breakage or routing regressions that are invisible until
production telemetry degrades.

| Dimension | Why vetoed |
|-----------|-----------|
| **Assembly order** of system-prompt blocks | Block reordering breaks prompt-cache hits (incidents #4217, #4072). |
| **Vendored / third-party file content** | External content is not owned by this repo; changes introduce unaudited drift. |
| **Byte-equality pins** | Sentinel sections used by the cache-breakage detector; mutating them defeats the detector. |
| **Routing-directive gates** | Tool-allow / tool-deny directives control security boundaries; A/B-ing them is a security change, not a prompt change. |
| **Runtime-numbers section** | Token budgets, limits, and timeouts are enforced at the runtime layer; prompt-level overrides are ignored and create false documentation. |

If your proposed change touches any of these dimensions, **stop** and open an
architecture issue instead. Do not use this protocol as a workaround.

---

## Rollback procedure

1. Unset `AFK_PROMPT_EXPERIMENT` and `AFK_PROMPT_EXPERIMENT_ARM` in the
   whatif environment.
2. If the variant was already merged to `system-prompt.md`, revert the commit
   and re-run `pnpm build` to regenerate the bundled prompt.
3. Verify cache-hit rate recovers within one session (check `AFK_DISABLE_PROMPT_CACHE`
   A/B tooling in `docs/architecture.md` if needed).

---

## Related infrastructure

| Resource | Purpose |
|----------|---------|
| `src/agent/prompt-experiment.ts` | Runtime helpers (`isPromptExperimentActive`, `getPromptVariant`). |
| `src/config/env.prompt-experiment.ts` | Env-registry entries for `AFK_PROMPT_EXPERIMENT` and `AFK_PROMPT_EXPERIMENT_ARM`. |
| `src/agent/narration-directive.ts` | Canonical example of a graduated prompt variant. |
| `AFK_FRAMEWORK_PROMPT_FILE` | Swaps the entire base prompt for a file path (use for full-prompt variants). |
| `afk whatif` | Episode runner — spawns isolated subprocesses per episode. |
| `docs/whatif.md` | Full `afk whatif` usage and `AFK_FRAMEWORK_PROMPT_FILE` guidance. |
