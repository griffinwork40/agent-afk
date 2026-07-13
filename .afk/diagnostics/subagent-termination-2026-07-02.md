# Subagent termination diagnosis — 2026-07-02

## Scope
Investigated why AFK subagents were getting terminated/stuck over 2026-07-01 to 2026-07-02, using recent AFK transcripts, logs, session artifacts, and source reads in `/Users/griffinlong/Projects/open_source/agent-afk`.

## Confirmed issue: requested gpt-5.5 subagents failed to launch
Three requested `gpt-5.5` diagnostic subagents failed immediately with:

```text
401 Incorrect API key provided: sk-ant-o... You can find your API key at https://platform.openai.com/account/api-keys.
```

This is a real subagent-auth/routing bug, not user error. A `gpt-5.5` child routes to the OpenAI-compatible provider, but the attempted request carried an Anthropic-shaped `sk-ant-...` credential. Either the child should inherit the same working auth context as the parent runtime when the parent is already using that backend, or it should fail before dispatch with a clear "no OpenAI-compatible auth available" diagnostic; it must not silently send an Anthropic token to the OpenAI endpoint and surface a raw 401. I completed the diagnosis inline from durable artifacts because the requested subagents could not start.

## Verdict
This is not one single failure. The last two days show several distinct classes that all look like "subagents terminated" from the UI:

1. **Provider/API pressure is real and likely explains the slow/hung review subagents.**
   - Transcript `~/.afk/state/transcripts/2026-07-01T23-28-20-360Z.md` records a live diagnosis of session `61db02da` dispatching two parallel `agent` subagents at 23:20:39; evidence showed they had opened Anthropic connections and were waiting for first response, not doing local work.
   - Same transcript lines 166-175 conclude elevated `model_ttfb` 3.4–5.3s was a clean network-side measurement, not local AFK preflight, and `src/agent/providers/anthropic-direct/loop.ts:234-284` confirms the timer starts immediately before `createWithRetry` and stops at first translated stream event.
   - `src/agent/providers/anthropic-direct/loop.ts:118-142` retries transient server/overload errors with backoff, so 529/503 pressure is an expected established path, not new regression behavior.

2. **There is a real robustness gap: subagents have no outer deadline, and a 429 usage-limit can look like a hang for up to two hours.**
   - `src/agent/providers/anthropic-direct/query/retry-layer.ts:49` defines `TWO_HOURS_MS`; lines 51-56 document fixed-cadence retry for 429-without-reset, bounded at two hours.
   - Transcript `2026-07-01T23-28-20-360Z.md:169-176` flags that subagent dispatch has no deadline, so a hard usage-limit path can be indistinguishable from a silent hang.
   - This was judged latent/not the main active case in that transcript because some subagents were progressing.

3. **A shipped regression/fix mismatch broke skill subagents in old running processes: PascalCase vs snake_case tool allowlists.**
   - Transcript `~/.afk/state/transcripts/2026-07-02T03-02-05-627Z.md:17-25` explains `/diagnose` and `/audit-fit` gates compared runtime tools like `read_file`, `grep`, `bash`, `web_scrape` to vendored Claude Code allowlists like `Read`, `Grep`, `Bash`, `WebFetch`, causing all tool calls to be denied.
   - The same transcript states the fix is commit `0d1fca6` / PR #350 / tag `v5.15.5`, but older tmux/REPL processes that started before install still had broken gates until restarted.

4. **Worktree/path containment errors were by-design denials, but presented as repeated subagent failure.**
   - `src/agent/subagent.ts:444-450` shows forked subagents inherit the parent cwd for worktree isolation.
   - `src/agent/tools/hooks/path-approval-hook.ts:215-234` auto-denies out-of-root path approval for subagents because they cannot safely prompt a human mid-fork.
   - Transcript `2026-07-02T03-02-05-627Z.md:27-34` ties the failure to prompts containing main-repo absolute paths while subagents were running inside worktree roots. Mitigation: use worktree-relative paths or set `cwd` to match cited paths.

5. **Foreground subagents can be converted to detached background jobs, which previously looked like a loss/termination because results did not return automatically.**
   - Transcript `~/.afk/state/transcripts/2026-07-01T22-18-04-933Z.md:434-447` records a read-only audit subagent converted to background job `bg-mr2olxnf-9025`; the main agent could not auto-join it.
   - Later transcript `2026-07-02T04-14-38-426Z.md:32` says background result auto-delivery was subsequently implemented, so this should be improved in newer sessions.

6. **There is a newly observed local worktree-cleanup/race class causing `spawn /bin/sh ENOENT`.**
   - Transcript `~/.afk/state/transcripts/2026-07-02T03-56-36-870Z.md:115` records live session cwd worktrees being deleted while sessions still ran, causing `spawn /bin/sh ENOENT` for the main session and a verifier subagent.
   - `src/agent/worktree-sweep.ts:240-248` parses `git worktree list --porcelain` branch lines directly, and `worktree-sweep.ts:603-619` can remove candidate worktrees; transcript `2026-07-02T04-07-10-698Z.md:49` reports forensics around a sweep issue. This needs a dedicated issue if it recurs.

## Ranking by likelihood for “today/yesterday tons of issues”
1. Anthropic/API capacity/latency + parallel fanout pressure: high likelihood for slow/hung review subagents.
2. Old running sessions with pre-v5.15.5 skill gate bug: high likelihood for `/diagnose`/skill subagents denied every tool.
3. Worktree absolute-path briefing mismatch: high likelihood in worktree-based sessions.
4. No subagent deadline + 2h 429 retry: real latent sharp edge; high impact when it fires, but not proven active in the main stall case.
5. Background promotion result-delivery gap: explains “lost” subagents in older sessions, less likely after the auto-delivery fix.
6. Worktree cleanup race deleting live cwd: real observed local failure, needs recurrence tracking.

## Recommended next actions
1. Restart all long-running AFK tmux/REPL/Telegram sessions so they load v5.15.5+ gate fixes.
2. Add an explicit subagent deadline / visible 429 usage-limit status so subagents cannot silently appear terminated for up to two hours.
3. When dispatching into worktrees, brief subagents with relative paths or pass `cwd` matching absolute paths.
4. Open/fix the live-worktree cleanup race if `spawn /bin/sh ENOENT` recurs.
5. Fix gpt-5.5 provider credential routing before trying gpt-5.5 subagents again; current dispatch sent an Anthropic-style key to OpenAI-compatible and failed 401.
