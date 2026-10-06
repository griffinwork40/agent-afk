---
name: automate
description: "Set up a scheduled headless afk run that pushes a summary to Telegram. Accepts a task description, directory path, or session ID — for session IDs, runs an isolation-contamination probe via read_witness to assess automation fit before gating on an explicit APPROVE token. Use when the user wants to automate a recurring task via the afk daemon scheduler (cron) with push-notified results."
disable-model-invocation: true
context: load
failure_modes:
  - contaminated fit verdict (probe sub-agent receives original session rationale)
  - APPROVE token accepted without presenting command sequence preview
  - schedule created without confirming Telegram end-to-end
---

Set up a recurring headless task using afk's **native** scheduler. Do NOT hand-roll launchd plists or shell scripts — afk has first-class scheduling: the `create_schedule` tool writes `~/.afk/config/schedules.json` entries that `afk daemon` runs on cron.

## Input routing

The argument is one of three forms:
- **Task description / directory path** — proceed directly to the Scout + Prompt designer wave below.
- **Session ID** — run the fit-assessment flow first (Waves 0–1 + authorization gate) to determine whether the session is automatable before building a schedule.

---

## Session ID path: fit-assessment

### Wave 0 — Signal extraction (orchestrator, synchronous)

Read the session facet with `get_facet` (pass `fields: ["duration_minutes", "user_message_count"]` so the goal and first prompt never enter the extraction) and the session's tool calls with `read_witness` (`kinds: ["tool_call"]`), then extract four flat signals:

- `duration` — the facet's `duration_minutes`
- `user_messages` — the facet's `user_message_count`. Do not count witness events for this: the trace records no user turns, and its `queued_user_message` events cover only messages typed mid-turn, so they undercount.
- `llm_branch_steps` — count of tool calls whose branch condition is model output rather than exit code (i.e., tool calls following a reasoning step that is not mechanically determined)
- `command_sequence` — ordered list of distinct bash/shell commands issued, with item count

Emit **Artifact 1**: `duration=Xm, user_messages=N, llm_branch_steps=M, command_sequence=[cmd1, cmd2, …] (K distinct commands)`. This is the only input forwarded to Wave 1 — the session ID, original user message, and any rationale are withheld.

### Wave 1 — Automation-fit probe (isolated sub-agent)

Receives Artifact 1 **only**. Denied: session ID, original user message, any framing about why the task was run manually. Denied write tools.

Applies the five-point rubric:

| Criterion | Points |
|---|---|
| `duration ≤ 10m` | +1 |
| `user_messages ≤ 2` | +1 |
| `llm_branch_steps == 0` | +1 |
| Command sequence is idempotent with no destructive commands lacking a guard | +1 |
| No step requires live user judgment | +1 |

Emits one of:
- `FIT [score=N]` (≥ 4) — proceed to gate
- `PARTIAL [score=N, guard=<exact modification required>]` (2–3) — surface the guard to the user before the gate; do not proceed until acknowledged
- `UNFIT [score=N]` (≤ 1) — halt with explanation; do not generate a schedule

### Authorization gate

For FIT or acknowledged-PARTIAL verdicts, the orchestrator presents the proposed schedule: name, cron expression, and command sequence preview. Waits for an explicit token:

- `APPROVE` (or bare "yes") — proceed to Scout + schedule creation
- `MODIFY <field> <value>` — adjust one parameter and re-present
- `ABORT` — exit with `AUTOMATED_NOTHING`

Do not proceed to schedule creation until APPROVE is recorded.

---

## Schedule creation (all paths)

Dispatch two sub-agents in parallel:

1. **Scout** — call `list_schedules` and inspect `~/.afk/config/schedules.json` for existing or overlapping jobs, run `afk service status` to see whether the daemon is installed as a launchd service and running, confirm Telegram is configured (`TELEGRAM_BOT_TOKEN` + `AFK_TELEGRAM_ALLOWED_CHAT_IDS`), and scan the target project folder for conventions. Report conflicts, daemon/service state, and any missing prerequisite.
2. **Prompt designer** — draft the recurring task's `command` string: a self-contained prompt (or `/skill --flags` invocation) sent verbatim into a freshly spawned session each run. The daemon session starts cold, so encode all input context explicitly, and require the run to END by calling the `send_telegram` tool with a concise, push-ready summary.

When both return:
- If Telegram is unconfigured, stop and tell the user to run `/telegram-setup` first — `send_telegram` fails closed without `TELEGRAM_BOT_TOKEN` and `AFK_TELEGRAM_ALLOWED_CHAT_IDS`.
- Create the job with the `create_schedule` tool: `name`, the designed `command`, the requested 5-field `cron`, `trigger: "cron"`, and `notifyOn: "failure"` as a crash safety-net (the per-run summary comes from the agent's own `send_telegram` call, not from `notifyOn`).
- Schedules only fire while the daemon is running, so make it survive reboot/crash: if `afk service status` shows the daemon isn't installed, run `afk service install daemon` (launchd `RunAtLoad` + `KeepAlive` on macOS).

Dispatch a **verification** sub-agent to confirm the job registered (`list_schedules`), the daemon is running (`afk service status`), and — by running the task's `command` once as a one-shot (`afk chat "<command>"`) — that the Telegram summary actually arrives. On failure, diagnose (Telegram config, daemon not running, cron syntax, prompt shape) and fix before exiting. Report the schedule id, cron, `notifyOn`, daemon/service status, and the next scheduled run.

## Completeness contract (session ID path only)

Before claiming Done, confirm all five items are present in the terminal report:

1. **Wave 0 signal report** — duration, user-message count, LLM-branch count, command sequence with item count stated
2. **Wave 1 fit verdict** — score and tier (FIT / PARTIAL / UNFIT) stated
3. **Authorization token** — APPROVE, MODIFY \<field\> \<value\>, or ABORT recorded
4. **Schedule artifact** — schedule ID and cron expression stated
5. **PARTIAL guard** — if applicable, exact guard surfaced to user before the gate
