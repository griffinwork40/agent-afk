# AFK ACP v1 profile

## Status and authority

This is the frozen target contract for the ACP v1 migration, not a claim that the current `afk acp` server implements it. The contract lane adds types, examples and unused stubs. The implementation lanes must satisfy this profile before advertising these capabilities. Protocol reference: <https://agentclientprotocol.com>. The normative schema is `tests/fixtures/acp/schema-v1.json`, upstream commit `d98a032006928dffc465f930638f83815b91ebe3`, stable `schema/v1/schema.json`. The fixture README records verification and licensing.

The schema wins over this profile. This profile narrows optional upstream choices. Coordinator decisions D1 through D7 from Wave 0a override the earlier plan. No AFK-specific `_meta` value is necessary for interoperability. Clients must not interpret implementation seam names as wire fields.

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

`session/new` takes required `cwd` and `mcpServers` and returns `{ "sessionId": "<opaque id>" }`. `cwd` must identify an existing absolute directory. For this migration the existing server containment policy remains: its canonical path must be the server launch directory or a descendant. Resolve symlinks before containment checks. Clients should spawn AFK in the workspace root and use that root as `cwd`. Rejections are invalid params. This is a documented restriction, not a claim of unrestricted ACP workspace support.

The server mints an opaque UUID for the wire `sessionId` (D1). Clients store it unchanged and never derive a filesystem path from it. The implementation seeds the AFK session id with it. If the provider returns another id, the server durably maps the ACP id to the provider's journal id. Subsequent load and resume use that mapping; the wire id does not change. Unknown or unresolvable ids fail with resource not found. The mapping is host-local, not an authentication credential or a portable journal export.

Each stdio MCP entry has required `name`, `command`, `args` and `env`. `command` is an absolute executable path; `args` is an array of strings; `env` is an array of `{ "name": "KEY", "value": "value" }`. An empty `mcpServers` array is valid. Convert entries to AFK's name-keyed MCP configuration and environment record without changing their values. Duplicate server names or duplicate environment names are invalid params, rather than last-write-wins. Reject HTTP or SSE entries as invalid params because those capabilities are false (D3). MCP startup failure fails session setup with a generic internal error and closes partially created resources. Connecting a client-specified executable is the client's explicit setup instruction; later MCP tool calls still ask permission individually.

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

`toolCallId` is the AFK tool-use id and remains stable across its updates. Suppress early placeholder details (`pending: true` internally). On the first settled detail, emit one `tool_call`. Read/search calls begin `in_progress`; calls that require consent begin `pending`. The permission gate can announce a call before its stream detail; deduplicate by id. After an allow decision, emit `tool_call_update` with `status: "in_progress"` before execution output. A terminal result emits `completed`, or `failed` for a tool error/denial/abort. Do not send a second start for an announced id. Missing names become omitted `name`, title `Tool call`, kind `other`, and must not be auto-allowed. An empty id cannot form a valid correlated lifecycle; drop uncorrelatable events and log to stderr.

Parse `toolInputRaw` when it is valid JSON; expose the parsed value as `rawInput`. If absent or malformed, omit `rawInput`, retain the human summary only for display and never use it to infer safe permissions. `rawOutput` is the tool result text, not a client-executable instruction. Limit each result's UTF-8 text to 65,536 bytes, preserving a valid UTF-8 boundary and including a final `\n[truncated]` marker within that budget. Use that same bounded text for the text result content. Do not emit base64 images as tool content while image support is false. The serialized frame still must fit the transport cap: omit oversize raw input, and omit oversize diff collections in favor of bounded text `Diff omitted: exceeds transport limit`. Never truncate serialized JSON bytes.

Tool-name mapping uses actual registered names from `src/agent/tools/schemas.*.ts`, plus memory, awareness, workspace and state registries. It is a display classification, not a security classification. A missing or new name defaults to `other` and asks. Tools may be disabled or unavailable on a particular host.

| Real AFK tool names | ACP `kind` | `title` template | `locations` |
|---|---|---|---|
| `read_file`, `view_image`, `extract_document` | `read` | `<name> <file_path>` | Absolute `file_path`, optional positive `offset` as `line` |
| `json_query` | `read` | `json_query <path>` | Absolute `path` |
| `list_directory` | `read` | `list_directory <path>` | Absolute `path` |
| `write_file`, `edit_file` | `edit` | `<name> <file_path>` | Absolute `file_path` |
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

Where a path is unavailable, omit its suffix from the title. Resolve relative paths against session `cwd`, never the server launch directory. Omit invalid locations; do not fabricate a path or line. Delegation titles append ` (subagent will act without further prompts)` to `agent`, `skill`, `compose` and `remote_agent`, both on the start and on the permission request (D5).

