# Handoff Brief — shared-agent-workspace — 2026-08-18

## CONTRACT

Build a ~200-line SQLite-backed workspace prototype (`publish()` + `queryRelevant()`) wired into SubagentManager, then re-run a multi-agent task and measure whether it reduces the 59% file-read duplication baseline observed in past traces. Must not replace witness trace or memory, must pass `pnpm test`, must stay under the 350-code-line ceiling.

## CURRENT_STATE

- `.afk/research/epistemic-world-graph-research-brief.md`: DONE — evidence base with verified external projects, architecture distance map, corrected framing
- `.afk/research/shared-agent-workspace-rfc.md`: DONE — RFC with SQLite schema, 6 entry types, build order, experiment design, 5 open questions
- `.afk/research/chatgpt-transcript-epistemic-world-graph-2026-08-18.txt`: DONE — original ChatGPT conversation (30KB)
- `src/agent/workspace/workspace-store.ts`: DONE — WorkspaceStore class, SQLite :memory:, publish/queryRelevant/queryAll, 213 lines
- `src/agent/workspace/workspace-tools.ts`: DONE — workspace_publish tool schema + createWorkspaceHandlers factory, 193 lines
- `src/agent/workspace/workspace-preamble.ts`: DONE — renderWorkspacePreamble + injectWorkspacePreamble, 120 lines
- `src/agent/workspace/index.ts`: DONE — barrel export + integration plan comment
- Provider wiring (anthropic-direct + openai-compatible): DONE — WorkspaceStore accepted, forwarded, handlers registered, schemas added, close() wired
- Subagent fork wiring (nesting.ts, fork-child-config.ts, subagent.ts, fork-types.ts): DONE — workspace_publish in CHILD_ALLOWED_TOOLS, preamble injected at fork, store forwarded through SubagentManager
- Tests: DONE — 47 new tests (store: 13, tools: 10, preamble: 24), 232 existing subagent tests pass, all CI gates green
- Worktree: `.afk-worktrees/shared-workspace-v1` on branch `afk/shared-workspace-v1`, commit `386611a9`
- Measurement harness: UNTOUCHED — designed in RFC, not built
- Empirical duplication analysis: IN_PROGRESS — Aug 10 session 59% baseline cited, not persisted as artifact
- Experiment run (control vs. treatment): UNTOUCHED

## DECISIONS

- Shared typed workspace, NOT a graph database — graph needs causal routing; workspace gives immediate value
- SQLite, same pattern as memory system — lowest integration cost, no new deps
- Six entry types: Finding, Evidence, Hypothesis, Decision, Artifact, Status
- Per-root-session scope (not per-DAG)
- Explicit `publish()` via model tool, NOT auto-publish — simpler, auditable, reversible
- Retrieval is harness-managed, auto-injected into subagent context at fork — NOT a model tool in v1
- workspace_query excluded from v1 model surface to minimize agent-policy confounds in the duplication experiment
- v1 routing: keyword overlap on `subject` field + recency — honest about limitations
- NOT replacing witness trace (forensic ≠ operational) or memory (long-term ≠ per-session)
- WorkspaceStore default is `:memory:` — per-session ephemeral, no cross-session persistence
- Workspace entries injected via injectWorkspacePreamble wrapping injectToolBudgetPreamble in fork-child-config.ts
- Control baseline: Aug 10 slash-autocomplete session, 59% file-read duplication, session ID `36936341-24b8-43c0-9823-91bd6db95ffe`

## DEAD_ENDS

- Building on witness trace as state substrate — forensic log ≠ operational state
- Graph database — premature without causal routing
- A2A integration — orthogonal layer
- "Convergence" framing — ActiveGraph/MemIR/MAP-Graph solve different problems
- Reactive workspace (state changes wake agents) — deferred to build step 5; forkbomb risk
- Harvesting existing `claim` trace event — couples workspace lifecycle to trace lifecycle
- Adding workspace schemas to ALL_TOOL_SCHEMAS in schemas.ts — grew a baselined file; moved to provider-schemas.ts instead

## OPEN_QUESTION

How to wire the WorkspaceStore instance through the top-level session bootstrap (CLI, Telegram, daemon entry points) so a REAL session carries a workspace. Currently the providers fall back to `new WorkspaceStore()` when none is passed, which means every top-level session and every child session each get their own isolated store — siblings don't share. The SubagentManager forwarding is wired, but the parent's store must be the SAME instance passed to both the provider and the manager. This wiring needs to happen at the surface bootstrap level (interactive.ts, telegram handler, chat command, farm runner).
