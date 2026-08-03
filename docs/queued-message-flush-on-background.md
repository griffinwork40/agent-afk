# Flushing a queued message into the parent turn on Ctrl+B

**Status:** research / design proposal (nothing implemented)
**Date:** 2026-08-03
**Question:** when the REPL user has a typed-ahead message queued and presses Ctrl+B to
background a running foreground subagent, can the queued message be delivered into the
parent's *still-running* turn instead of waiting for the whole turn to end?

**Answer:** yes, and there is already a provider-agnostic carrier in place — the synthetic
promotion `tool_result`. No new injection machinery, no provider-specific code, no
exposure to the phantom-turn bug class that `51c46d8` fixed.

---

## 1. What exists today

### Queue lifecycle (typed-ahead)

| Stage | Location |
|---|---|
| Container | `pendingSubmissions: SubmissionPayload[]` — `src/cli/terminal-compositor.ts:325` (boolean mirror `queued` at `:313`) |
| Enqueue | streaming-mode branch of `handleEnter` — `src/cli/terminal-compositor.input-dispatch.ts:810-816` |
| Drain | `setInputMode(self, 'idle')` — `src/cli/terminal-compositor.input-mode.ts:264-281`; `shift()`s **exactly one** payload FIFO, *before* invoking the handler (teardown-before-setup invariant, `:140-144`) |
| Observability | `getPendingCount()` — `src/cli/terminal-compositor.ts:895-897`; rendered as `[queued]` / `[N queued]` in `src/cli/terminal-compositor.render.ts:49-60`; echoed in the ESC soft-stop line at `src/cli/commands/interactive/turn-handler.ts:685-701` |

So the queue drains **only at a next-turn boundary** (any → `idle` transition). One payload
per turn.

### Ctrl+B path

```
input-dispatch.ts:1069-1082  handleBackground  (streaming-mode only; once-only `backgrounded` guard)
  → input-surface.ts:330      onBackground closure → this.backgroundHandler?.()
  → input-surface.ts:409-411  setBackgroundHandler (per-turn install)
  → turn-handler.ts:127-140   handleBackgroundKey  (installed at :339-341)
  → turn-handler.ts:129       if (!control?.hasPromotableForeground()) return;   // silent no-op
  → subagent-executor.ts:373-380  promoteActiveForeground(): Promise<PromotedSubagentInfo[]>
  → foreground-promotion.ts:204-231  registry.adoptRunning(...) → synthetic tool_result
```

The queue is **never touched** anywhere on that chain. The promotion returns, inline, a
synthetic `tool_result` that unblocks the parent turn immediately
(`foreground-promotion.ts:219-231`):

```ts
return {
  content: JSON.stringify({
    status: 'running' as const,
    jobId: job.jobId,
    subagentId: job.subagentId,
    label: job.label,
    message: `Subagent backgrounded by user (jobId=${job.jobId}). …`,
  }),
};
```

**This is the carrier.** It is a harness-native `ToolResult` (`src/agent/tools/types.ts`),
assembled into a provider request by *both* providers
(`anthropic-direct/loop/tool-results.ts:115`, `openai-compatible/loop.ts:148-166`), and
there is already a shared helper whose whole job is appending a note to it:
`appendInjectContext(toolResult, note)` — `src/agent/tools/subagent/inject-context.ts:30-37`,
already used at `foreground-promotion.ts:400` and `skill-executor/fork-dispatch.ts:380`.

### Mid-turn injection: no existing seam, but a proven precedent

There is no way today for an external event to splice text into an in-flight round —
deliberately. `pendingFrameworkContext` / `queueFrameworkContext`
(`agent-session.ts:113,1162-1180`) and the `BgResultNotifier` path
(`bg-result-notifier.ts`, `loop-iteration.ts:547-550`) are all **next-turn-prepend**,
because the provider's outer loop calls `promptIterator.next()` exactly once per turn
(`anthropic-direct/query.ts:356-364`, `openai-compatible/query.ts:381-387`). Pushing into
the input stream mid-turn produced a *phantom turn* that displaced the user's next real
message by one queue position — the bug `51c46d8` fixed. **Do not reopen that channel.**