A result emits a text `content` item shaped `{ "type": "content", "content": { "type": "text", "text": "..." } }`. A diff emits `{ "type": "diff", "path": "<absolute>", "oldText": "...", "newText": "..." }`. For each internal hunk, join context and removed lines with `\n` for `oldText`, context and added lines for `newText`. Do not append a synthetic terminal newline. Use the hunk's file path first, otherwise the input file path; omit a hunk with no resolvable path. These are render-only hunk snapshots, not full-file replacements or instructions to apply a patch. Clients must not write them back to disk. A new-file hunk may omit `oldText`.

Upstream `ToolCallUpdate.content` replaces the collection. The translator must retain previous diffs and include them again with subsequent result content, so the final result does not erase a displayed diff. A late diff after a terminal result is allowed, with accumulated content and no status regression. AFK emits no client terminal references. Subagent-internal tool calls are not forwarded; they appear only within the parent delegation result (D7).

## 6. Permission policy and failure resolution

Default mode runs the bridge for every top-level tool invocation that reaches it. Earlier hooks and static allowlists may deny before it runs. A bridge allow never overrides those gates or later destructive-command checks. The headless bash floor remains in effect. Permission classifications use real tool names, not a client-supplied `kind` or title.

| Invocation | Default decision |
|---|---|
| Known read/search tools in the table above | Auto-allow, subject to existing gates |
| `worktree` with action `list` | Auto-allow as an explicit read-only exception |
| `bash`, `test_run` | Ask |
| `write_file`, `edit_file`, `patch_apply`, including dry runs | Ask |
| `web_scrape`, `web_request`, regardless of HTTP method | Ask |
| `agent`, `skill`, `compose`, `remote_agent`, `model_complete` | Ask |
| Mutating `worktree` actions, or unknown/missing action | Ask |
| `code_symbols`, including read-only subcommands | Ask, conservative policy for a mixed read/refactor tool |
| Every MCP tool, every unknown/missing name, every remaining tool in the table | Ask |
| `--dangerously-skip-permissions` | Skip the bridge entirely, existing independent gates still apply |

Before requesting consent, await sending `tool_call` with `status: "pending"`. Then send the agent-to-client request `session/request_permission` with `sessionId`, `toolCall` and `options`. `toolCall` repeats at least the same `toolCallId`, title, name when known, kind, pending status and available raw input. `options` contains, in order:

1. `{ "optionId": "allow_once", "name": "Allow once", "kind": "allow_once" }`.
2. `{ "optionId": "allow_always", "name": "Always allow <tool> in this session", "kind": "allow_always" }`, omitted for `bash`.
3. `{ "optionId": "reject_once", "name": "Reject", "kind": "reject_once" }`.

The client responds with `{ "outcome": { "outcome": "selected", "optionId": "allow_once" } }`, another offered option id, or `{ "outcome": { "outcome": "cancelled" } }`. The agent resolves the id against the exact options it offered, never trusts a kind supplied by the client, and never forwards client input rewrites. `allow_always` grants only that exact tool name in this live session. It is not a per-path grant, not a persisted host permission, and not offered for bash (D4, Q-C remains open). Later calls of the same tool skip asking but still pass existing gates. All grants disappear when the gate/session is discarded. Concurrent calls are independent; an already pending question remains pending when another call grants always.

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

Denials become a failed tool update with text `Permission denied: <reason>` while the connection is writable. Ordinary denials allow the model to continue; cancellation stops the turn. Shutdown also cancels any active prompt. Never return an undefined or malformed permission result: the current dispatcher treats anything other than explicit deny as allow. This bridge must therefore always return an explicit allow or deny.

Delegation consent is the single consent for the child's actions without further GUI prompts (D5). Children retain their existing allowlist, path and destructive-command restrictions. This profile does not claim that child providers inherit the bridge. Out-of-cwd writes remain denied in default mode (D6); no GUI path-approval handler is installed. A tool blocked by the path hook may never reach the bridge. The skip-permissions flag has its existing path-bypass implications and is an explicit operator opt-out, not an implicit GUI capability.

## 7. Cancellation and close during a turn

`session/cancel` is a notification with `{ "sessionId": "..." }`. It never returns `{cancelled: true}` and does not require an id. For an active turn, mark cancellation before interruption, deny every pending permission request, stop model/tool work as soon as possible, flush final updates, then resolve the outstanding prompt with `{ "stopReason": "cancelled" }`. Do not use the old `-32001` cancellation error. Idle or unknown-session cancellation is a no-op. Malformed notifications are logged to stderr without a response.

The client must answer every pending permission request with the cancelled outcome when cancelling. AFK does not wait for those replies to abort the turn. Late responses for already cancelled outbound ids are ignored and cannot execute a tool. A cancelled tool may receive a final failed update; updates already queued can arrive after the cancellation notification, but no turn updates follow its final prompt response.

`session/close` cancels active work by the same sequence, resolves that prompt first, frees resources, discards the gate and its grants, then replies `{}`. Closing an already closed or unknown id also replies `{}`. Closing is not deleting history. Transport EOF cancels and releases every live session, with no promise of delivery on a broken pipe.

