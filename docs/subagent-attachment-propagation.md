# Subagent attachment propagation — scoping + design

**Status:** proposal (nothing implemented). Scoped 2026-08-01 on branch `afk/subagent-image-propagation` @ 4accb48f (== `origin/main`, v5.84.10).

**Goal:** when a human sends the parent session an image, let the parent *optionally* attach that image to the prompt it dispatches to a subagent.

---

## 1. What already exists

The capability is **one hop away**. Both ends of the pipe are built; only the middle is string-only.

### Ingress (works today, two surfaces)

| Surface | Path | Result |
|---|---|---|
| Telegram photo | `bot.on('photo')` (`src/telegram/bot.ts:294`) → `handlePhoto` (`src/telegram/handlers/message.ts:281`) → download + base64 (`message.ts:416-417`) + MIME sniff (`message.ts:37-64`) → inline `image` block (`message.ts:468-478`) → `processOne` → `streamResponse` (`src/telegram/handlers/streaming.ts:407-410,659-661`) | `ContentBlockParam[]` → `sendMessageStream` |
| CLI REPL clipboard (Ctrl+V, macOS) | `readClipboardImage()` (`src/cli/input/clipboard-image.ts:56`) → `ImageAttachment` (`src/cli/input/attachments.ts:6`) → `TerminalCompositor.attachments` (`terminal-compositor.ts:193`) → `runTurn` (`turn-handler.ts:49-50,352-356`) → `buildUserPayload` (`src/cli/slash/_lib/user-payload.ts:41`) → `appendImageBlocks` (`src/cli/slash/_lib/image-blocks.ts:22`) | `ContentBlockParam[]` → `sendMessageStream` |

Not wired: `afk chat` (`src/cli/commands/chat.ts` — `message: string`, sends bare strings at `:669,695`), no `--image` flag, no drag-and-drop path detection.

### Session + provider layers (already multimodal)

- `AgentSession.sendMessageStream(content: string | ContentBlockParam[])` — `src/agent/session/agent-session.ts:636`, interface `src/agent/types/session-types.ts:194`. **Verified.**
- anthropic-direct: **pass-through, untouched** — `providers/anthropic-direct/query.ts:395-398` (`messages.push({role:'user', content: turn.content})`).
- openai-compatible: **translated when vision-capable** — `buildUserContent` (`messages.ts:129-157`) → `imageBlockToUrl` (`messages.ts:84-93`, base64 → `data:` URI) → `{type:'image_url'}` (`:145`); non-vision → `flattenUserContent` + `imageOmittedNotice` (`messages.ts:65-76,102-119`). **Degrades to a text notice, never crashes.**
- Capability detection exists: `supportsVision` (`src/agent/model-capabilities.ts:113-126`), consulted **only** at `providers/openai-compatible/query.ts:516`.
- Tool-result images already work (browser_screenshot): anthropic inline (`anthropic-direct/loop/tool-results.ts:110-133`); openai via a follow-up `role:'user'` message (`openai-compatible/loop.ts:180-202`, gated `:184`).

### The gap — string-only dispatch chain (all verified by direct read)

```
schemas.ts:354-357        prompt: { type: 'string' }                 [schema]
input-parse.ts:19,141-146 AgentInput.prompt: string (typeof guard)   [type/runtime]
subagent-executor.ts:399  SubagentExecutor.execute()                 [runtime]
  :610 / :621             stripEscapeSequences(parsed.prompt)…       ← string ops
  :661 / :674             prompt: parsed.prompt                      [runtime]
handle.ts:42,44,197,611   run/runToResult(prompt: string)            [type]  ← THE SEAM
handle.ts:443             session.sendMessageStream(prompt)          → already accepts blocks
```

`ForkSubagentOptions` (`src/agent/subagent.ts:205-306`) deliberately carries **no** prompt — only `promptHead?: string` (`:264-273`); the prompt arrives via `handle.run()`.

---

## 2. Two constraints that pick the design

**Constraint A — bytes cannot ride in the tool call.** Nothing mechanically caps `agent` tool *input* size (only output caps exist: `dispatcher.ts:1203-1226`, `web-scrape.ts:55-60`). But to populate a bytes-in-schema field the **parent model must emit the base64 as output tokens**: a 200KB–2MB photo is ~270K–2.7M chars ≈ 70K–700K tokens, exceeding output ceilings and absurd on cost. → **A reference/id design is forced.**

