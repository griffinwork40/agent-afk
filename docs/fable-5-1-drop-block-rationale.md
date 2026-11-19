# Fable 5.1 / 5.2 `drop_block` rationale

## Context

On Claude Fable 5.1 and 5.2, preserved thinking binds each returned thinking
block to what preceded it: `system`, `tools`, and every earlier message,
including content before the block in its own message. Each block is compared
with its own recorded prefix, not with the previous request. The check compares
parsed content, not JSON formatting or key order. Changing, inserting, moving,
or deleting earlier content can invalidate subsequent thinking. Leaving a gap
in the sequence of thinking blocks can also fail the check.

There are separate model and account bindings: a model can read only compatible
models' thinking, and Fable 5.2 thinking is usable only in its producing account
or a linked account. Incompatible model/account blocks are dropped without an
error. Changing `model` is not itself a *prefix* change.

Without an explicit policy, a prefix failure can return HTTP 400
`The block is bound to a different conversation` (always on Fable 5.2; possibly
on Fable 5.1). With `drop_block`, the server drops failing blocks and the request
continues. Blocks left in stored history may be reported again on later requests.

Verified prefix-changing operations in AFK include:

- **Environment date rollover**: `query-system.ts` calls
  `refreshEnvironmentDate` on the user system prompt before building the request.
  A changed date changes `system`; merely rebuilding identical content does not.
- **Permission-mode addenda**: `query-system.ts` adds plan/autonomous instructions
  according to the current mode. Switching modes can change `system`.
- **Plan-mode tool availability**: `query-turn-driver.ts` filters out
  `exit_plan_mode` outside plan mode, changing the request's `tools` on a mode switch.
- **Client-side compaction**: `compact.ts` supplies a summary preamble to the
  shared compaction core, replacing older messages. Microcompaction in
  `shared/compaction.ts` replaces older tool-result content with placeholders.
  Either can change the prefix of thinking retained after the edited content.
  This is different from server-side compaction/context editing, which changes
  what the model reads rather than the sent prefix.

Appending a new tool-result message after a thinking block does **not** change
that block's prefix. `cache_control` markers are excluded from the comparison.
Restoring identical content in a new process or session does not itself fail the
prefix check; the check is about content, not session IDs.

Sources: [Preserved thinking](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking)
and [Prefix checks](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking/prefix-checks).

## Decision: explicit `drop_block` over append-only rewrite

AFK retains the explicit `drop_block` decision rather than redesigning system,
tool, and history composition to be append-only. The
`thinking-binding-controls-2026-08-01` beta header and
`thinking.block_binding.prefix_mismatch_behavior: 'drop_block'` are sent on
eligible requests. The same handling applies to Fable 5.2.

| Policy | Mechanism | Trade-off |
|---|---|---|
| `drop_block` | Server drops invalidated thinking; the request continues without it | Keeps the current harness architecture; prior reasoning is unavailable on the affected request |
| Append-only | Freeze `system` and `tools`, preserve earlier messages, append updates | Avoids prefix invalidation but requires redesign of mode changes, environment updates, and client-side compaction |

Dropped blocks are not billed as input, but dropping can invalidate prompt
caching from the first affected block and require more output tokens. Continuing
normally does not mean the reasoning loss is prevented or quality is unchanged;
evaluations are needed to assess that trade-off. AFK does not remove blocks
from stored history, so compatible blocks may remain usable on future requests.

## Wire shape

```js
// message_start.message.input_transformations
[
  { type: 'thinking_dropped', path: 'messages.1.content.0', reason: 'prefix_binding_mismatch' }
]
```

`message_delta` can also report transformations after a server-side fallback.
Known reasons are `prefix_binding_mismatch`, `model_binding_mismatch`, and
`organization_binding_mismatch`. `thinking_mismatch_allowed` means a prefix
check failed but the block reached the model; it is **not** a drop. AFK ignores
unknown transformation types. Unknown drop reasons still count as drops.

## Implementation

- **`input-transformations.ts`**: shared filtering and per-reason tallying for
  every drop-bearing frame. One `console.warn` notice per session ID is retained
  in a process-local FIFO set of at most 4096 IDs. After eviction, a revisited
  session can receive another notice. There is no process-wide warning cap.
  The line explains the reason in plain words with searchable raw codes, says
  AFK continued normally and no action is needed, and directs further omissions
  to the trace. No paths, thinking text, or signatures are logged.
- **Trace metadata** is flat and scalar, matching `session_phase` typing:
  `{ droppedCount: 2, source: 'message_start', reason_prefix_binding_mismatch: 2 }`.
  Each nonzero reason gets a numeric `reason_<code>` field, so witness `where`
  filters can match `payload.metadata.reason_prefix_binding_mismatch` directly.
  Future reason identifiers matching `[a-z][a-z0-9_]{0,127}` are preserved;
  malformed or missing reasons become `unknown_reason` (keeping output one line).
- **`translate.ts`**: retains per-stream console deduplication and the
  `message_delta` fallback. Every drop-bearing frame emits a
  `thinking_block_dropped` trace event, including the already-warned path and
  streams after the session's console notice. Start/delta counts are per-frame,
  not distinct-block totals across frames.
- **`auth.ts`**, **`loop/round-request.ts`**, and **`query-runtime.ts`** retain
  existing beta/policy wiring. No request-building or history behavior changes.

The notice remains console-only, not a ProviderEvent notice: Telegram and daemon
operators do not receive that console line through their normal notice surfaces.
This observability change does not prevent thinking loss or change model support.

## Tests

- `translate.input-transformations.test.ts`: same session across streams (one
  line, separate traces with reasons), independent sessions, more than ten
  sessions, bounded FIFO eviction, both drop-bearing frames including the
  already-warned path, delta-only fallback, mixed/unknown reasons, exact wording,
  scalar witness filtering, malformed entries, ignored types/non-drops, and
  normal turn completion. `translate.test.ts` keeps the remaining translator tests.
- `auth.test.ts` and `loop/round-request.test.ts` cover existing beta header and
  `block_binding` request wiring.
- `query-wiring.characterization.test.ts` covers the provider wiring. Appending
  a tool result is not evidence of a mutated prefix and is not treated as such.

## Compatibility boundary

`query-runtime.ts` enables the policy for Fable 5.1 and 5.2 on the direct endpoint.
Other model paths are unchanged. This is AFK's current integration boundary,
not a claim that the upstream preserved-thinking feature supports only those models.
