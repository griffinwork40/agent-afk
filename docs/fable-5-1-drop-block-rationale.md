# Fable 5.1 `drop_block` rationale

## Context

Claude Fable 5.1 introduces *prefix-bound thinking*: every thinking block in
an assistant turn is cryptographically tied to the exact prefix of messages that
preceded it.  If the prefix changes — even a single byte — the server refuses
the thinking block with HTTP 400 `invalid thinking block signature`.

AFK mutates prefixes in several well-known ways:

- **Tool-result injection**: `tool_result` blocks are appended after every
  `tool_use` assistant turn, changing the subsequent message prefix.
- **Prompt-cache stamps**: `cache_control: { ttl: '1h' }` breakpoints are
  cloned-and-stamped onto the last content block before each `messages.create`
  call (non-mutating in-flight, but the cache marker changes the hash seen by
  the model at the NEXT turn).
- **Session restore**: a session resumed from disk carries signed thinking from
  an earlier process; the restored prefix is functionally identical but the
  server's internal binding may no longer match.

## Decision: explicit `drop_block` over append-only rewrite

Two policy choices exist once a prefix mismatch is detected:

| Policy | Mechanism | Trade-off |
|---|---|---|
| `drop_block` | Server drops the invalidated thinking block; the model answers that turn without it | Minimal: one console.warn; prior reasoning unavailable for the dropped turn |
| Append-only history | AFK never mutates message history — impossible given tool-result injection | Would require a full architectural rewrite of the tool-use loop |

AFK opts into `drop_block` via the `thinking-binding-controls-2026-08-01` beta
header.  This is the correct choice because:

1. AFK's tool-result injection is load-bearing — eliminating it would require
   rewriting the loop in loop.ts and all retry tiers.
2. Dropped blocks are not billed and the model answers from its current context.
   Prior reasoning is unavailable for the affected turn; blocks still in history
   that the current model can read remain usable.
3. The drop is *observable*: the server populates
   `message.input_transformations` in the SSE `message_start` frame, which
   AFK surfaces as a bounded `console.warn` (structural metadata only — block
   count and index positions; no thinking text or secrets cross the log).

## Wire shape

```
// SSE message_start frame (documented in the Anthropic preserved-thinking API reference)
// Real field names: type:'thinking_dropped', path:'messages.N.content.M'
{
  type: 'message_start',
  message: {
    ...
    input_transformations: [
      { type: 'thinking_dropped', path: 'messages.1.content.0', reason: 'prefix_binding_mismatch' }
    ]
  }
}
```

Known `reason` values: `prefix_binding_mismatch`, `model_binding_mismatch`,
`organization_binding_mismatch`. Unknown `type` or `reason` values are ignored
(forward-compat per spec). `thinking_mismatch_allowed` entries are NOT drops —
they mean the block failed the prefix check but was allowed through on an older
account; AFK does not warn for them.

## Implementation

- **`translate.ts`**: `warnOnDroppedThinkingBlocks()` — safe helper called at
  `message_start` and `message_delta`; logs drop count + reason category
  breakdown only. `path` values are never logged.
- **`auth.ts`**: `THINKING_BINDING_CONTROLS_BETA_HEADER` constant; wired into
  `buildRequestHeaders` as the `thinkingBindingControls` optional flag.
- **`loop/round-request.ts`**: `buildRoundParams` merges `block_binding:
  { prefix_mismatch_behavior: 'drop_block' }` into the `thinking` param when
  `thinkingBlockBinding` is set.
- **`request-types.ts`**: `thinkingBlockBinding` typed on `RunTurnInput` and
  `AnthropicMessagesCreateParams`.

## Tests

- `translate.test.ts` — thirteen `input_transformations` cases: `prefix_binding_mismatch`,
  `model_binding_mismatch`, `organization_binding_mismatch`, multi-drop mixed reasons,
  `thinking_mismatch_allowed` (no warn), unknown type (no warn), unknown reason (warn
  as `unknown_reason`), absent field, empty array, warn cap at 10 with cap note,
  `message_delta` fallback path, stream continues after drop, malformed entries skipped.
- `auth.test.ts` — five cases: oauth + active, api-key + active, oauth + inactive,
  api-key + inactive (empty object), oauth + both effort and thinkingBindingControls.
- `loop/round-request.test.ts` — three `buildRoundParams` cases: block_binding wired,
  block_binding absent for non-Fable, thinking omitted entirely.

## History mutated-prefix representative test

The `query-wiring.characterization.test.ts` exercises a real `prepareTurnRequest`
→ `buildRoundParams` path with `thinkingBlockBinding` set, verifying that the
beta header is forwarded in both oauth and api-key modes.  This covers the
"AFK mutates prefixes" scenario: the characterization test represents a history
that has already been mutated (tool_result appended) and asserts the drop_block
policy is wired end-to-end.

## Fable 5 backward compatibility

Fable 5 (`claude-fable-5`) supports `{type: 'enabled'}` extended thinking with
explicit `budget_tokens`; it is NOT adaptive-only.  The drop_block feature is
Fable-5.1-specific (adaptive thinking always on).  The `thinkingBlockBinding`
flag is optional on `RunTurnInput` and is only set when the provider detects
Fable 5.1; Fable 5 paths leave it unset, so no `block_binding` field reaches
the wire and no thinking-binding-controls beta is requested.
