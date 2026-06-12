---
name: ground-claim
description: "Grounds capability claims with file-read evidence. Default mode answers meta-capability questions ('what does X enable') with path:line citations. Pass mode: runtime-wiring with a claims list to trace actual runtime execution paths — call sites, DI registration, middleware — and get CONFIRMED/UNVERIFIED/REFUTED verdicts per claim. Blocks sign-off on any non-CONFIRMED claim."
argument-hint: "<capability question> | mode: runtime-wiring claims: [...]"
context: load
failure_modes:
  - static_artifact_substitution
  - routing_ambiguity
---

## Trigger

**Mode: capability** (default) — Self-referential meta-capability questions about the current repository, framework, or system:
- "What does this repo enable?"
- "What are the orchestration patterns available?"
- "List the available skills."
- "What capabilities does the plugin provide?"

**Mode: runtime-wiring** — Claims that require tracing actual execution paths, not static structure:
- "Verify that middleware Y intercepts all requests."
- "Confirm plugin Z is loaded on startup."
- "Validate that feature X is active in production."

Skip both modes for: usage questions ("how do I use X?"), bug reports, feature requests.

---

## Mode: capability (default)

### Procedure

1. **Extract capability nouns.** From the user's question, identify 2–5 concrete capability categories (e.g., skills, hooks, agents, orchestration patterns, CLI commands, verification methods). Write them down.

2. **Locate and read evidence.** For each capability noun:
   - Use Glob or Grep to locate source files (e.g., `skills/*/SKILL.md` for skills, `hooks/` for hooks, `agents/` for agents).
   - Read at least one concrete source file per capability. Record the file path and specific line numbers.
   - Do not rely on training data, model recall, or session-listing attachments. Evidence must come from Read tool output.

3. **Build the answer inline.** Embed citations **within claims**, not in a separate appendix. Format: `path/to/file.md:line—<claim context>`.

4. **Tag ungrounded claims.** If a capability claim cannot be traced to a file read, prefix it with `[UNVERIFIED: what would be needed to verify this]`. Never present an unverified claim without the tag.

5. **Declare sources read.** Explicitly name which files you read in the response.

### Hard rules

- Do not answer from model recall alone.
- Do not answer from session-listing attachments without reading the underlying SKILL.md or manifest files.
- Every capability claim must point to a source. Do not summarize without citation.
- Do not bury unverified claims. Use the `[UNVERIFIED]` prefix and state the evidence gap.
- At least one `path:line` citation per named capability.

### Exit criteria

- Response contains ≥1 `path:line` citation per capability mentioned.
- Every unverified claim is explicitly tagged with `[UNVERIFIED: …]`.
- Response explicitly lists which files were read.
- No claims rest on model recall or default knowledge.

---

## Mode: runtime-wiring

Activated when the caller provides a `claims:` list and `mode: runtime-wiring`. Validates capability claims by tracing **actual runtime wiring** — call sites, DI registration, middleware registration, config manifests — not type signatures or import presence.

### Inputs

```
mode:        runtime-wiring
claims:      string[]   # natural-language claims to verify (≤20 per batch; see batching)
entrypoints: string[]   # known runtime entry files (e.g. main.ts, server.ts)
max_depth:   number     # max call-graph hops per chain (default: 8)
```

**Pre-flight gate:** If `entrypoints` is empty, abort immediately with `entrypoints_required` — do not dispatch any sub-agents. If `claims` exceeds 20 items, split into batches of 10 and run sequentially; the Qualifier aggregates across batches.

### WireTracer sub-agent (one per claim, run in parallel)

For each claim:

1. Identify the claimed behavior's implementation symbol (function, class, middleware, plugin).
2. Search for **registration or injection sites** — not import statements. Targets: DI container bindings, `app.use(...)`, `router.register(...)`, config manifests, plugin loaders, factory calls.
3. Trace forward from the entrypoint, documenting each hop: `{ file, line, symbol, role }`.
4. If a hop is missing or conditional on an env var / feature flag, record the condition and stop the chain.
5. Return:
   - `chain`: ordered `{ file, line, symbol, role }` list
   - `last_confirmed`: deepest confirmed hop
   - `gap`: missing-link description, or `null` if complete
   - `verdict`: `CONFIRMED` | `UNVERIFIED` | `REFUTED`

**Prohibited reasoning — these are NOT evidence of runtime wiring:**
- "The type implements the interface, therefore it is active."
- "The import exists, therefore it is called."
- "The function is exported, therefore it is used."

If no chain can be constructed, return `UNVERIFIED` with `gap: "no_entry_found"`. Max **3 retries** per claim (narrowing search scope each time) before final escalation to `UNVERIFIED`.

### Qualifier sub-agent

Reviews all WireTracer reports. Applies:

- **CONFIRMED** — unbroken chain from entrypoint to invocation site; no conditional gaps left unresolved.
- **UNVERIFIED** — chain breaks at an identifiable gap; return gap location and a resolution hint.
- **REFUTED** — positive evidence the symbol is excluded, overridden, or dead-code eliminated at runtime.

If Qualifier verdict disagrees with WireTracer verdict, **Qualifier wins**; discrepancy is logged.

Emits a machine-readable verdict table:

```
| Claim | Verdict | Last Confirmed Hop | Gap / Evidence |
|-------|---------|-------------------|----------------|
| ...   | ...     | ...               | ...            |
```

### Sign-off gate

Any `UNVERIFIED` or `REFUTED` verdict **blocks downstream review sign-off** and is returned to the caller with the gap location. Only an all-`CONFIRMED` table clears sign-off.

### Orchestration flow

```
entrypoints_required check → abort if empty
        │
claims (batched ≤10 if >20)
        │
        ▼
 [WireTracer × N]  ── parallel, one per claim
   (≤3 retries per claim, narrowing scope)
        │
        ▼
   [Qualifier]     ── reviews all reports, assigns verdicts
        │
   ┌────┴────────┐
CONFIRMED    UNVERIFIED / REFUTED
   │                │
sign-off OK    return gaps, block sign-off
```

---

## Out of scope

- Usage questions ("how do I use library X?") → normal research.
- Bug reports → `/diagnose`.
- Building new capability → `/mint`.
- Verification of sub-agent findings → `/shadow-verify`.
```
