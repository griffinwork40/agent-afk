# Background processes (`bash run_in_background`)

An agent sometimes needs a program to keep running while it does other work: a
multi-hour search, a local model server, an app dev server. Before this
feature it had to improvise (`(nohup cmd > log 2>&1 &)`, `tmux`, Python
`Popen(start_new_session=True)`), and the improvised process was untracked:
no exit status, no completion notice, no way to stop the exact run.

`bash` now takes `run_in_background: true`. There is no new tool.

## Contract

| Aspect | Behaviour |
|---|---|
| Start | `bash {command, run_in_background: true, timeout_ms?}` returns at once with `{job_id: "proc-N", pid, status, log_path, max_runtime_ms}`. All bash gates apply (PreToolUse hooks see the flag in the input). |
| Environment | Same as foreground bash: scrubbed env, session TMPDIR, session cwd. Own process group. stdin is `/dev/null`. |
| Runtime limit | `timeout_ms` is the maximum runtime: default 2 h, max 24 h. On expiry: SIGTERM, grace, SIGKILL; status `timed_out`. |
| Output | stdout and stderr go to a log file (32 MB cap, one rotation to `<log>.1`). Output volume never kills the job. A small ANSI-stripped tail is kept in memory. |
| End of job | The job is its leader process. When the leader exits, the job waits up to 2 s for the pipes to close; if group members still hold them, the group is reaped (TERM, then KILL) and the result says `orphans_reaped`. Closed pipes are not proof the group is gone: a member that redirected its own output (`srv >/dev/null 2>&1 &`) is detected by probing the group when the pipes close, and is reaped the same way. |
| Status | `completed` (exit 0), `failed` (non-zero, signal, spawn error), `timed_out`, `cancelled`. Exit code and signal are recorded. |
| Completion | A metadata-only `<background-process-result job status exit_code signal duration_ms bytes log>` is delivered once: if the job ends while a turn is running it is injected at that turn's next tool-round boundary (after the tool batch, before the next model request; held back while a human message is queued), so it does not wake a second turn. Otherwise the REPL prepends it to the next turn and wakes an idle prompt. No polling. |
| Inspect | `get_background_job_health {jobId: "proc-N"}`: status, exit, elapsed, bytes, log path, recent output (marked untrusted). |
| Stop | `cancel_background_job {jobId, reason}`: SIGTERM to the group, 5 s grace, SIGKILL; waits up to 12 s and returns the final status. Jobs whose leader already exited keep their natural outcome and are never marked cancelled. If the 12 s wait runs out, the final status arrives later as a `<background-process-result>`. |
| Wait | `wait_for {type:"process", pid}` on the returned pid; `wait_for {type:"file", path: log_path, content_contains}` for readiness lines. |
| Operator | `/sh` lists model jobs next to `!&` jobs; `/sh show proc-N` prints recent output; `/sh kill proc-N` stops it (the agent is told). A job whose leader already exited is reported as already exiting; no signal is sent. |
| Lifetime | Owned by the root REPL session. Esc does not stop jobs. Session exit stops them (TERM, 2 s, KILL); an exit hook SIGKILLs any group still alive if afk exits abruptly (on Windows, only while the leader is alive). Nothing is ever restarted. |
| Availability | Root interactive REPL only. Subagents, Telegram, daemon and one-shot runs get an explicit refusal. At most 3 running jobs. |
| Read-only gates | Every gate that admits "read-only" bash refuses a background launch whatever the command text: read-only skills, plan mode, what-if episodes (`src/agent/tools/bash-background-flag.ts`). |
| Risk | `classifyRisk` rates a background launch at least `medium`, so a `safe` substring (`cat `, `pnpm test`) cannot make it look read-only. AFK mode still prompts only for `high`, exactly as for other `medium` commands such as `npm install`. |
| Disk | Logs live in `$AFK_STATE_DIR/proc-jobs/<session>/`. Each job is bounded at about 64 MB (32 MB + one rotation), so 3 running jobs total at most ~192 MB. The 128 MB per-session quota for settled logs is enforced before each new start; the transient peak including that settled-log quota is therefore ~320 MB. Session dirs untouched for 7 days are swept. |
| Windows | No process groups: stop uses `taskkill /T` on the leader while it is alive. After the leader exits, Windows never signals (the PID may be reused) and only releases the pipes, so survivors, including ones that redirected their output, are not reaped (#2742). |

## Why the envelope carries no output

Process output is attacker-influenceable: a dev server echoes request paths,
a search prints whatever it finds. The completion envelope can start a model
turn with no human watching, so it carries metadata only. The agent reads
output through a tool, where it is already framed as untrusted.

## Where supervision stops

- **Exit is not success.** An exited search is not a verified result; the
  agent must validate the output.
- **Running is not ready.** A started server is not necessarily accepting
  requests; wait for a readiness line in the log.
- **Escapees.** A child that calls `setsid` or daemonizes leaves the process
  group and is not reaped. Do not daemonize under `run_in_background`.
  Backgrounding inside the command (`cmd > log 2>&1 &`) stays in the group
  and is reaped on POSIX when the leader exits; run the server in the
  foreground of the command instead, so the job lives as long as it does.
- **Crash.** If afk itself is killed, the job may keep running (or die of
  SIGPIPE on its next write); control is lost and nothing is restarted.

## Example: local model server

1. `bash {command: "mlx_lm.server --port 8080", run_in_background: true}` → `proc-1`
2. `wait_for {type: "file", path: <log_path>, content_contains: "Starting httpd"}`
3. experiments with foreground `bash curl …`
4. `cancel_background_job {jobId: "proc-1", reason: "experiments done"}` → stopped, exit status reported

## Implementation map

| File | Role |
|---|---|
| `src/agent/shell-jobs/process-jobs.ts` | `ProcessJobRegistry`: start, cap, max runtime, cancel, teardown, exit hook |
| `src/agent/shell-jobs/process-launcher.ts` | spawn, settle-once, orphan reap, TERM→KILL helper |
| `src/agent/shell-jobs/process-log-sink.ts` | capped rotating log + tail |
| `src/agent/shell-jobs/process-jobs.sweep.ts` | per-session quota, 7-day sweep |
| `src/agent/tools/handlers/bash.background.ts` | the `run_in_background` branch of `bash` |
| `src/agent/tools/process-job-tools.ts` | `proc-` routing for health/cancel; tool advertisement |
| `src/cli/commands/interactive/process-job-notifier.ts` | envelope, notices, idle wake |
| `src/cli/slash/commands/sh.process-jobs.ts` | `/sh` list/show/kill |

## Deferred

Telegram (needs an idle-eviction exemption while jobs run), adopting
Ctrl+B-detached bash calls (#2932), a crash-orphan sweep, `wait_for` yielding
when an owned job settles, child-owned jobs, output excerpts behind an
untrusted-content wrapper, stdin/PTY. Design record:
`.afk/plans/managed-background-processes.md` (local).
