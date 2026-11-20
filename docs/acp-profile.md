# AFK ACP v1 profile

## Status and authority

This is the frozen target contract for the ACP v1 migration, not a claim that the current `afk acp` server implements it. The contract lane adds types, examples and unused stubs. The implementation lanes must satisfy this profile before advertising these capabilities. Protocol reference: <https://agentclientprotocol.com>. The normative schema is `tests/fixtures/acp/schema-v1.json`, upstream commit `d98a032006928dffc465f930638f83815b91ebe3`, stable `schema/v1/schema.json`. The fixture README records verification and licensing.

The schema wins over this profile. This profile narrows optional upstream choices. Coordinator decisions D1 through D7 from Wave 0a override the earlier plan, decisions D8 through D13 (P1b, `.afk/plans/acp-spikes/P1b-decisions.md`) supersede D5, D6 and D7, and D14 through D17 (same file, from running the protocol's conformance kit) cover the session directory, reopening live sessions, error data and shutdown. No AFK-specific `_meta` value is necessary for interoperability. Clients must not interpret implementation seam names as wire fields.

## 1. Connection and initialization

Transport is UTF-8 JSON-RPC 2.0 over stdio, one JSON object per newline. Each frame has `jsonrpc: "2.0"`. A request has `id`, `method` and `params`; its response echoes `id` and has exactly one of `result` or `error`. A notification has no `id` and receives no response. Client request ids may be strings or integers. Agent request ids use strings `acp:1`, `acp:2` and so on, unique during a connection. Correlation is direction-specific, so an identical client id cannot satisfy an agent request.

The line cap is 1,048,576 bytes excluding the newline. Stdout contains protocol frames only; diagnostics go to stderr. Empty lines are ignored. Oversize lines are discarded through their newline and reported as invalid requests. Invalid UTF-8 and invalid JSON are parse errors. The peer serializes writes, does not interleave bytes from concurrent frames, and rejects outstanding outbound requests on EOF or a write failure. No protocol response is possible after stdout closes.

The client sends `initialize` once, before any session method, with required integer `protocolVersion` in the schema's range 0 through 65535. The agent supports version 1 only and always returns integer `protocolVersion: 1`. This includes a client offering 0 or a future version: upstream `InitializeResponse.properties.protocolVersion` says to return the latest supported version when the requested one is unsupported. A client that cannot use 1 disconnects. A string such as `"1.0"` is invalid params, not a supported legacy format.

The initialization result is:

```json
{
  "protocolVersion": 1,
  "agentInfo": {"name": "afk", "title": "AFK", "version": "6.0.0"},
  "authMethods": [],
  "agentCapabilities": {
    "loadSession": true,
    "promptCapabilities": {"image": false, "audio": false, "embeddedContext": true},
    "mcpCapabilities": {"http": false, "sse": false},
    "sessionCapabilities": {"resume": {}, "close": {}}
  }
}
```

`agentInfo.version` is the running package version, not literally the illustrative `6.0.0`. Credentials are configured on the host running AFK, outside ACP. There is no ACP authentication flow. Missing credentials produce a generic internal error when the operation needs them. Unknown client capabilities are ignored. AFK does not use client filesystem or terminal methods, even if the client advertises them. AFK does not advertise session listing, deletion, additional directories, system prompt overrides, modes, config options, commands, elicitation, notices or compaction updates. Unsupported methods return method not found. Optional capabilities become true only after implementation tests prove them.

## 2. Session creation and identity

`session/new` takes required `cwd` and `mcpServers` and returns `{ "sessionId": "<opaque id>" }`. `cwd` must identify an existing absolute directory. It is canonicalised once (symbolic links resolved) and used as given (D14): it need not be the directory the server was launched from or below it, so a client may start AFK anywhere and name the project per session. A relative, missing or non-directory `cwd` is invalid params. The session directory is not a containment boundary; the approval policy (section 6) protects the session. Every path the server resolves for a session (tool locations, approval checks, replay) is resolved against the session `cwd`, never the server's launch directory.

The server mints an opaque UUID for the wire `sessionId` (D1). Clients store it unchanged and never derive a filesystem path from it. The implementation seeds the AFK session id with it. If the provider returns another id, the server durably maps the ACP id to the provider's journal id. Subsequent load and resume use that mapping; the wire id does not change. Unknown or unresolvable ids fail with resource not found. The mapping is host-local, not an authentication credential or a portable journal export.

Each stdio MCP entry has required `name`, `command`, `args` and `env`. `command` is an absolute executable path; `args` is an array of strings; `env` is an array of `{ "name": "KEY", "value": "value" }`. An empty `mcpServers` array is valid. Convert entries to AFK's name-keyed MCP configuration and environment record without changing their values. Duplicate server names or duplicate environment names are invalid params, rather than last-write-wins. Reject HTTP or SSE entries as invalid params because those capabilities are false (D3). MCP startup failure fails session setup with a generic internal error and closes partially created resources. Servers a client passes in `session/new` (and `session/load` or `session/resume`) are started when the session is created, before any tool approval, and are trusted in the same way as servers named on the AFK command line (D12). This is the protocol's model for a local client the user controls: the executable runs with the user's privileges without a prompt. Tools from any MCP server, whoever configured it, are always asked.

`additionalDirectories` is not advertised. Omitted or empty arrays activate no extra roots; reject nonempty arrays as invalid params. Do not silently grant wider access. Non-null `systemPrompt` is likewise unsupported. `session/load` and `session/resume` apply the same validation and require the original canonical `cwd`. No remembered permission grant survives reconstruction or process restart.

## 3. Prompt input and completion

`session/prompt` takes `{ "sessionId": "...", "prompt": [ContentBlock, ...] }`, not a bare string. At most one prompt is active per session; other sessions may run concurrently. A second prompt during an active turn fails with invalid request. An empty array is accepted as empty text.

Normalize supported blocks in order, joining their text representations with a newline:

| Block | AFK representation |
|---|---|
| `text` with `text` | Preserve `text` exactly |
| `resource_link` with required `name` and `uri` | Text reference `name (uri)`, do not fetch it implicitly |
| `resource` whose `resource` has `uri` and `text` | Inline `uri`, newline, then `text` |
| `resource` whose `resource` has `uri` and `blob` | Text reference `uri (binary resource omitted)`, do not decode or execute it |
| `image` or `audio` | Invalid params because the capabilities are false |

Annotations and optional display metadata do not change execution semantics. Bad block shapes or unknown block types are invalid params. AFK uses its own tools to read linked content, subject to their existing path restrictions.

The prompt response contains `stopReason` only. Stream text through updates, not a duplicate final `text` property.

| Completion | `stopReason` or error |
|---|---|
| Normal completion | `end_turn` |
| Provider token limit | `max_tokens` |
| Maximum agent turn/request count reached | `max_turn_requests` |
| Explicit provider refusal | `refusal` |
| Client cancels, or permission outcome is cancelled | `cancelled`, even if underlying interruption throws |
| Provider/session error not caused by cancellation | Error `-32603`, message `Internal error` |

Tool denial or a failed command is a failed tool result, not by itself a failed prompt. The model may continue and end normally. Cancellation takes precedence over other stop reasons. Internal paths, stack traces, credentials and provider exception messages never appear in protocol error objects.

## 4. Output updates and usage

All updates use notification `session/update` with `{ "sessionId": "...", "update": { "sessionUpdate": "...", ... } }`. There is no outer `type` discriminator.

| `sessionUpdate` | Fields emitted by AFK |
|---|---|
| `agent_message_chunk` | `content: {type: "text", text}` |
| `agent_thought_chunk` | `content: {type: "text", text}`, only actual provider reasoning |
| `user_message_chunk` | Same text content, during replay only |
| `tool_call` | `toolCallId`, `title`, optional `name`, `kind`, `status`, `content`, `locations`, `rawInput`; replay may include `rawOutput` |
| `tool_call_update` | `toolCallId` and changed fields, including `status`, `content`, `rawOutput` |
| `usage_update` | Required integer `used`, `size`; optional `cost: {amount, currency: "USD"}` |

AFK omits `messageId` in this version. Clients concatenate successive text chunks of the same role in order. Replay sends one chunk per stored message, preserving journal display order.

Under D2, `used` is the current context token count (`context_window_tokens` internally), not lifetime input plus output tokens. `size` comes from the selected model's context window. Both must be finite nonnegative safe integers. If either is unavailable, omit the entire usage update. Never guess a context window size. When available, `cost.amount` is cumulative session USD cost. The harness `totalCostUsd` is per completed user turn, summed across its model iterations (`ResponseMetadata` and `sumProviderUsage`), so the translator accumulates these measured values across turns, not the obsolete internal `costUsd` key. Omit cost if any turn is unmeasured or nonfinite. After load/resume, omit cost unless the complete prior cumulative cost is recoverable; do not claim the new turn's cost is the entire historical session cost. Send the final usage update before the prompt response. There is no invented token field on the wire.

## 5. Tools, kinds, locations and diffs

`toolCallId` is the AFK tool-use id and remains stable across its updates. Suppress early placeholder details (`pending: true` internally). On the first settled detail, emit one `tool_call`. Calls that will run without asking (auto-allowed reads inside the `cwd`, remembered grants, skipped approvals) begin `in_progress`; calls that require consent, including a read outside the `cwd`, begin `pending`. The permission gate can announce a call before its stream detail; deduplicate by id. After an allow decision, emit `tool_call_update` with `status: "in_progress"` before execution output. A terminal result emits `completed`, or `failed` for a tool error/denial/abort. Do not send a second start for an announced id. Missing names become omitted `name`, title `Tool call`, kind `other`, and must not be auto-allowed. An empty id cannot form a valid correlated lifecycle: the translator drops uncorrelatable events and the server logs them to stderr.

Parse `toolInputRaw` when it is valid JSON; expose the parsed value as `rawInput`. If absent or malformed, omit `rawInput`, retain the human summary only for display and never use it to infer safe permissions. `rawOutput` is the tool result text, not a client-executable instruction. Limit each result's UTF-8 text to 65,536 bytes, preserving a valid UTF-8 boundary and including a final `\n[truncated]` marker within that budget. Use that same bounded text for the text result content. Do not emit base64 images as tool content while image support is false. The serialized frame still must fit the transport cap: omit oversize raw input, and omit oversize diff collections in favor of bounded text `Diff omitted: exceeds transport limit`. Never truncate serialized JSON bytes. Tool input above the transport bound is therefore omitted from the tool card and from the permission request, so the user may be approving from the title (and `locations`) alone.

Tool-name mapping uses actual registered names from `src/agent/tools/schemas.*.ts`, plus memory, awareness, workspace and state registries. It is a display classification, not a security classification. A missing or new name defaults to `other` and asks. Tools may be disabled or unavailable on a particular host.

| Real AFK tool names | ACP `kind` | `title` template | `locations` |
|---|---|---|---|
| `read_file`, `view_image`, `extract_document` | `read` | `<name> <absolute file_path>` | Absolute `file_path`, optional positive `offset` as `line` |
| `json_query` | `read` | `json_query <absolute path>` | Absolute `path` |
| `list_directory` | `read` | `list_directory <absolute path>` | Absolute `path` |
| `write_file`, `edit_file` | `edit` | `<name> <absolute file_path>` | Absolute `file_path` |
| `patch_apply` | `edit` | `patch_apply` | Each absolute `changes[].path`, in input order |
| `grep`, `glob` | `search` | `<name>` | Absolute `path` when supplied |
| `memory_search`, `search_witness`, `workspace_query`, `state_query` | `search` | `<name>` | Empty |
| `code_symbols` | `other` | `code_symbols` | Absolute `file_path` when available; always ask because rename/code actions can mutate |
| `config_get`, `get_runtime_state`, `get_facet`, `read_witness`, `read_journal`, `git_read`, `state_get`, `artifact_get`, `artifact_list`, `artifact_read`, `get_background_job_health`, `list_sessions`, `list_schedules`, `get_schedule_history` | `read` | `<name>` | Empty |
| `bash`, `test_run` | `execute` | `<name>` | Empty |
| `web_scrape`, `web_request` | `fetch` | `<name>` | Empty |
| `agent`, `skill`, `compose`, `remote_agent`, `model_complete` | `think` | `<name>` | Empty |
| `worktree` | `other` | `worktree` | Empty |
| `browser_open`, `browser_observe`, `browser_act`, `browser_screenshot`, `browser_close` | `other` | `<name>` | Empty |
| `memory_update`, `procedure_write`, `workspace_publish`, `workspace_subscribe`, `state_put`, `state_cas`, `state_delete`, `config_set`, `terminal_font_size`, `create_schedule`, `update_schedule`, `cancel_schedule`, `cancel_background_job`, `send_message_to_agent`, `send_to_session`, `send_telegram`, `image_generate`, `image_edit`, `artifact_publish`, `wait_for`, `ask_question`, `clipboard_read`, `clipboard_write` | `other` | `<name>` | Empty |
| `exit_plan_mode` | `switch_mode` | `exit_plan_mode` | Empty |
| Every MCP tool and every unlisted name | `other` | `<name>`, or `Tool call` if missing | Empty |

Where a path is unavailable, omit its suffix from the title. Resolve relative paths against session `cwd`, never the server launch directory, and show the resolved absolute path. Omit invalid locations; do not fabricate a path or line. When any argument of a call targets a path outside the session `cwd` (section 6), that absolute path is also appended to the title if not already shown and added to `locations`, whatever the argument is called. Delegation titles append ` (each subagent tool call is asked separately)` to `agent`, `skill` and `compose`, and ` (runs on another machine; its actions are NOT asked in this session)` to `remote_agent`, both on the start and on the permission request (D9). Replay (section 8) uses the same display helpers as a live call.

A result emits a text `content` item shaped `{ "type": "content", "content": { "type": "text", "text": "..." } }`. A diff emits `{ "type": "diff", "path": "<absolute>", "oldText": "...", "newText": "..." }`. For each internal hunk, join context and removed lines with `\n` for `oldText`, context and added lines for `newText`. Do not append a synthetic terminal newline. Use the hunk's file path first, otherwise the input file path; omit a hunk with no resolvable path. These are render-only hunk snapshots, not full-file replacements or instructions to apply a patch. Clients must not write them back to disk. A new-file hunk may omit `oldText`.

Upstream `ToolCallUpdate.content` replaces the collection. The translator must retain previous diffs and include them again with subsequent result content, so the final result does not erase a displayed diff. A late diff after a terminal result is allowed, with accumulated content and no status regression. AFK emits no client terminal references. Subagent-internal tool calls are not streamed as their own `tool_call` frames; their results appear only within the parent delegation result (D13, replacing D7). The exception is the approval card of a child-originated permission request (section 6, D9).

## 6. Permission policy and failure resolution

Every `afk acp` session runs in AFK's `bypassPermissions` mode, so no path containment applies to the session or its subagents (D8). Approvals are on unless `afk acp` is started with `--dangerously-skip-permissions`, which means exactly one thing: skip the approval bridge. The approval bridge is the `canUseTool` callback and does not depend on the permission mode. With approvals on, the bridge runs for every tool invocation that reaches it, at the top level and in forked children (below). Earlier hooks and static allowlists may deny before it runs. A bridge allow never overrides those gates or later destructive-command checks. The session is built non-interactive (D13): the agent cannot ask the user a free-form question on this surface, and the stricter headless shell rules apply on top of the approval prompt. Permission classifications use real tool names, not a client-supplied `kind` or title.

| Invocation | Decision with approvals on |
|---|---|
| Known read/search tools in the table above, every path argument inside the session `cwd` | Auto-allow, subject to existing gates |
| The same tools with any path argument outside the session `cwd`, or a path that cannot be resolved | Ask, absolute path in the title and `locations`, no "always allow" |
| `worktree` with action `list` and no other argument | Auto-allow as an explicit read-only exception |
| `bash`, `test_run` | Ask |
| `write_file`, `edit_file`, `patch_apply`, including dry runs | Ask, absolute path shown |
| `web_scrape`, `web_request`, regardless of HTTP method | Ask |
| `agent`, `skill`, `compose`, `remote_agent`, `model_complete` | Ask |
| Mutating `worktree` actions, or unknown/missing action | Ask |
| `code_symbols`, including read-only subcommands | Ask, conservative policy for a mixed read/refactor tool |
| Every MCP tool, every unknown/missing name, every remaining tool in the table | Ask |
| `--dangerously-skip-permissions` | Skip the bridge entirely, existing independent gates still apply |

### Outside the session directory (D10)

A read or search tool stays auto-allowed only when every path it targets resolves inside the session `cwd`. A call with no path argument defaults to the `cwd` and is not asked. The check scans every argument a tool could treat as a location, not only the obvious one: `file_path`, `path`, `paths`, `cwd`, `dir`, `directory`, `root`, `file`, `files` and similar names, each element of a list, `patch_apply` change paths, the literal base of a `glob` pattern (an absolute pattern, a `..` segment after the base, or an absolute brace alternative is outside), `git_read` options that relocate the repository or write a file (`-C`, `--git-dir`, `--work-tree`, `--output`), and any `git_read` call that can return file content from outside the session `cwd` (below). A value that cannot be resolved lexically (not a string, empty, containing NUL, starting with `~` or pathspec magic `:`, or a session without an absolute `cwd`) counts as outside, so the call is asked. Resolution is lexical: `path.resolve` against the session `cwd`, then a `path.relative` containment check, correct for Windows drive and UNC paths. Symbolic links inside the `cwd` that point outside it are not detected by this check.

`git_read` runs git in the session `cwd` and its own policy confines pathspecs there, but a repository can be larger than the session directory. The approval policy plans the call with the tool's argument policy and asks when it can print file content from elsewhere in the repository: a revision that names a blob or tree (any revision containing `:` such as `HEAD:../other/file` or `:0:path`, a `^{...}` peel, or a bare object id, which may be a blob), `show`, `diff` or `log` producing patches (`-p`, `--patch`, `--word-diff`, `--unified=`, `-S`, or the default patch output of `show` and `diff`) with no pathspec, `log --follow`, and `cat-file -p`. Plain metadata stays auto-allowed: `status`, branch and tag names, `log` without patches (commit subjects, stats, names), `show` or `diff` limited to `--stat`, `--name-only` and similar, `rev-parse`, `ls-files` and the other listing subcommands. Content scoped by a pathspec inside the `cwd` stays auto-allowed, and `grep` and `blame` without a pathspec default to the `cwd`. A subcommand the policy does not classify, or a request the tool itself would refuse, is asked.

Tools on the auto-allow list that take no filesystem path stay auto-allowed. They read AFK's own data, including other sessions', exactly as the terminal does:

* memory and workspace search: `memory_search`, `workspace_query`;
* state and config: `state_get`, `state_query`, `config_get`;
* witness, journal and facets: `search_witness`, `read_witness`, `read_journal`, `get_facet`;
* artifacts: `artifact_get`, `artifact_list`, `artifact_read`;
* sessions, schedules, jobs and runtime: `list_sessions`, `list_schedules`, `get_schedule_history`, `get_background_job_health`, `get_runtime_state`.

If one of these is called with a path-like argument, that argument is still checked.

A delegation call that runs its children in another directory (an `agent` or `remote_agent` `cwd`, or a `compose` node `cwd`) shows that directory in its title when it is outside the session `cwd`. Where the child's directory is known when its provider is built (the `agent` tool, forked skills and compose nodes that are not worktree-isolated), the child origin carries it, and the gate resolves that child's relative or missing paths against it while still checking containment against the session `cwd`; a child working outside the session `cwd` therefore has calls that default to its directory asked. When the origin carries no directory (a worktree-isolated compose node, whose worktree does not exist yet), the conservative rule applies: once a relocating delegation is allowed, every later such child call whose target depends on the child's own directory (no path argument, or a relative one) is asked for the rest of the session instead of auto-allowed. Absolute paths inside the session `cwd` stay auto-allowed.

Before requesting consent, await sending `tool_call` with `status: "pending"`. Then send the agent-to-client request `session/request_permission` with `sessionId`, `toolCall` and `options`. `toolCall` repeats at least the same `toolCallId`, title, name when known, kind, pending status and available raw input. `options` contains, in order:

1. `{ "optionId": "allow_once", "name": "Allow once", "kind": "allow_once" }`.
2. `{ "optionId": "allow_always", "name": "Always allow <tool> in this session", "kind": "allow_always" }`, omitted for `bash`, for delegation tools (`agent`, `skill`, `compose`, `remote_agent`), and for any request asked because it targets a path outside the session `cwd` (D11).
3. `{ "optionId": "reject_once", "name": "Reject", "kind": "reject_once" }`.

The client responds with `{ "outcome": { "outcome": "selected", "optionId": "allow_once" } }`, another offered option id, or `{ "outcome": { "outcome": "cancelled" } }`. The agent resolves the id against the exact options it offered, never trusts a kind supplied by the client, and never forwards client input rewrites. `allow_always` grants only that exact tool name in this live session, shared between the session and its subagents (same user, same session). It is not a per-path grant and not a persisted host permission. A remembered grant never covers a call of that tool that targets a path outside the session `cwd`: that call is asked again (D11). Later covered calls of the same tool skip asking but still pass existing gates. All grants disappear when the gate/session is discarded. Concurrent calls are independent; an already pending question remains pending when another call grants always.

| Permission path | Resolution and named denial reason |
|---|---|
| Offered `allow_once` selected, signal still live | Explicit allow, no input rewrite |
| Offered `allow_always` selected, signal still live | Remember exact name and explicitly allow |
| Offered `reject_once` selected | Explicit deny, `rejected` |
| Unknown option id, including unoffered bash `allow_always` | Explicit deny, `unknown_option` |
| Missing/wrong-shaped reply or unknown outcome | Explicit deny, `malformed_reply` |
| Peer request throws, client error response, write failure | Explicit deny, `request_error` |
| Closed stdin/peer shutdown | Explicit deny, `peer_closed` |
| Already aborted signal or abort while awaiting | Explicit deny, `aborted`; turn finishes cancelled |
| Signal aborted after a reply arrives | Recheck before allowing, explicit deny, `aborted`; never execute late approval |
| Outcome `cancelled` | Explicit deny, `cancelled`; turn finishes cancelled |
| No answer within 120 seconds | Explicit deny, `timeout`; do not hang indefinitely |
| Pending start cannot be emitted | Explicit deny, `request_error`; do not send an orphaned permission request |
| Child-originated request with no live prompt turn | Explicit deny, `no_active_turn`; no card and no request (D9) |
| Missing tool-use id, missing signal, malformed child origin, exception in the policy | Explicit deny (`request_error` or `aborted`), or ask with a generic `[subagent]` label; never an allow |

Denials become a failed tool update with text `Permission denied: <reason>` while the connection is writable. Ordinary denials allow the model to continue; cancellation stops the turn. Shutdown also cancels any active prompt. Never return an undefined or malformed permission result. The dispatcher now proceeds only on an explicit allow and treats anything malformed as a deny; this bridge still always returns an explicit allow or deny.

### Subagents are asked too (D9)

The session passes a child approval factory (`childCanUseTool`) to executor wiring, so tool calls made by forked children go through the same policy, the same remembered grants and the same client prompt as top-level calls. Approving a delegation tool is not consent for what the subagent then does: each of its tool calls that the policy would ask is asked separately.

A child-originated request is recognisable in the client. Its title is prefixed with the child's origin: the route (`subagent`, `skill`, `compose node`), then the agent type and label when known, then the depth when greater than 1, for example `[subagent research-agent] bash` or `[skill user-skill-review]`. An origin with no detail is labelled `[subagent]`. Its `toolCallId` is minted by the gate (`child-<n>-<tool id>`), so it never collides with a top-level call.

The parent stream never carries a child's tool result, so the gate closes the child's card itself and no child-originated card is left `pending` or `in_progress` when the turn ends. On deny the card ends `failed` with text `Permission denied: <reason>`. On allow it moves to `in_progress` and then ends `completed` with text saying the call was approved, runs inside the named subagent, and that its result is reported by the delegating tool call. The card is closed at decision time rather than when the delegating call finishes because the gate cannot observe the child's own execution, and the delegating call can outlive the turn (background subagents); decision time is the only point at which the state shown is certainly true. A child that asks when no prompt turn is live (for example a background subagent after the turn ended) is denied with reason `no_active_turn` and no card or request is sent, because no update may follow a prompt response. When the parent's stream ends, any child request still awaiting the client is denied with `no_active_turn` and the server waits until every child card is closed before it sends the prompt response; a cancelled turn denies them as `cancelled` the same way. A child call covered by a remembered grant runs without a card.

Covered routes: the `agent` tool at any depth, forked skills (including user skills with `context: fork`, `/audit-fit` and the `/mint` phases), `compose` nodes, depth-cap skill and agent children, and phase-restricted providers. Not covered: a `parallelize` override registered as a plugin skill that forks its own children; `afk farm` workers (a CLI batch command, not reachable from a session's tools as far as known); a depth-cap child with no tool list unless its session falls back to the bare provider resolver; and `remote_agent`, which runs on another machine under that machine's own permissions and is never covered by this session's prompts.

### Session behaviour kept as it is (D13)

* `usage_update` is sent only for models with a verified context window; cost is cumulative and omitted after load or resume (section 4).
* Any model the CLI can route works; the approval prompt is forwarded for every provider family.
* `--max-turns` defaults to 0 (no cap) and counts messages per session.
* Prompt mode is the interactive one, so a GUI session gets the same end-of-turn protocol as the terminal REPL.

## 7. Cancellation and close during a turn

`session/cancel` is a notification with `{ "sessionId": "..." }`. It never returns `{cancelled: true}` and does not require an id. For an active turn, mark cancellation before interruption, deny every pending permission request, stop model/tool work as soon as possible, flush final updates, then resolve the outstanding prompt with `{ "stopReason": "cancelled" }`. Do not use the old `-32001` cancellation error. Idle or unknown-session cancellation is a no-op. Malformed notifications are logged to stderr without a response.

The client must answer every pending permission request with the cancelled outcome when cancelling. AFK does not wait for those replies to abort the turn. Late responses for already cancelled outbound ids are ignored and cannot execute a tool. A cancelled tool may receive a final failed update; updates already queued can arrive after the cancellation notification, but no turn updates follow its final prompt response.

`session/close` cancels active work by the same sequence, resolves that prompt first, frees resources, discards the gate and its grants, then replies `{}`. Closing an already closed or unknown id also replies `{}`. Closing is not deleting history. Transport EOF cancels and releases every live session, with no promise of delivery on a broken pipe. Shutdown on EOF is bounded (D17): sessions are released concurrently, waiting for in-flight replies and for session close are each limited to 10 seconds, each external resource of a session (an MCP server disconnect, a store) to 2 seconds, and the process then exits without waiting for stray timers. A normal close, including closing the journal and sealing the trace, takes tens of milliseconds and completes well within the bound; a close still running at the deadline is abandoned, and the trace writer's process-exit backstop seals its trace as incomplete.

## 8. Load, replay and resume

`session/load` requires `sessionId`, absolute `cwd` and `mcpServers`. It restores the mapped journal, reconnects the requested stdio servers and emits the human-visible display history in journal order as `session/update` notifications before returning `{}`. Replay uses `user_message_chunk`, `agent_message_chunk` and terminal `tool_call` entries with `completed` or `failed` status and available result content. Do not replay permission requests, private thoughts, live usage counters or compaction bookkeeping. Replay must never execute historical tools. Clients clear their existing displayed history before load to avoid duplicates.

`session/resume` restores without replay and returns `{}`. The pinned schema requires `sessionId` and `cwd` but makes `mcpServers` optional; omitted means an empty list in this profile. Clients should send an explicit array. Both methods return resource not found for unknown ids. A session that is live and idle on this connection may be loaded or resumed without closing it first (D15): the live handle is kept (its grants, translator state, MCP servers and model context), no second handle is created, `session/load` replays its history again before returning `{}`, and `session/resume` returns `{}` with no replay. Reopening it with a different `cwd` or `mcpServers` list is invalid params, since the live session keeps its own; resume with `mcpServers` omitted matches any list. A session with a prompt in flight, a close in progress, or a load already replaying is refused with invalid request, and a running turn is never cancelled by a load or resume. A `session/prompt` sent while a reload is replaying is invalid request. A failed restore releases partial resources; failure during replay of a restore fails load with internal error and does not leave a live session attached; failure during the replay of a live session's reload fails that load with internal error and leaves the live session as it was. Client UI may have partial replay on failure and should discard it.

## 9. Error and unsupported-feature matrix

These are protocol error objects `{ "code": <integer>, "message": "..." }` inside an error response. Resource not found for a session id the client named (unknown id on prompt, load or resume, or a closed session) carries `data: { "sessionId": "<the id from the request>" }` (D16); the id is the client's own value. Every other error carries no `data`.

| Failure | Code and public message |
|---|---|
| Invalid JSON/UTF-8 line | `-32700`, `Parse error`; response id null |
| Invalid envelope, oversize line, duplicate initialize, session method before initialize, duplicate active prompt, load or resume of a session with a prompt in flight or while it is closing or replaying, prompt during a reload's replay | `-32600`, `Invalid request` |
| Unknown/unadvertised method | `-32601`, `Method not found` |
| Invalid params, bad version type/range, invalid cwd, reopening a live session with a different cwd or MCP list, unsupported prompt media or MCP transport, unsupported nonempty additional roots/system prompt | `-32602`, `Invalid params` |
| Unknown prompt/load/resume id, closed session, missing mapped journal | `-32002`, `Resource not found`, `data.sessionId` |
| Session construction, journal, MCP connection, provider or replay failure | `-32603`, `Internal error` |
| Cancelled active prompt, including interruption exceptions | Successful result with `stopReason: "cancelled"`, not an error |
| Cancel unknown id or malformed notification | No response; malformed notification logged |
| Close unknown/already closed id | Successful result `{}` |
| Permission reply failure | Deny using section 6, not a new agent-to-client request error |
| Unknown/late outbound response id | Ignore and optionally log, never treat as a client request |
| EOF/write failure | Reject pending peer requests, cancel/release sessions within the shutdown bound, no fabricated successful delivery |

For a malformed request with no usable id use null. Errors to valid requests echo their id. Invalid notifications do not receive responses. Upstream `RequestId` includes null for protocol-level error responses. AFK sends no extension methods, no `$/cancel_request` and no AFK-specific wire error codes in this subset. Unknown ordinary fields and `_meta` values are ignored, never treated as authority.

## 10. Frozen implementation seams

`src/cli/commands/acp.wire.ts` defines the typed wire subset and shared seam types. Stub modules throw `not implemented` until their owner implements them. They are not imported by the current server. Wire payloads and internal AFK inputs are deliberately separate.

| Module / owner | Frozen export |
|---|---|
| `acp.rpc-peer.ts` / A1 | `createAcpRpcPeer(opts: AcpRpcPeerOptions): AcpRpcPeer` |
| `acp.translate.ts` / A2 | `createTranslatorState(): TranslatorState` |
| `acp.translate.ts` / A2 | `translateOutputEvent(ev: OutputEvent, st: TranslatorState, ctx: TranslatorContext): SessionUpdate[]` |
| `acp.translate.ts` / A2 | `finishTurn(st: TranslatorState, meta?: TurnMetadata): FinishedTurn` |
| `acp.tool-kind.ts` / A2 | `toolKind(toolName: string): ToolKind`, `toolTitle(toolName: string, input?: unknown): string`, `toolLocations(toolName: string, input: unknown, cwd: string): ToolCallLocation[]` |
| `acp.diff.ts` / A2 | `translateDiff(diff: DiffPayload, input: unknown, cwd: string): DiffContent[]` |
| `acp.permission.ts` / A3 | `createAcpPermissionGate(peer: AcpClientPeer, sessionId: string, opts: AcpPermissionOptions): AcpPermissionGate` |
| `acp.session-load.ts` / A4 | `loadAcpSession(params: LoadSessionRequest, opts: AcpSessionOptions): Promise<AcpSessionHandle>` |
| `acp.session-load.ts` / A4 | `replayHistory(sessionId: string, peer: AcpClientPeer): Promise<void>` |

`AcpClientPeer.request(method, params, signal?)` returns `Promise<unknown>`; `notify(method, params)` returns `Promise<void>`. The concrete peer additionally exposes `handleResponse(frame): boolean` and `close(reason?): void`. A1 routes inbound responses to it before method dispatch. The injected `write(frame)` serializes protocol writes. Outbound request rejection is an internal failure, never permission approval.

Translator state is per live session. Its tool map retains announced ids and accumulated content across turns; ids are unique within the session. A1 resets `cancelled` before each new prompt, marks it on cancellation, and sets `contextWindowSize` only from verified model info. `finishTurn` flushes usage, accumulates measured per-turn cost and maps completion metadata. Call it exactly once per completed prompt, even if a done event supplied the metadata. Restore sets `costIncomplete` if prior cost is unavailable. It does not perform I/O; A1 sends returned updates in order before sending the result. A1 handles provider exceptions separately as protocol errors.

`emitToolCall` is awaited by A3 before asking; A1 uses the same translator tool map to deduplicate it against stream details and retain name/input information. An already announced pending start is not sent twice. Gate approval must produce the in-progress transition before execution; a repeated start with that status is converted by A1 to `tool_call_update`, not a second start. A3 signals cancellation through `onCancelled` so A1 marks translator cancellation and interrupts the session even if cancellation originated in the permission reply rather than a client notification. `cancelAll()` only cancels current pending asks, not remembered grants; session close discards the gate. A1 owns interruption when it calls `cancelAll()` and the method does not recursively call `onCancelled`. The callback is for permission-originated cancellation only. An exception from `onCancelled` cannot change a deny into an allow.

`AcpSessionOptions` adds optional `canUseTool`, `childCanUseTool`, `resume`, `sessionId` and `mcpServers`. `childCanUseTool` is the gate's `forChild(origin)` factory, passed to `wireExecutors` (D9). `AcpPermissionOptions.turnActive()` reports whether a prompt turn is live, so a child asking outside a turn is denied. `dangerouslySkipPermissions` only decides whether a gate exists; the permission mode is always `bypassPermissions` (D8). The callback is handed to the **provider constructor**, not only the session config: this surface injects a preconstructed provider, so session config alone cannot wire the gate (S2). Other fields pass through to `AgentSession` config unchanged when supplied. `mcpServers` here is AFK's name-keyed configuration, not the wire array. A1 owns conversion and A4 may reuse it. `loadAcpSession` restores only; A1 invokes replay explicitly for load, not resume. Resume callers normalize absent `mcpServers` to `[]` for that internal load signature. Request parameters are authoritative for restored cwd/MCP; options supply model, limits and the gate. No behaviour changes when the optional seam fields are absent.

## Resolved and open questions

Resolved by the P1b decisions (D8 to D13), each reversible before merge:

* **Q-A:** explicit-allow-only dispatcher semantics shipped in this branch. Forwarding the bridge into child providers ships (D9). The path-approval session key is not needed: path approval is replaced by the outside-the-directory policy (D10).
* **Q-B:** resolved, any routed model works (D13).
* **Q-C:** "always allow" is never offered for bash, and is also withheld for delegation tools and for outside-the-directory requests (D11).
* **Q-E:** resolved by D8 to D11: sessions run in `bypassPermissions`, subagents are asked, reads and writes outside the session directory are asked with the absolute path shown, and remembered grants never cover them.

Still open:

* **Q-D:** Expose AFK plan mode as an ACP session mode? The pinned schema supports it: `NewSessionResponse.modes` (a `SessionModeState` with `currentModeId` and `availableModes`), the `session/set_mode` method and the `current_mode_update` session update. `modes` is optional in `NewSessionResponse` (only `sessionId` is required). Not in this release.

## Schema-driven clarifications from the original plan

* `ResumeSessionRequest.required` contains `sessionId` and `cwd`, not `mcpServers`. The profile accepts omission as `[]`; load and new still require the array.
* Unsupported version 0 negotiates to 1 rather than an error, per `InitializeResponse.properties.protocolVersion`. The client disconnects if incompatible.
* Extra workspace roots are capability-gated by `SessionCapabilities.properties.additionalDirectories`. The profile does not advertise them and rejects nonempty input instead of silently accepting broader access.
* `ToolCallUpdate.properties.content` replaces, not appends, the collection. Later updates preserve earlier diffs explicitly.
* `ResourceLink.required` includes `name` as well as `uri`. Text references retain both. `EmbeddedResourceResource` includes binary resources; those become omission references rather than text inlining.

The golden transcripts use only fields in the pinned schema. The test validates both envelopes and exact method-specific payload definitions because the upstream envelope unions alone intentionally accept arbitrary method names and broad parameter shapes.
