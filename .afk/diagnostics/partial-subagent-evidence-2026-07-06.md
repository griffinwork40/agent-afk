# Partial subagent results — instance evidence (2026-07-06)

Scanned all **10,933** witness traces under `~/.afk/state/witness/*/trace.jsonl`.
Scanners: `scan-partial-subagents.mjs`, `scan-orphan-detail.mjs`, `/tmp/tiny.mjs`.

## Aggregate
- 610 traces had subagents; **1,165 subagents started**.
- **320 orphans** (27.5%): `subagent_lifecycle.started` with NO terminal (`succeeded`/`failed`/`cancelled`).
- **24 succeeded-tiny**: `succeeded` with `outputBytes < 200`.
- **16 failed** total (10 `RateLimitError`, 2 TypeError, 2 APIConnectionTimeout, 1 APIConnectionError, 1 BadRequest); 12 carried `partialOutputBytes > 0`.
- 13 cancelled; 86 background started (6 bg-orphan); 3,563 sealed traces (86 incomplete seals).

## Orphans by dispatch source (orphans / started)
| prefix | orphans | started | pct |
|---|---|---|---|
| skill-review | 221 | 534 | 41% |
| skill-ship | 32 | 116 | 28% |
| skill-ground-state | 25 | 112 | 22% |
| skill-shadow-verify | 18 | 174 | 10% |
| skill-distill | 8 | 49 | 16% |
| skill-devils-advocate | 7 | 57 | 12% |
| (others) | small | | |

- Orphan sessions' **closure reason**: `model_end_turn` 283, NO_CLOSURE 31, `abort` 6.
- Orphan↔dispatching-tool correlation: 0 orphans had a traced dispatching tool_call.completed with truncated/error flags (raw tool output isn't traced, so this is inconclusive for the correctness question — it does NOT prove results were complete).

## Succeeded-tiny fingerprint (correctness signal)
Several ran a long time with **turnCount 0** yet "succeeded" with ~100–200 bytes:
- `skill-review-1783170275621-1` — 142 B, turnCount 0, **931,278 ms (15.5 min)** — session 9a5e2093
- `skill-review-1783135740476-1` — 142 B, turnCount 0, **276,504 ms (4.6 min)** — session 5cffaa40
- one case **7,568,116 ms (2.1 h)**, tiny output
- `skill-review-1779549420826-1` — 103 B, turnCount 0, 8,270 ms — session fa775de7
All 24 have turnCount ≤ 1; none had 0 output bytes.

## Two candidate mechanisms (grounded in code)
### M1 — Lost terminal (observability). 320 orphans, mostly clean-closure.
- Terminal emit is fire-and-forget: `handle.ts:199` `void emitSubagentLifecycle(..., 'succeeded')` (also 237/245 for cancelled/failed).
- Seal is awaited on a different path: `agent-session.ts:1203` `await this.sealTraceWriter()` → `writer.seal()`; post-seal `write()` rejects (`writer.ts`).
- Race: parent/skill session seals before the `void` terminal append lands → terminal dropped → orphan. Dominant in skills because the skill executor forks, `await handle.runToResult()` (skill-executor.ts:1141), then immediately seals its short-lived session. Matches memory fact B1 (fix "flush terminal-emit before sealTraceWriter", never landed).

### M2 — Partial result returned as SUCCESS (correctness). The user's actual complaint.
- `streamToFinalMessage` (handle.ts:271–374): `for await (event of session.sendMessageStream)` accumulates `lastStreamedContent`; `turnCount++` only on `event.type==='message'` (326).
- If the stream loop **ends without a terminal `message`/`done`/`error` event**, the post-loop fallback at **353–354** returns `lastStreamedContent` as a **normal success Message**; `run()` (190–221) sets `succeeded` and emits `succeeded`. Parent gets a mid-narration partial as a clean success, no error.
- Fingerprint = turnCount 0 + small output + succeeded (the succeeded-tiny bucket).
- OPEN: what makes `sendMessageStream` complete early without a terminal event — 429/rate-limit cascade (memory 2026-07-05), usage-limit pause+auto-resume (memory: pause has no event; autoResumeOnUsageLimit default true), or provider stream abnormal close. This is the primary thing to nail.

## Reference sessions to pull
- Orphan+clean: `00cddbd0-7d47-41a6-906c-85fd4107b70f` (skill-review, sealed succeeded, no succeeded terminal).
- Succeeded-tiny/turnCount-0: `9a5e2093-2d9b-4cf2-8a9e-3bae4d63a318`, `5cffaa40-94cb-4f1d-b9f6-171960d34a64`, `fa775de7-edd3-4347-9e87-ad47a32be41f`.
