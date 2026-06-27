# Parity: agent-afk vs. the Claude Agent SDK

> Assessment date: 2026-06-26. Method: parallel research (external docs lane +
> local code lane), then independent shadow-verification of the load-bearing
> claims (3/3 CONFIRMED via independent re-derivation). Gap-closing plan:
> `.afk/plans/agent-sdk-parity.md`.

## Bottom line

agent-afk does **not** use Anthropic's Claude Agent SDK
(`@anthropic-ai/claude-agent-sdk`). It independently reimplements the same agent
harness on the raw `@anthropic-ai/sdk` Messages API and — unlike the SDK — also
on OpenAI-compatible / local model backends. Measured against the SDK's surface:

- **~80–85% runtime / capability parity** — the harness does almost everything
  the SDK's harness does, and is ahead on several axes.
- **~50–60% "usable as a published SDK" parity** — it *is* importable
  (`src/index.ts` exports `AgentSession`, `SubagentManager`, providers, ~40
  types), but there is no one-shot `query()`, no `exports`/`types` in the
  manifest, and no in-process custom-tool API.

The two are partly apples-to-oranges: the Agent SDK is a **Claude-only wrapper
around a closed binary**; agent-afk is a **multi-provider, fully-open,
modifiable** harness. "Parity" undersells the latter — the remaining gaps are
the ones worth closing if outside developers are to adopt agent-afk *as an SDK*.

## Dimension-by-dimension matrix

| # | Dimension | Claude Agent SDK | agent-afk | Parity |
|---|-----------|------------------|-----------|--------|
| 1 | Entry point | `query({prompt, options})` one-shot + async-iterable streaming input | `new AgentSession(config)` → `sendMessage` / `sendMessageStream`; exported from `src/index.ts` | ◑ Partial — library yes, no one-shot |
| 2 | Options bag | Large flat `Options` | `AgentConfig`: model, systemPrompt, maxTurns, tools allow/deny, mcp, hooks, permissionMode, canUseTool, maxBudgetUsd, resume/fork/persist, autoCompact, depth | ● High |
| 3 | Streaming events | `SDKMessage` union + opt-in `stream_event` partials | `ProviderEvent` union (delta.text/reasoning, tool.use/output, turn.completed+usage, paused/resumed) | ● High |
| 4 | **Custom tools** | `tool()` + `createSdkMcpServer()`, in-process, Zod | No per-tool registration; only whole-provider override or external MCP | ○ Gap |
| 5 | External MCP | stdio/http/sse(+proxy) + runtime reconnect/toggle | stdio/streamable-http/sse/oauth, 4-tier config layering, `list_changed` refresh | ● High |
| 6 | Hooks | ~12 core events incl. PreCompact, Notification, PermissionRequest, PostToolBatch | 9 dispatched: SessionStart/End, SubagentStart/Stop, PreToolUse, PostToolUse, PostToolUseFailure, Stop, UserPromptSubmit | ◑ Partial |
| 7 | Subagents | `agents` option + fs agents + supportedAgents() | `SubagentManager.forkSubagent` w/ permission bubbling, abort graph, Zod schema, depth=3, + compose/DAG | ● Full / ahead |
| 8 | Permissions | modes default/acceptEdits/plan/bypass/dontAsk/auto; canUseTool; rules-engine | phaseRole read-only, permissionMode, canUseTool, categorizeTool gating, permissionBubbler | ◑ Partial — no persisted rules-engine |
| 9 | Sessions | resume/continue/fork/persist + listSessions/rename/tag/delete + auto-compact | resume/continue/fork/persist + compact/autoCompact + reset | ● High — no standalone session CRUD |
| 10 | System prompt | preset `claude_code` vs custom + append | framework base + operator overlay (append-only), raw string | ● Equivalent, inverted model |
| 11 | settingSources | explicit `["user","project","local"]` selector | config tiers (env / cwd json / global json / AFK.md) + 4-tier mcp; field exists but is a pass-through stub | ◑ Partial |
| 12 | Slash commands | built-in + custom + supportedCommands() + commands_changed | slash registry + plugin commands + Levenshtein dispatch; no library add/remove API | ◑ Partial |
| 13 | Model / fallback | alias/id + `fallbackModel` + setModel + effort + thinking — Claude-only | 5-tier `providerForModel` across Anthropic + OpenAI-compatible + local, slots, effort/thinking; no auto-fallback | ● Ahead on multi-provider, behind on auto-fallback |
| 14 | Cost & usage | total_cost_usd + per-model usage + maxBudgetUsd | totalCostUsd/turn + session running cost/tokens + maxBudgetUsd + BudgetExceededError | ● High |
| 15 | Abort/interrupt | AbortController + interrupt() + close() + stopTask | AbortGraph (transitive parent→child cascade, child→parent notify) + typed errors | ● Full / ahead |
| 16 | **Structured output** | `outputFormat: json_schema` on the main query, w/ retry | Zod `outputSchema` on subagents only; absent on `sendMessage` | ◑ Partial |