## 8. Load, replay and resume

`session/load` requires `sessionId`, absolute `cwd` and `mcpServers`. It restores the mapped journal, reconnects the requested stdio servers and emits the human-visible display history in journal order as `session/update` notifications before returning `{}`. Replay uses `user_message_chunk`, `agent_message_chunk` and terminal `tool_call` entries with `completed` or `failed` status and available result content. Do not replay permission requests, private thoughts, live usage counters or compaction bookkeeping. Replay must never execute historical tools. Clients clear their existing displayed history before load to avoid duplicates.

`session/resume` restores without replay and returns `{}`. The pinned schema requires `sessionId` and `cwd` but makes `mcpServers` optional; omitted means an empty list in this profile. Clients should send an explicit array. Both methods return resource not found for unknown ids and invalid request if the id is already active; do not create a second live handle or silently cancel a running turn. An active idle session should be closed before load/resume. A failed restore releases partial resources; failure during replay fails load with internal error and does not leave a live session attached. Client UI may have partial replay on failure and should discard it.

## 9. Error and unsupported-feature matrix

These are protocol error objects `{ "code": <integer>, "message": "..." }` inside an error response. No AFK-only error data is required.

| Failure | Code and public message |
|---|---|
| Invalid JSON/UTF-8 line | `-32700`, `Parse error`; response id null |
| Invalid envelope, oversize line, duplicate initialize, session method before initialize, duplicate active prompt or duplicate active restore | `-32600`, `Invalid request` |
| Unknown/unadvertised method | `-32601`, `Method not found` |
| Invalid params, bad version type/range, invalid cwd, unsupported prompt media or MCP transport, unsupported nonempty additional roots/system prompt | `-32602`, `Invalid params` |
| Unknown prompt/load/resume id, missing mapped journal | `-32002`, `Resource not found` |
| Session construction, journal, MCP connection, provider or replay failure | `-32603`, `Internal error` |
| Cancelled active prompt, including interruption exceptions | Successful result with `stopReason: "cancelled"`, not an error |
| Cancel unknown id or malformed notification | No response; malformed notification logged |
| Close unknown/already closed id | Successful result `{}` |
| Permission reply failure | Deny using section 6, not a new agent-to-client request error |
| Unknown/late outbound response id | Ignore and optionally log, never treat as a client request |
| EOF/write failure | Reject pending peer requests, cancel/release sessions, no fabricated successful delivery |

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

`AcpSessionOptions` adds optional `canUseTool`, `resume`, `sessionId` and `mcpServers`. The callback is handed to the **provider constructor**, not only the session config: this surface injects a preconstructed provider, so session config alone cannot wire the gate (S2). Other fields pass through to `AgentSession` config unchanged when supplied. `mcpServers` here is AFK's name-keyed configuration, not the wire array. A1 owns conversion and A4 may reuse it. `loadAcpSession` restores only; A1 invokes replay explicitly for load, not resume. Resume callers normalize absent `mcpServers` to `[]` for that internal load signature. Request parameters are authoritative for restored cwd/MCP; options supply model, limits and the gate. No behaviour changes when the optional seam fields are absent.

## Open questions for G1

These remain human decisions, not approvals implied by the frozen profile. Until resolved, D1 through D7 govern the target above.

* **Q-A:** Does harness hardening ship in v6.0 or later: explicit-allow-only dispatcher semantics, forwarding parent `canUseTool` into child providers, and passing `sessionKey` to path-approval elicitation? This profile assumes no GUI prompts inside children and no GUI path-approval bridge.
* **Q-B:** Keep the hardcoded Claude-only provider for v6.0 and document it, or switch this surface to the provider router (related to #4911)? The contract lane leaves the provider selection unchanged. Protocol capabilities do not promise a model provider.
* **Q-C:** Never offer `allow_always` for bash (current D4), or allow it per exact command? Current transcripts do not offer it for bash.

## Schema-driven clarifications from the original plan

* `ResumeSessionRequest.required` contains `sessionId` and `cwd`, not `mcpServers`. The profile accepts omission as `[]`; load and new still require the array.
* Unsupported version 0 negotiates to 1 rather than an error, per `InitializeResponse.properties.protocolVersion`. The client disconnects if incompatible.
* Extra workspace roots are capability-gated by `SessionCapabilities.properties.additionalDirectories`. The profile does not advertise them and rejects nonempty input instead of silently accepting broader access.
* `ToolCallUpdate.properties.content` replaces, not appends, the collection. Later updates preserve earlier diffs explicitly.
* `ResourceLink.required` includes `name` as well as `uri`. Text references retain both. `EmbeddedResourceResource` includes binary resources; those become omission references rather than text inlining.

The golden transcripts use only fields in the pinned schema. The test validates both envelopes and exact method-specific payload definitions because the upstream envelope unions alone intentionally accept arbitrary method names and broad parameter shapes.
