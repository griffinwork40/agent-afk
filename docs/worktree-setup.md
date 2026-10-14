# Repo-declared worktree setup (`.afk/worktree-setup.json`)

Agent-created worktrees start with none of the main checkout's ignored files:
no `node_modules`, no nested-package installs, no generated artifacts. A repo
can opt in to a post-create setup step that afk runs once in every worktree it
creates (#3601).

## Declaration

Commit `.afk/worktree-setup.json` at the repo root:

```json
{
  "commands": [
    "pnpm install --frozen-lockfile",
    "pnpm --dir dashboard install --frozen-lockfile"
  ],
  "timeoutMs": 300000
}
```

- `commands` (required): non-empty shell command strings, run in order with
  the new worktree as cwd, through the platform shell (`resolveShell()`:
  `/bin/sh` on POSIX, Git Bash or PowerShell on Windows). Setup stops at the
  first command that fails.
- `timeoutMs` (optional, default 300000 = 5 min): budget for each command. On
  expiry the command's process group is killed.

The file is read from the **new worktree**, so the declaration that applies is
the one at the worktree's base commit. No file means no setup, and creation
behaves exactly as it did before this feature.

## When it runs

Setup runs inside `createManagedWorktree`, after `git worktree add` and after
`.afk-worktree-meta.json` is written, so the sweep engine never sees a
meta-less tree while setup is running. That covers all three managed-create
callers:

| Caller | Abort signal | Where a failure is reported |
|---|---|---|
| `worktree` tool, `create` action | the tool call's signal | the create response's `note` |
| `agent` tool, `isolation: "worktree"` | the tool call's signal | prepended to the child's prompt **and** to the parent's tool result (foreground and background) |
| `compose` node, `isolation: "worktree"` | the node's signal (node timeout, fail-fast, parent abort) | prepended to the node's prompt **and** to the node's output in the compose result |

### Best-effort contract

A setup failure, timeout, abort, or invalid declaration **never fails worktree
creation**. The worktree is returned and usable, and the notice names the
exact command so the reader can re-run it. Setup errors are returned as values,
never thrown, so they can't reach the isolation path's `LOCK_CONTENTION` retry
and re-run `git worktree add` on a branch that already exists.

### `afk -w` is not covered

The `afk -w` / `afk interactive --worktree` launcher creates its worktree
through its own path (`src/cli/commands/interactive/worktree.ts`), not
`createManagedWorktree`, and it does not run setup. This is deliberate:

- An operator is present, so a missing install is visible at once and costs
  one command, unlike a background subagent that fails opaquely partway
  through a run.
- That path defers `git worktree add` until the session has a name, and it
  sits on the REPL's startup path. A multi-minute install there would block
  the prompt with no progress UI.

Run the declared commands yourself after `afk -w` starts, or ask the agent to.

## Trust model

The commands come from the repository's own committed file. Running them
carries the same trust as running that repository's package scripts (`pnpm
install` already runs its lifecycle scripts). afk adds no new authority: the
commands run as the current user, in the new worktree, with the same
environment the `bash` tool gets (minus scrubbed episode variables).

This is why the feature is opt-in per repo and is not gated by the user-global
`enableShellHooks` / `allowProjectHooks` flags. Those flags gate **hooks**,
which fire on agent events in any session. Worktree setup is narrower: it runs
only when afk creates a worktree of that same repo, a step whose purpose is to
run that repo's code. If you would not run a repo's `pnpm install`, don't let
an agent create worktrees in it.
