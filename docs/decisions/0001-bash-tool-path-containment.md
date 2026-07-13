# ADR 0001 — Bash tool path containment

Status: **Accepted**

Tracked as **C4** (see [`CHANGELOG.md`](../../CHANGELOG.md)). Closes issue #354.

---

## Context

Every typed filesystem handler (`read_file`, `write_file`, `edit_file`, `glob`,
`grep`, `list_directory`) routes each path argument through
`resolveAndContain` in
[`src/agent/tools/handlers/_cwd-utils.ts`](../../src/agent/tools/handlers/_cwd-utils.ts).
That function resolves the path (following symlinks via `realpathSafe`) and
throws when it falls outside the session's `readRoots` / `writeRoots`. This is
how a confined session — an `afk -w` worktree, or a forked sub-agent — is kept
from reading or writing outside its granted roots.

The bash handler
([`src/agent/tools/handlers/bash.ts`](../../src/agent/tools/handlers/bash.ts))
did **not** participate in this containment. It spawns commands with
`shell: true` and only set the child's `cwd`; it never consulted
`readRoots` / `writeRoots` and never routed anything through containment. The
gap is structural, not an oversight: with `shell: true` the command is an
**opaque string** interpreted by the OS shell. There is no reliable, general
way to know which paths a command will touch — pipes, redirections, subshell
and arithmetic substitution (`$(…)`, backticks), environment-variable
indirection (`$HOME`), and globbing can all synthesize paths at runtime. A
model running inside an isolated worktree could therefore still read or write
outside it via bash (e.g. `cat /etc/hosts`, `echo x > ~/.ssh/authorized_keys`),
even though the typed file tools would have refused.

Issue #354 offered two acceptance paths: (1) have the bash handler enforce/scan
the roots for absolute paths it can extract, or (2) document an architectural
decision explaining why the gap is accepted. This ADR does **both** — it adopts
a best-effort scan *and* records the reasoning and residual limits.

## Decision

1. **Adopt best-effort, advisory path scanning now.** Before spawning, the
   handler extracts absolute and home-relative path tokens from the command
   string (`extractCandidatePaths`) and checks each against the session's
   **write** roots via `wouldBeRestricted(…, 'write', …)`. `writeRoots` is the
   stricter and most relevant boundary for the "escape the worktree" threat, and
   in practice `readRoots ⊇ writeRoots` for confined forks. On the first
   out-of-root reference the handler emits one `[security]` `console.warn`
   naming the escaping resolved paths and one `tool.bash_path_escape` telemetry
   row (counts + `mode` only — never the raw command string, per the audit
   §G.4 privacy rule already followed for overflow-kill telemetry).

2. **Warn-only — never refuse.** The scan does not block execution. Issue #354
   floated a "Tier-1" idea: refuse to run bash when `writeRoots` is set *and*
   `permissionMode === bypassPermissions`. We explicitly **reject** that
   fail-closed refusal. A top-level `afk -w` session runs under
   `bypassPermissions` **and** carries a non-empty effective
   `writeRoots = [worktree]`, so a refusal keyed on that condition would break
   the primary human-driven worktree workflow. Forked sub-agents run
   `permissionMode = 'default'` (they do **not** inherit bypass), so they would
   never be refused anyway — meaning the refusal would only ever fire on the
   legitimate top-level session. Warn-only preserves the workflow while making
   the risk observable in logs and telemetry.

3. **Defer full containment.** A full `execFile`-based refactor that disables
   the shell (and could then contain paths precisely), or an OS-level sandbox,
   remains the long-term fix and is still tracked under C4. Building a shell
   parser to close the substitution/indirection gaps is a deliberate non-goal —
   issue #354 calls it a rathole, and a partial parser would give a false sense
   of containment.

Under `allowAll` (bypass) `wouldBeRestricted` short-circuits to
not-restricted, and an unconfined session (no `resolveBase`) is likewise never
restricted — so those sessions produce zero warnings without any special-casing
in the handler.

## Threat model accepted

The accepted model, per the issue, is **single-user-on-laptop with trusted task
descriptions**: the human operator drives the session and is assumed not to be
feeding it adversarial prompts crafted to exfiltrate their own files. Under that
model the residual gap is an advisory concern (catch accidental out-of-worktree
writes, keep the risk surface visible) rather than a hard security boundary. AFK
is **not** hardened for running fully untrusted, adversarial task input through
bash in `bypassPermissions`; that would require the deferred execFile/sandbox
work.

## Consequences

**Covered** by the best-effort scan:

- Direct absolute path references (`/etc/hosts`, `/tmp/outside/x`).
- Home-relative references (`~/…` and a bare `~`), expanded to `os.homedir()`
  before the containment check.
- Quoted path tokens and paths abutting common shell punctuation
  (`;`, `,`, `)`).
- Paths glued to a leading redirection/pipe operator with no space
  (`>/etc/passwd`, `>>~/.bashrc`, `2>/tmp/err`, `|/tmp/x`) — the leading
  operator run (and any fd prefix) is stripped before the containment check.

**Not covered** (documented limitations — the reason this is advisory, not a
boundary):

- Command / arithmetic substitution: `$(printf /etc/hosts)`, backticks.
- Environment-variable indirection: `$HOME/.ssh`, `${SECRET_DIR}`.
- Glob and brace expansion: `/etc/*`, `/a/{b,c}`.
- Here-docs (`<<EOF`), paths synthesized across tokens, or quoted paths
  containing whitespace.

Operational impact: a confined session that references an out-of-root path via
bash still runs, but the operator sees a one-time `[security]` warning and a
`tool.bash_path_escape` row in `routing-decisions.jsonl`. Bypass and unconfined
sessions are unaffected (no warnings). No existing bash behavior changes.

## References

- [`src/agent/tools/handlers/bash.ts`](../../src/agent/tools/handlers/bash.ts) —
  `createBashHandler`, `scanPathsBestEffort`.
- [`src/agent/tools/handlers/_cwd-utils.ts`](../../src/agent/tools/handlers/_cwd-utils.ts) —
  `extractCandidatePaths`, `wouldBeRestricted`, `resolveAndContain`.
- [`CHANGELOG.md`](../../CHANGELOG.md) — C4 entries.
- Issue #354 — "security: bash tool has no readRoots/writeRoots containment
  (tracked C4)".