**Constraint B — inbound images are currently anonymous and unaddressable.**
- No id/filename/size marker is emitted next to an inbound image block on either surface (`message.ts:469-478`, `image-blocks.ts:27-34`) → the parent model **cannot name** the image it received.
- The bytes live only in the provider's private `AnthropicDirectQuery.state.messages` (`query.ts:73,319,398,417`), never threaded into `SubagentExecutorContext` (`subagent-executor.ts:40-213`, whose `parentSession` is a narrow `Pick<>` at `:42-47`) or `ToolHandlerContext` (`src/agent/tools/types.ts:37-109`). `getInputStreamRef()` is write-only (`session-types.ts:281`).
- The ledger stores only a text summary (`[+ N image(s)]`, `agent-session.ts:743-758`) — no bytes.
- `ImageAttachment.id` exists (`attachments.ts:7`, `randomUUID()` at `clipboard-image.ts:98`) but is REPL-local bookkeeping, never persisted or shown to the model.

→ Nameability must be **added at ingress**, or the feature can only forward images that already have a filesystem path.

---

## 3. Recommended design

**Add a sibling `attachments` field; do NOT widen `prompt` to content blocks.**

Keeping `prompt: string` leaves every string-derived artifact correct by construction — `promptHead` (`subagent-executor.ts:621`), `id_prefix` slice (`:610`), bg-job `label` (`background-registry.ts:338`), `promptHash` (`:380`), empty-check (`input-parse.ts:145`). Widening `prompt` would force edits at all five and risks a real regression: a naive `JSON.stringify(prompt).slice(0,80)` label would write **base64 to disk in `meta.json`**, violating the documented invariant at `bg-job-log.ts:41` ("full prompt text is never written to disk"). Additive sibling field = smallest reversible change, no hidden fallback.

### Schema (one new optional field)

```jsonc
// src/agent/tools/schemas.ts — alongside prompt
attachments: {
  type: 'array',
  items: { type: 'string' },
  description: 'Optional. Images to attach to the subagent prompt. Each entry is '
    + 'either an inbound attachment id shown to you as [image img_xxxxxx · …] or an '
    + 'absolute file path to an image. Bytes are resolved by the runtime — never '
    + 'paste base64 here.',
}
```

One field, **two resolvers** (id → registry, `/`-prefixed → filesystem). This mirrors the established precedent: browser `resolveTarget` dispatching on `{kind:'element_id'}` vs `{kind:'selector'}` against `PlaywrightProvider.sessions[].knownElements` (`src/browser/playwright/index.ts:42,96,270,426`).

### Layer 1 — path-backed attachments (small, self-contained)

1. `attachments?: string[]` on the schema + `AgentInput` (`input-parse.ts:18-128`) with a parse guard.
2. Executor resolves each entry: read file under existing `readRoots` policy, MIME-sniff, cap count/bytes.
3. Build blocks with the existing single-source-of-truth encoder `appendImageBlocks` (`src/cli/slash/_lib/image-blocks.ts:22`) — note it currently lives under `src/cli/`; move to a neutral module (e.g. `src/agent/content/image-blocks.ts`) since a non-CLI caller now needs it.
4. Widen the seam only: `SubagentHandle.run/runToResult(prompt: string | ContentBlockParam[])` (`handle.ts:42,44,197,611`) — `sendMessageStream` at `:443` already accepts the union. Assemble `[{type:'text',text:prompt}, ...imageBlocks]` in the executor **after** all string-derived artifacts are computed.
5. Vision pre-check (new): `child-config.ts` never consults `supportsVision`. If the resolved child model is non-vision, still dispatch (the openai-compatible notice path handles it) but return a **warning in the parent's tool result** — today nothing tells the parent its image was dropped.

Unlocks immediately: any image with a path, plus anything the parent already wrote to disk (browser screenshots, generated charts). Does **not** cover Telegram/clipboard images — they never touch the filesystem.

### Layer 2 — inbound attachment registry (delivers the actual ask)

1. **Mint + spill at ingress.** Content-hash id (`img_a1b2c3`), write bytes to a session-scoped sidecar dir — new `getInboundAttachmentsDir(sessionId)` in `src/paths.ts` mirroring `screenshotsDir` (`src/browser/witness.ts:57-59`, `paths.ts:311-314`).
2. **Emit the id in text next to the image block** — `[image img_a1b2c3 · image/png · 842 KB]`. This is the load-bearing bit: the model can only forward what it can name. Both call sites: `message.ts:468-478` and `image-blocks.ts:22-36`.
3. **Session-scoped registry** `Map<id, {path, mediaType, sizeBytes}>`, exposed read-only through `SubagentExecutorContext` exactly as `traceWriter`/`agentRegistry` already are (`subagent-executor.ts:40-213`).
4. Executor resolves ids via the registry; unknown id → clear tool error listing available ids.