● Full/High · ◑ Partial · ○ Gap

## Gaps that matter (ranked, for "build-your-own-agent" use)

1. **In-process custom tools (Dim 4).** The SDK's `tool()`/`createSdkMcpServer()`
   is the headline "extend the agent" primitive. agent-afk has no append-a-tool
   API — the only construction-level seam is supplying a custom `provider`
   (`AgentConfig.provider`, which carries its own dispatcher) or wiring an
   external MCP server. **Precise framing (per shadow-verify):** the gap is "no
   ergonomic per-tool `tool()`-style registration," *not* "impossible to add a
   tool" — `src/agent/index.ts` does export `SessionToolDispatcher` +
   `createBuiltinHandlers`, so a determined consumer can rebuild a dispatcher.
2. **Programmatic packaging (Dim 1).** No `query()` one-shot, and `package.json`
   lacks `"exports"` + `"types"` (the `dist/*.d.ts` files already build — they're
   just undeclared). Type resolution is bundler-dependent under nodenext.
3. **Structured output on the main turn (Dim 16).** Exists for subagents
   (`ForkSubagentOptions.outputSchema`), absent on `sendMessage`; no json-schema
   retry loop.
4. **Hook coverage (Dim 6).** `PreCompact` (persist artifacts before
   compaction), `Notification`, `PermissionRequest` are the meaningful
   absentees.
5. **Permission rules-engine (Dim 8).** `canUseTool` + read-only phase gating
   exist, but not persisted allow/deny/ask rule lists with settings-tier
   destinations.

## Where agent-afk is ahead

- **Multi-provider / local models (Dim 13).** The Agent SDK is Claude-only (it
  shells out to the Claude Code binary); agent-afk routes to OpenAI-compatible
  and local MLX/llama.cpp/vLLM runners. The SDK structurally cannot match this.
- **Orchestration (Dim 7).** A real `compose`/DAG executor with layered
  parallelism + fail-fast, beyond the SDK's Agent tool.
- **Transitive abort graph (Dim 15).** More sophisticated than a single
  AbortController.
- **Pure-TS, fully modifiable** — no opaque binary; you own the loop.

## Evidence & verification

- External lane: HIGH coverage from the official docs
  (`code.claude.com/docs/en/agent-sdk/*`). Likely *over*-counts hooks (~20,
  including newer agent-teams/worktree events); the meaningful core gap is the
  3–4 events named above.
- Local lane: HIGH — four load-bearing claims independently re-verified
  (`src/index.ts` exports; `package.json` has no `exports`/`types`;
  `HarnessHookEvent` = 9 events at `src/agent/hooks.ts:44`; no `query()` export).
- Shadow-verify: 3/3 CONFIRMED (Dim 4 absence, Dim 16 subagent-only,
  SDK-side `tool()`+`outputFormat` existence), all `independent-rederivation`.
