# Remote agent dispatch (`remote_agent`)

Run an afk agent on another machine over SSH (Tailscale or LAN) and get its final
answer back as a tool result. The remote agent works in that machine's own files,
repos, accounts, and model subscriptions. Nothing is copied: move code with git.

## Setup

1. The remote needs afk installed and logged in. **On macOS, keychain logins need
   `"unlockKeychain": true`** (see [Keychain unlock](#keychain-unlock)): an SSH
   session sees the login keychain locked even while you are logged in at the GUI,
   so without it the run fails with "No Anthropic credential found" (the tool adds a
   hint naming the fix). Alternatively put `CLAUDE_CODE_OAUTH_TOKEN` or
   `ANTHROPIC_API_KEY` in that machine's `~/.afk/config/afk.env`; both are read
   before the keychain.
2. Key-based SSH from this machine to the remote (`ssh user@host true` works with no
   password prompt).
3. Optional: name hosts in `~/.afk/config/hosts.json`:

```json
{
  "studio": { "ssh": "you@studio.local", "cwd": "~/Projects/my-repo", "unlockKeychain": true },
  "build":  { "ssh": "you@build-box", "permissionMode": "default" },
  "mini":   { "ssh": "mini", "afkPath": "/opt/homebrew/bin/afk" }
}
```

A `host` absent from the file is used as a literal ssh target, so `~/.ssh/config`
aliases work with no setup. `afkPath` is only needed when auto-discovery fails.

### Host fields

| Field | Type | Description |
|---|---|---|
| `ssh` | string | SSH destination (`user@host`, `~/.ssh/config` alias, or `ssh://host:port`). |
| `cwd` | string? | Working directory on the remote (absolute or `~/…`). |
| `afkPath` | string? | Absolute path to the `afk` binary on the remote. Only needed when auto-discovery fails. |
| `unlockKeychain` | bool? | Unlock the remote's macOS login keychain before each run (see [Keychain unlock](#keychain-unlock)). |
| `permissionMode` | string? | Permission mode pinned on every `afk chat` run for this host (any `afk chat --permission-mode` value, e.g. `default`, `plan`, `bypassPermissions`, `autonomous`). When absent the remote resolves its own configured default. |

## Keychain unlock

For a host with `"unlockKeychain": true`, store that machine's login password once,
on the machine you dispatch FROM (it prompts; nothing is echoed):

```bash
security add-generic-password -U -s afk-remote-unlock -a studio -w
```

The account (`-a`) is the host's name in hosts.json. Every run then reads it from
this machine's keychain, embeds it as a quoted heredoc inside the launch script, and
the remote script feeds it to `security -i` through a pipe to unlock
`~/Library/Keychains/login.keychain-db`, verifies the unlock, clears it, and starts
afk. The password is never on any command line, in a file, or in the trace. Re-run
the command with the new password if the remote's login password changes (the tool
says so when the unlock fails).

Verified on macOS over SSH (2026-10-15), which is why it works this way:

- An SSH session sees the login keychain locked even while the user is logged in at
  the GUI (`errSecInteractionNotAllowed`, exit 36).
- Unlock state is per security session: an unlock in one SSH session is not visible
  to the next. So the unlock must happen inside the launch itself; a one-off
  `ssh -t host security unlock-keychain` does not help later runs.
- The detached afk run stays unlocked after the launch connection closes.

## Tool

`remote_agent { host, prompt, cwd?, model?, resume? }`

- Blocks until the remote run finishes. For long work outside autonomous mode, call
  it from a background `agent`, which is delivered automatically (autonomous mode
  hard-blocks sub-agent calls).
- The result ends with `[remote_agent: host=… session=<id> run=<id>; pass resume="<id>" …]`.
  Pass that session id as `resume` to continue the same conversation on that host.
- Risk class `high` (remote bypassPermissions default): autonomous mode asks for approval in the main session and hard-blocks sub-agents; plan mode refuses it.

## How it works (`src/remote/`)

| File | Role |
|---|---|
| `hosts.ts` | Loads `hosts.json`; validates the ssh target (no leading `-`, restricted charset). |
| `keychain-unlock.ts` | Reads a host's stored login password locally; escapes it for `security -i`. |
| `remote-script.ts` | Builds the POSIX scripts run as `exec /bin/sh -s` on the remote (script on stdin, payloads as heredocs). |
| `ssh-runner.ts` | Spawns local `ssh` (`BatchMode`, `ConnectTimeout=5`, ServerAlive probes). Injectable. |
| `remote-run.ts` | Launch → follow → result; reconnect; cancel on abort. |
| `remote-events.ts` | Tolerant parser for `afk chat --format stream-json` events. |

1. **Launch.** One ssh call: the prompt is embedded inside the script as a quoted
   heredoc and written to `~/.afk/state/remote-runs/<runId>/prompt` (never interpreted
   by any shell). stdin carries only the script itself. afk is located, and
   `nohup afk chat --format stream-json` starts detached, writing `out.ndjson`,
   `err.log`, and `pid`. A dropped connection or a sleeping laptop does not kill the run.
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
- **Permissions.** The remote `afk chat` runs under its own configured
  `permissionMode`, which defaults to `bypassPermissions`. The launcher injects
  `--permission-mode <value>` only when the host entry pins `permissionMode`.
  Because a destructive prompt could therefore bypass the local AFK gate,
  `remote_agent` is classified **risk class high** and autonomous mode holds it
  for approval.

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
