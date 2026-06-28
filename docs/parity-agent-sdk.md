# Parity: agent-afk vs. the Claude Agent SDK

> Assessment date: 2026-06-26. Method: parallel research (external docs lane +
> local code lane), then independent shadow-verification of the load-bearing
> claims (3/3 CONFIRMED via independent re-derivation). Gap-closing plan:
> `.afk/plans/agent-sdk-parity.md`.
>
> **Progress (updated 2026-06-26).** Top-3 ranked gaps now CLOSED on branch
> `feature/agent-sdk-parity`:
> - Dim 1 packaging + `query()`/`queryText()`/`queryStructured()` — `596da10`, `00298f3`
> - Dim 4 in-process custom tools (`tool()` helper) — `be6d011`
> - Dim 16 main-turn structured output (`sendMessageStructured`) — `00298f3`
>
> Certified by the full suite: 10,161 pass / 14 skip / 2 pre-existing env fails
> (config slot-bindings, anthropic compact — both unrelated), coverage thresholds
> met, `audit:sdk:check` green (no new SDK symbols — zod only). Next: Dim 6
> `PreCompact` hook. Not yet pushed / no PR.

## Bottom line

agent-afk does **not** use Anthropic's Claude Agent SDK
(`@anthropic-ai/claude-agent-sdk`). It independently reimplements the same agent
harness on the raw `@anthropic-ai/sdk` Messages API and — unlike the SDK — also
on OpenAI-compatible / local model backends. Measured against the SDK's surface:

- **~80–85% runtime / capability parity** — the harness does almost everything
  the SDK's harness does, and is ahead on several axes.
- **"usable as a published SDK" parity** — was ~50–60% at assessment; the top-3
  gaps are now closed (one-shot `query()`/`queryText()`/`queryStructured()`,
  `exports`/`types` in the manifest, and an in-process `tool()` API), lifting
  this materially. `src/index.ts` exports `AgentSession`, `SubagentManager`,
  providers, `query*`, `tool`, and ~40 types.

The two are partly apples-to-oranges: the Agent SDK is a **Claude-only wrapper
around a closed binary**; agent-afk is a **multi-provider, fully-open,
modifiable** harness. "Parity" undersells the latter — the remaining gaps are
the ones worth closing if outside developers are to adopt agent-afk *as an SDK*.

## Dimension-by-dimension matrix

| # | Dimension | Claude Agent SDK | agent-afk | Parity |
|---|-----------|------------------|-----------|--------|
| 1 | Entry point | `query({prompt, options})` one-shot + async-iterable streaming input | `query()` / `queryText()` / `queryStructured()` one-shot (`src/agent/query.ts`) + `AgentSession`; `package.json` `exports`+`types` | ● Done (`596da10`, `00298f3`) — no async-iterable *input* yet |
| 2 | Options bag | Large flat `Options` | `AgentConfig`: model, systemPrompt, maxTurns, tools allow/deny, mcp, hooks, permissionMode, canUseTool, maxBudgetUsd, resume/fork/persist, autoCompact, depth | ● High |
| 3 | Streaming events | `SDKMessage` union + opt-in `stream_event` partials | `ProviderEvent` union (delta.text/reasoning, tool.use/output, turn.completed+usage, paused/resumed) | ● High |
| 4 | **Custom tools** | `tool()` + `createSdkMcpServer()`, in-process, Zod | `tool(name, desc, zodSchema, handler)` → `AgentConfig.customTools`, threaded into both providers; builtins win on name collision (`src/agent/tools/custom-tool.ts`) | ● Done (`be6d011`) — no `createSdkMcpServer` shape |
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
| 16 | **Structured output** | `outputFormat: json_schema` on the main query, w/ retry | `sendMessageStructured<T>()` + `queryStructured<T>()`: Zod-validated, bounded re-prompt retry (`maxRetries`, default 2) | ● Done (`00298f3`) |

● Full/High · ◑ Partial · ○ Gap

## Gaps that matter (ranked, for "build-your-own-agent" use)

### Closed (branch `feature/agent-sdk-parity`)

1. ✅ **Programmatic packaging (Dim 1)** — `596da10`. `package.json` now declares
   `"exports"` + `"types"`; `query()`/`queryText()` one-shot wrappers own the
   session lifecycle.
2. ✅ **In-process custom tools (Dim 4)** — `be6d011`. `tool(name, desc,
   zodSchema, handler)` builds a `CustomToolDef` (wire schema via
   `z.toJSONSchema`, safe-parse input validation that never throws);
   `AgentConfig.customTools` threads into both the anthropic-direct and
   openai-compatible providers; builtins win on name collision so a custom tool
   cannot shadow `bash`/`write_file`. Reachable from `query()` via
   `QueryOptions`.
3. ✅ **Structured output on the main turn (Dim 16)** — `00298f3`.
   `AgentSession.sendMessageStructured<T>()` + `queryStructured<T>()`: extract
   JSON (reusing `extractStructuredOutput`), validate against a Zod schema, and
   re-prompt with the validation error up to `maxRetries` (default 2) before
   throwing. Composes `sendMessage` — no streaming-internals changes.

### Remaining (ranked)

4. **Hook coverage (Dim 6).** `PreCompact` (persist artifacts before
   compaction), `Notification`, `PermissionRequest` are the meaningful
   absentees. PreCompact is the next planned wave (the 7-touch-point additive
   pattern is well-trodden — see the `UserPromptSubmit`/`PostToolUseFailure`
   precedents).
5. **Permission rules-engine (Dim 8).** `canUseTool` + read-only phase gating
   exist, but not persisted allow/deny/ask rule lists with settings-tier
   destinations.
6. **Backlog.** Auto-`fallbackModel` (Dim 13), standalone session CRUD
   list/rename/tag/delete (Dim 9), wire the `settingSources` stub (Dim 11),
   slash-command library add/remove API (Dim 12).

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