Side benefit: unifies the duplicated encoders (Telegram builds its own block inline at `message.ts:475-478` rather than reusing `appendImageBlocks`).

### Layer 3 — image-aware byte hygiene (optional, pre-existing bugs)

- `anthropic-direct/compact.ts:143-156` — `toolResultContentBytes` ignores non-text blocks, so **image bytes are invisible to microcompaction** and escape context-pressure eviction. Propagating images to children multiplies this.
- `agent/trace/writer.ts:380-399` — `persistCompactionSidecar` `JSON.stringify`s `preCompactionMessages` verbatim → image base64 lands **unredacted on disk**.
- `providers/shared/tool-call-trace.ts:83` — `resultBytes` counts only `result.content`; images invisible to the witness metric. `:52` `inputBytes` `JSON.stringify`s the whole tool input (a reference design keeps this tiny — another argument for ids).
- `dispatcher.ts:1203-1226` — `applyOutputCap` does not cap `result.image.data`.

Existing caps to mirror: 5 MiB screenshot sidecar (`browser/witness.ts:108,115-120`), 8000px (`tools/handlers/browser-screenshot.ts:33`), 5 MB Telegram photo (`telegram/handlers/message.ts:322`).

---

## 4. Producers that do NOT get this for free

Each builds its own child prompt as a plain string and would need separate widening:

- compose/DAG — `promptBuilder: (inputs) => string` (`src/agent/dag-subagent.ts:22,143-144`), `compose-executor.ts:676-719`; compose node schema has `additionalProperties:false` (`schemas.ts:508-514`).
- Fork-mode skills — `skill-executor/fork-dispatch.ts:339-358`, `skills/user-skills.ts:185-212`, all mint phases, `skills/audit-fit/index.ts:387-432`.
- Background jobs — `background-registry.ts:159-169,245-246,338,380` (`RegisterArgs.prompt: string`); if attachments are logged, log **ids/paths, never bytes**.

Recommendation: ship the `agent` tool path first; treat compose/skills as follow-ups driven by demand.

---

## 5. Hazards / guards

| # | Hazard | Evidence | Guard |
|---|---|---|---|
| 1 | Unconditional string ops crash on a non-string prompt | `background-registry.ts:338,380`; `input-parse.ts:145`; `subagent-executor.ts:610,621` | Sibling-field design avoids all of them — do not widen `prompt` |
| 2 | base64 in bg-job `meta.json` `label` | `bg-job-log.ts:41,103-116` + `background-registry.ts:338` | Never serialize blocks into `label` |
| 3 | Parent unaware its image was dropped for a non-vision child | `child-config.ts` (no `supportsVision`); degrade at `messages.ts:65-76` | Vision pre-check + warning in tool result |
| 4 | Unbounded image count/size per dispatch | no input caps exist anywhere in the chain | Cap N images + total MB at resolution time |
| 5 | Stream-cut retry replays the prompt | `stream-cut-retry.ts` / `runWithStreamCutRetry` exist on the **diverged** `afk/subagent-stream-cut-retry` @ 89df5fd2, **not** in this checkout | Replay passes the same in-memory reference → block arrays replay byte-identically; re-verify after those branches merge |

## 6. Tests

Extend: `src/agent/tools/subagent/input-parse.test.ts` (attachments parse/reject), `src/agent/tools/subagent-executor.test.ts` (dispatch with attachments), `src/agent/subagent/handle.test.ts` + `handle-streaming.test.ts` (widened seam), `src/agent/background-registry.test.ts` (label/hash unchanged + no-base64-on-disk regression), `src/agent/session/content-blocks.test.ts` (extend to the fork path), `src/agent/model-capabilities.test.ts` (vision gate). New: ingress id-marker tests for `telegram/handlers/message.ts` and `cli/slash/_lib/image-blocks.ts`.

**No existing test covers an image reaching a dispatched subagent** — `subagent-executor*.test.ts` has zero image/attachment coverage.

## 7. Suggested PR split

1. **PR 1** — path-backed `attachments` + neutral `image-blocks` module + seam widening + vision warning + tests. Self-contained, useful alone.
2. **PR 2** — inbound registry + ingress id markers + `getInboundAttachmentsDir`. Delivers "forward the image the human sent me."
3. **PR 3** — image-aware byte hygiene (compaction visibility, sidecar redaction, dispatcher image cap). Fixes pre-existing leaks.
