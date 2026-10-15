# Remote agent dispatch (`remote_agent`)

Run an afk agent on another machine over SSH (Tailscale or LAN) and get its final
answer back as a tool result. The remote agent works in that machine's own files,
repos, accounts, and model subscriptions. Nothing is copied: move code with git.

## Setup

1. The remote needs afk installed and logged in (`afk login` on that machine; the
   remote run is headless, so it must authenticate without a prompt).
2. Key-based SSH from this machine to the remote (`ssh user@host true` works with no
   password prompt).
3. Optional: name hosts in `~/.afk/config/hosts.json`:

```json
{
  "cm":   { "ssh": "griffincapmisc@griffin-cm", "cwd": "~/Projects/agent-afk" },
  "m6":   { "ssh": "griffinlong@100.126.251.79" },
  "mini": { "ssh": "mini", "afkPath": "/opt/homebrew/bin/afk" }
}
```

A `host` absent from the file is used as a literal ssh target, so `~/.ssh/config`
aliases work with no setup. `afkPath` is only needed when auto-discovery fails.

## Tool

`remote_agent { host, prompt, cwd?, model?, resume? }`

- Blocks until the remote run finishes. For long work, call it from a background
  `agent`, which is delivered automatically.
- The result ends with `[remote_agent: host=… session=<id> run=<id>; pass resume="<id>" …]`.
  Pass that session id as `resume` to continue the same conversation on that host.
- Risk class `medium` (outbound effect, like `send_telegram`): allowed in AFK mode.

## How it works (`src/remote/`)

| File | Role |
|---|---|
| `hosts.ts` | Loads `hosts.json`; validates the ssh target (no leading `-`, restricted charset). |
| `remote-script.ts` | Builds the POSIX scripts run as `/bin/sh -c` on the remote. |
| `ssh-runner.ts` | Spawns local `ssh` (`BatchMode`, `ConnectTimeout=5`, ServerAlive probes). Injectable. |
| `remote-run.ts` | Launch → follow → result; reconnect; cancel on abort. |
| `remote-events.ts` | Tolerant parser for `afk chat --format stream-json` events. |

1. **Launch.** One ssh call: the prompt goes over stdin into
   `~/.afk/state/remote-runs/<runId>/prompt` (never embedded in a shell string), afk is
   located, and `nohup afk chat --format stream-json` starts detached, writing
   `out.ndjson`, `err.log`, and `pid`. A dropped connection or a sleeping laptop does
   not kill the run.
2. **Locate afk.** Explicit `afkPath`, else the non-interactive PATH, else a scan of the
   interactive shell's PATH (nvm usually loads from `.zshrc`, and `afk` may be a shell
   function there, so `command -v` inside that shell is not trusted), else nvm's install
   glob. The afk bin dir is prepended to PATH because npm's shim is `#!/usr/bin/env node`.
3. **Follow.** `tail -n +<line> -f out.ndjson` until a `done`/`error` event or the
   process exits. A dropped connection re-follows from the next unseen line, up to 6
   consecutive failures without progress; after that the result says the run continues
   on the remote and where its output lives.
4. **Cancel.** Aborting the tool call runs `kill <pid>` on the remote.

## Guardrails

- **No fan-out.** The launch command inlines `AFK_MAX_NESTING_DEPTH=0 AFK_REMOTE_DEPTH=1`
  (sshd's default `AcceptEnv` drops forwarded env, so it must be inline). The remote
  cannot use `agent`/`skill`/`compose`, and `remote_agent` refuses when
  `AFK_REMOTE_DEPTH` is set.
- **Fail fast.** An unreachable or sleeping host fails in about 5 s with
  "host unreachable"; a missing afk install and a bad cwd have their own messages.
- **Permissions.** Skip-permissions is never passed; the remote's own headless
  permission gate applies.

## Known limits

- Bash on the remote could still run `ssh other-host afk …` by hand; the guard covers
  the tool path only.
- `kill <pid>` does not check for pid reuse (runs are short-lived relative to pid wrap).
- The remote trace and journal stay on the remote machine; the local trace records only
  the tool call.
- `--max-budget-usd` is not passed; subscription (OAuth) runs may not enforce it anyway.

## Alternatives considered

- A shell script via `bash`: no recursion guard or cancel, 10-minute bash timeout.
- A human-only `afk remote run` CLI: safest, but defeats unattended delegation.
- A `RemoteSubagentHandle` inside `forkSubagent` (so `agent{host}` and compose nodes
  work): the right end state, but `SubagentHandle.session` is required
  (`src/agent/subagent/handle.ts`) and DAG/worktree paths assume local disk. Deferred.
- An `afk serve` HTTP server on the tailnet: a new always-on listener and auth per box.