The sanctioned mid-loop mutation precedent is `WIND_DOWN_NOTE`
(`anthropic-direct/loop/tool-round.ts:132-144`): it pushes a `{ type: 'text' }` block onto
the just-committed `tool_result` user message, *after* all tool results. That ordering is
exactly what the Anthropic API mandates ("tool_result blocks must come first… any text must
come after all tool results" — `platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls`).
Violating it yields a 400 `tool_use ids were found without tool_result blocks immediately after`.

---

## 2. What Claude Code actually does (and where the ask diverges)

Documented facts:

- **Ctrl+B** "Backgrounds Bash commands and agents" — `code.claude.com/docs/en/interactive-mode`.
- **Type + Enter** while working is read "**as soon as the current action completes**" —
  `code.claude.com/docs/en/how-claude-code-works` ("Interrupt and steer"). Not end-of-turn.
- **Esc** is the destructive interrupt; type+Enter is the non-destructive steer.
- Changelog confirms this is young and bug-prone: "steering messages could be lost while a
  subagent is working" (2025-12-12), "input being lost when typing while a queued message is
  processed" (2025-11-07).

**No Claude Code doc or changelog entry ties Ctrl+B to flushing queued input.** CC's
behavior falls out of a *more general* mechanism: its queue is checked at **every tool-round
boundary**, so backgrounding — which completes an action — happens to coincide with a queue
check. A reverse-engineered source mirror (unofficial, lower confidence) shows queued entries
becoming `attachment` content blocks merged into the same synthetic user message that carries
the `tool_result` blocks, appended after them.

So there are two designs, and CC implements the general one:

| | Scope | Blast radius |
|---|---|---|
| **Narrow** (this ask) | flush queue on Ctrl+B only | one new carrier arg on an existing seam |
| **General** (what CC does) | drain queue at *every* tool-round boundary | changes queue semantics for every turn; touches both providers' round loops; re-enters the displacement/phantom-turn risk class |

**Recommendation: ship narrow first.** It rides a carrier that already exists, and its
envelope + system-prompt fragment are a strict subset of what the general version needs — so
the general version later is additive, not rework.

---

## 3. Recommended approach

**Ride the promotion `tool_result`.** On Ctrl+B, fold the queued payload text into the
synthetic promotion result that the parent turn is already about to receive.

Why this wins over the alternatives:

- **Provider-agnostic by construction** — `ToolResult.content` is harness-native; both
  providers already consume it. Zero provider code.
- **No API ordering hazard at all** — the text lives *inside* the tool_result's content
  string, so we never add a sibling block and cannot trip the tool_use/tool_result pairing
  rule.
- **Correct timing** — the model learns "subagent detached" and "user said this" in the same
  round, which is precisely the requested UX.
- **No phantom turn** — nothing is pushed onto the prompt iterator.
- **Boundary-test safe** — the keyboard layer passes a plain `string`;
  `subagent-control-boundary.test.ts` forbids subagent-module imports in `turn-handler.ts`,
  `input/input-surface.ts`, `terminal-compositor.input-dispatch.ts`, and a string arg adds none.

### Change shape

1. **`SubagentControl.promoteActiveForeground(note?: string)`** — thread an optional
   user-note string (today: no params, `subagent-executor.ts:373`). Forward it into the
   promotion trigger so `foreground-promotion.ts`'s promotion branch can consume it.
2. **Use a harness-owned field, not forgeable tool text.** Add the note as a top-level
   `queuedUserMessage` property in the promotion result's JSON object. Ordinary subagent
   output remains an escaped string value and therefore cannot synthesize that property. Add a matching fragment to
   `src/agent/tools/system-prompt.ts` (alongside `BG_SUBAGENT_RESULT_PROMPT` /
   `BASH_PASSTHROUGH_PROMPT`) so the model treats it as a real user directive rather than
   tool noise. Without this fragment the feature silently under-delivers.
3. **Peek → pass → confirm → drain.** *Do not drain first.* Promotion can legitimately fail
   (no registry wired, or background-job cap hit → `foreground-promotion.ts:232-244` falls
   through and stays foreground), and in that case there is no promotion `tool_result` for
   the note to ride. Read the queue without mutating, pass the text, and `shift()` only after
   `promoteActiveForeground` reports it actually consumed the note. Drain-then-pass loses the
   message on the cap-hit path.
4. **Coalesce all pending, FIFO.** Precedent: the post-ESC epoch already coalesces multiple
   typed messages into a single payload (`input-dispatch.ts:734-751`). Leaving some queued
   behind after a flush would fire them as a mystery turn later.
5. **Queue only — never the live buffer.** Uncommitted (no-Enter) text is still being edited;
   stealing it repeats the removed Backspace-dequeue bug that "silently destroyed typed
   content" (`input-dispatch.ts:901-905`).
6. **New sibling files, per the 350-LOC rule.** Every file on this path is already over
   budget — `foreground-promotion.ts` 421, `turn-handler.ts` 984,
   `input-dispatch.ts` 1144, `input-mode.ts` 297. New logic goes in new siblings (e.g.
   `src/agent/tools/subagent/queued-note.ts` for claiming+truncation,
   `src/cli/commands/interactive/queued-flush.ts` for peek/confirm/drain).
7. **Record it as a user message.** Mirror the queued text into the transcript + witness
   trace so `afk trace show` can reconstruct why the parent changed course mid-turn.

### Rejected alternatives

- **Separate `{type:'text'}` block on the tool_result user message** (WIND_DOWN_NOTE style,
  mutating `input.messages`). Faithful user-message semantics and API-legal, but needs
  per-provider glue: anthropic-direct pushes onto `lastMsg.content`, while
  openai-compatible's `priorTurns` uses discrete `role:'tool'` messages and would need a
  synthetic `role:'user'` message instead. Two paths, two test suites, same user-visible
  outcome.
- **`QueryInputStream.pushUserMessage` mid-turn** (`input-iterable.ts:24-36`). This is the
  literal queue and is *proven unsuitable* — root cause of `51c46d8`.

---

## 4. Risks

1. **Double-delivery.** If the flushed payload is not `shift()`ed exactly once, the next
   any→`idle` transition re-drains it (`input-mode.ts:264-281`) as a duplicate turn.
2. **Message loss on the promotion-failure path.** Cap hit / no registry → no carrier. Hence
   peek-pass-confirm-drain, not drain-then-pass.
3. **Post-ESC coalesce collision.** Ctrl+B while the post-ESC epoch is armed: a raw
   `pendingSubmissions.shift()` from outside `handleEnter`/`setInputMode` can leave
   `postEscPayload` dangling and trip the dev-mode `throw` at `input-dispatch.ts:800-806`.
   The drain must go through a compositor-owned accessor that maintains that bookkeeping.
4. **Silent under-delivery.** Without the system-prompt fragment (step 2) the model may read
   the envelope as tool output and ignore the instruction — the feature would "work" while
   changing nothing.

## 5. Test gap to close

`terminal-compositor.queue.test.ts` covers the queue, `keypress.test.ts:1089-1104` and
`turn-handler.test.ts:1078-1164` cover Ctrl+B — but **no test exercises queued message +
Ctrl+B together.** Minimum new coverage: flush on successful promotion; no-drain when no
subagent is promotable; no-drain on cap-hit fallthrough; no double-drain at the following
idle transition; post-ESC-epoch interaction.
