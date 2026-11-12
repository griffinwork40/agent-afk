# ADR: Episode Recall Delivery Mechanism

**Status:** Accepted  
**Issue:** #4680  
**Date:** 2026-11-05  
**Supersedes:** PR #4614 (episode recall via `hotMemory`)

---

## Context

PR #4614 introduced episode recall — surfacing compressed narratives from prior
sessions that are relevant to the current git context (branch name, recently
modified files). The implementation appended the `<recent-episodes>` block to
`config.hotMemory`, placing it in the same system-prompt slot as HOT.md.

This conflates two distinct epistemic registers:

| Register | Source | Epistemic status |
|---|---|---|
| HOT.md (`hotMemory`) | Operator-curated | Authoritative; human-edited facts |
| Episode recall | LLM-synthesized | Probabilistic; may be stale |

A secondary consequence: because `hotMemory` is part of the **stable prefix**
(the portion of the system prompt before `# Environment` that the provider
caches), sessions with different episode sets get distinct prefix hashes, and no
session can read a cache entry written by another. As the episode archive grows
(target: 50+ episodes), this cache thrash becomes significant.

## Decision

Implement **Alternative 1**: add a dedicated `episodeRecall?: string` field to
`AgentConfig` and place it in the **volatile tail** of the system prompt, after
`# Environment` and the skill manifest.

### Prompt ordering (after this ADR)

```
1. toolBase          — tool/runtime conventions
2. userSystem        — # Agent AFK doctrine + operator overlay
3. memoryPrompt      — cross-session-memory instructions
4. workspacePrompt   — shared-workspace usage (when enabled)
5. hotMemory         — <cross-session-memory> HOT.md block
5b. goalPrompt       — <active-goal> persistent objective (when set)
6. # Environment     — cwd/session/workspace (recomputed per cwd) ← cache boundary
7. manifest          — skill/agent catalog
8. agentTypeListing  — dynamic agent-type listing
9. episodeRecall     — <recent-episodes> block  ← NEW position
```

Steps 1–5b form the **stable prefix** that the provider caches. Steps 6–9 are
the **volatile tail** that varies per session. `episodeRecall` is placed last in
the volatile tail because it varies maximally across sessions (different git
contexts produce different episode sets).

## Alternatives Considered

### Alternative 0 (status quo): append to `hotMemory`

Episodes were appended to `config.hotMemory` after the HOT.md block.

**Rejected because:**
- No structural separation between curated context and probabilistic recall
- LLM-synthesized content in the same field as operator-edited facts degrades
  epistemic clarity for the model
- Invalidates the stable-prefix cache for every session with a different episode
  set, eliminating cross-session cache sharing even when HOT.md is identical

### Alternative 1 (chosen): dedicated `episodeRecall` field, volatile tail

A new `episodeRecall?: string` field on `AgentConfig`. Providers place it at
position 9, after `# Environment` and `agentTypeListing`.

**Accepted because:**
- Structural separation: `hotMemory` remains operator-curated; `episodeRecall`
  is clearly LLM-synthesized
- Correct epistemic positioning: volatile, session-specific content lives in
  the volatile tail alongside other per-session data (`# Environment`)
- Preserves the stable-prefix cache: sessions sharing the same HOT.md, doctrine,
  and skill manifest can share prefix cache entries even with different episode sets
- Minimal change: one new optional field, no protocol or storage changes

### Alternative 2: synthetic turn-zero message (bridge delivery)

Deliver episode recall as a synthetic assistant/user turn injected before the
first real user message, making it structurally subordinate to the live task.

**Deferred because:**
- Larger architectural change requiring bridge modifications across all surfaces
  (REPL, Telegram, daemon)
- Resume semantics become more complex (the synthetic turn must not appear in
  the replay history)
- Alternative 1 achieves the primary goals (epistemic separation, cache
  preservation) with significantly less risk
- Alternative 2 remains viable as a future upgrade if stronger subordination
  signaling proves necessary (e.g. >50 episodes with high recall hit rates)

## Consequences

**Positive:**
- `config.hotMemory` is now strictly operator-curated HOT.md content
- Episode recall content is explicitly positioned as volatile/probabilistic
- Stable-prefix cache is preserved across sessions with different episode sets
- The separation is enforced structurally (two distinct fields), not by
  documentation convention

**Neutral:**
- Both the anthropic-direct and openai-compatible providers were updated in
  lockstep; the ordering invariant is documented in both
- `PromptFragments` and `logStablePartsTokens` gain an `episodeRecall` key
  for trace-level token-count visibility

**Negative / Risk:**
- `episodeRecall` now appears after `# Environment`, so the model sees it after
  the cwd/session/workspace block rather than alongside HOT.md. This is
  intentional (volatile tail) but slightly changes the prompt reading order the
  model experiences. No regression is expected — episodes carry their own
  `<recent-episodes>` wrapper and are explicitly marked as potentially stale.

## Implementation

- `src/agent/types/config-types.ts`: add `episodeRecall?: string`
- `src/agent/memory/memory-loader.ts`: `injectEpisodeRecall` writes to
  `config.episodeRecall` instead of appending to `config.hotMemory`
- `src/agent/providers/anthropic-direct/query/system-prompt.ts`: add
  `episodeRecall` to `StableSystemPromptInputs`; emit it last in `assembleSystemPrompt`
- `src/agent/providers/anthropic-direct/query/prompt-assembly.ts`: forward
  `config.episodeRecall` to `buildStableSystemPrefix`
- `src/agent/providers/openai-compatible/system-prompt-wiring.ts`: read
  `config.episodeRecall`; emit it last in `assemble`
- `src/agent/providers/shared/prompt-fragment-tokens.ts`: add `episodeRecall`
  to `PromptFragments` and `logStablePartsTokens` for trace visibility
- Tests updated in `memory-loader.inject.test.ts` and
  `query/system-prompt.test.ts`
