# Scoping: bash tool `execFile` migration (C4)

Status: **Scoping only — no implementation.**
Prepared: 2026-09-30

---

## Plain-language summary (non-technical reader)

The bash tool runs shell commands by handing the entire command string to the
operating system's `/bin/sh` interpreter. This is the right design for the
tool's stated contract ("run this shell command string"), but it means the tool
cannot reliably know in advance which files the command will touch — a command
can build a path at runtime using variables, substitutions, or pipe tricks that
no static scanner can fully see.

"C4" is the project's label for this acknowledged gap. A previous sprint
(issue #354, ADR 0001) added a best-effort advisory warning and documented the
threat model. The current warning suggests migrating to `execFile` as the fix.

This scoping report argues that the `execFile` framing is misleading: the
useful security question is not "how do we replace `spawn`?" but "what threat
does C4 actually name, and is there a proportionate response?" The analysis
finds the threat is already well-mitigated for the stated threat model (trusted
single user on their own machine). Removing or tightening the misleading
warning text is the highest-value low-cost action. A real containment
improvement, if ever needed, would require an OS-level sandbox — not a Node
spawn-API change.

**Verdict: REFRAME — do not migrate to `execFile` as described; instead, fix
or remove the warning copy and improve the hook layer.**

---

## 1 — What is C4?

**Origin:** C4 is an internal tracking label for the security hardening pass
that accompanied the initial `bypassPermissions` / worktree isolation work.
It appears in the `CHANGELOG.md` at two entry points:

1. *First use* (earlier entry, `CHANGELOG.md:9667`):  
   "C4 — bash handler now emits a one-time `[security]` warning to stderr when
   `AFK_PERMISSION_MODE=bypassPermissions`, surfacing the shell-injection risk.
   Full `execFile` migration is deferred (tracked C4)."

2. *Second use* (later entry, `CHANGELOG.md:5388`, closes issue #354):  
   "C4 — bash handler now runs a best-effort, advisory-only readRoots /
   writeRoots path-containment scan … Full `execFile`/sandbox containment
   remains deferred (tracked C4)."

The **formal definition** is in `docs/decisions/0001-bash-tool-path-containment.md`
(line 5): *"Tracked as C4 … Closes issue #354."* Issue #354 (`gh issue view 354`)
is titled "security: bash tool has no readRoots/writeRoots containment".

**Threat named by C4:** A model inside an isolated worktree (e.g. `afk -w`
farm branch, forked sub-agent) can still `cat /etc/hosts`, `cp ~/.env /tmp/x`,
or write outside its granted `writeRoots` via bash, because the bash handler
passes the raw command string to the OS shell and cannot reliably intercept
runtime-synthesised path references. The threat model is explicitly
**single-user-on-laptop with trusted task descriptions** (ADR line 66); C4
is an advisory signal, not a hard security boundary. Issue #354 (now closed)
confirmed: the PR adding the best-effort scan *and* the ADR was the accepted
resolution; C4 work items therefore have their primary deliverable behind them.

**Key file:line citations:**
- `src/agent/tools/handlers/bash.ts:90–96` — JSDoc describing the gap and deferral
- `src/agent/tools/handlers/bash.ts:126–134` — `warnIfBypassPermissions()` emitting the C4 warning
- `src/agent/tools/handlers/bash.ts:169` — path-escape advisory warn
- `docs/decisions/0001-bash-tool-path-containment.md:5` — C4 canonical reference
- `docs/decisions/0001-bash-tool-path-containment.md:66` — "execFile/sandbox remains deferred"
- `CHANGELOG.md:5388` — C4 changelog entry
- `CHANGELOG.md:9667` — C4 earlier entry

---

## 2 — Current execution path

### How the command string reaches the OS

```
model emits { command: "ls -la | grep foo" }
  → parseBashInput()          [bash.ts:43] validates string + timeout_ms
  → warnIfBypassPermissions() [bash.ts:118] one-time warn in bypass mode
  → scanPathsBestEffort()     [bash.ts:148] advisory best-effort path scan
  → resolveShell()            [resolve-shell.ts:72] 
       POSIX → { shell: true }   (no-op; Node picks /bin/sh)
       Windows → { shell: gitBash, args:['-c'] } or PowerShell fallback
  → spawn(command, { shell: true, detached: true, stdio, cwd, env })
       [bash.ts:280]
       cwd priority: context.resolveBase > context.cwd > factory cwd > process.cwd()
       env: scrubBashEnv({ ...process.env, ...context.env })  [bash-env-scrub.ts]
  → SIGKILL on timeout or abort (kills entire process group via detached)
  → output capped: HARD_CAP_BYTES=8MB accumulator; MODEL_CAP_BYTES=100KB view
  → head+tail model view, ANSI stripped, testResult detection
```

On POSIX the `shell: true` path is exactly `spawn(command, { shell: true })` —
Node executes `/bin/sh -c <command>`, so every POSIX metacharacter (`|`, `&&`,
`>`, `$()`, `${VAR}`, `~`, globs) is interpreted by the shell. This is the
correct, intended behaviour for the tool's contract.

### Other product-code `shell: true` / shell-string sites

| File | Context | Uses shell: true? |
|---|---|---|
| `src/agent/tools/handlers/bash.ts:280` | Model-facing bash tool | Yes (via `resolveShell()`) |
| `src/agent/hooks/command-executor.ts:217` | Config-driven hook executor | Yes (via `resolveShell()`) |
| `src/agent/shell-jobs/streamer.ts:262` | `!cmd` REPL passthrough (user-typed) | Yes |
| `src/skills/score/index.ts:257` | Score skill shell runner | Yes |
| `src/agent/daemon.ts:375` | `executor: 'shell'` scheduled task runner | Uses shell executor path |

Non-shell paths for comparison: `src/agent/gh.ts:266` (execFile, no shell), 
`src/utils/git.ts:106` (execFileAsync, no shell), 
`src/agent/awareness/workspace-source.ts:11` (spawnSync, no shell — explicitly documented).

---

## 3 — Options

### Option A: `execFile(shell, ['-c', command])` — the warning's literal suggestion

**Description:** Replace `spawn(command, { shell: true })` with
`execFile(resolvedShell, ['-c', command])` (POSIX) /
`execFile(gitBash, ['-c', command])` (Windows).

**Security gain against C4:** **None.** The shell still interprets every
metacharacter. `/bin/sh -c "cat ~/.ssh/id_rsa"` is identical to
`spawn('cat ~/.ssh/id_rsa', { shell: true })`. The shell is still invoked; the
command string is still opaque. The warning text is simply wrong about what
`execFile` would achieve in this form.

**Compatibility cost:** Potentially high. On POSIX, process.kill behaviour
changes slightly (PID is now the shell, not the parent), and `detached: true`
process-group semantics differ slightly between `spawn` with `shell: true`
(Node handles the shell wrap) versus an explicit `execFile`. In practice, both
would spawn `/bin/sh -c <cmd>` and be SIGKILL'd via the process group.
Functionally equivalent but meaningfully different in that the warning goes away
without any real safety improvement — misleading.

**Cross-platform:** Minor — `resolveShell()` already abstracts this; the
`execFile` form would use the same resolution.

**Effort:** Low (< 1 day). Two spawn call sites in `bash.ts`; tests in
`bash.test.ts` would need updating for the new spawn form, posix-guard R1 rule
may need a skip for the explicit shell invocation.

**Verdict:** ⚠ Do not do this. It removes the warning without improving safety,
and adds complexity for zero benefit.

---

### Option B: argv-only `execFile` with shell-free parsing or fallback

**Description:** Parse the command string into argv (detecting whether it
contains shell metacharacters) and run simple commands via `execFile(prog, args)`
without any shell. Fall back to shell for complex commands (those containing
pipes, redirects, etc.).

**Security gain against C4:** Partial. Shell-free path would contain paths for
simple commands. But the fallback path (which covers virtually all agent
commands — pipes, `&&`, heredocs, `cd x && ...`, globs) is the existing shell.
So real agent workflows always fall back, and the gain is near-zero for the
actual C4 threat.

**Compatibility cost:** Very high. Agents rely almost exclusively on features
that require a shell: `echo a | grep b`, `cd /repo && git log`, `find . -name
'*.ts' | head -10`, here-docs, command substitution in test scaffolding. Any
metacharacter triggers the fallback path. The only commands that truly avoid the
shell are trivially simple invocations (`ls`, `echo hello`), which are not the
interesting case. A partial parser would also create a false sense of
containment (a partial parser can be fooled, and now the fallback is a
different, less-tested code path).

**Cross-platform:** Very high complexity — shell metacharacter sets differ
between POSIX and Windows; `%VAR%` vs `$VAR` etc.

**Effort:** Very high. Requires a reliable shell metacharacter detector,
split-execution logic, distinct test coverage for both paths, posix-guard
updates. Estimated 2–3 weeks of careful work plus a long tail of edge-case
bugs.

**Verdict:** ❌ Not worth doing. Near-zero security gain for the actual threat,
massive compatibility risk.

---

### Option C: OS-level sandboxing (macOS `sandbox-exec`, Linux `bwrap`/Landlock)

**Description:** Wrap the spawned shell process in an OS-enforced namespace or
sandbox that restricts which filesystem paths it can access. On macOS:
`sandbox-exec -p '(allow default) (deny file-write-data (subpath "/etc"))'`.
On Linux: `bwrap` (bubblewrap), `firejail`, or Landlock (kernel-level). On
Docker: drop capabilities, mount only the workspace.

**Security gain against C4:** **Maximum.** The OS enforces the boundary
regardless of what shell metacharacters, variable indirection, or subshell
tricks the command uses. This is the only approach that truly closes the
structural gap — noted explicitly in both the ADR (line 66: "an OS-level
sandbox, remains the long-term fix") and in `bash-restriction-hook.ts:18–22`.
The codebase already references `sandbox-exec`, Landlock, and bubblewrap as the
right answer for adversarial containment.

**Compatibility cost:** Non-trivial. `sandbox-exec` is deprecated in recent
macOS Xcode releases (though still works). `bwrap` is not installed by default
on most Linux distros. Cross-platform implementation is complex. Profiling
overhead is real for every bash call. Networking and device access rules add
configuration complexity. Some legitimate agent commands (package installs that
write to `~/.local/`) would break under strict policies.

**Cross-platform:** High cost. Three entirely different implementations
(macOS, Linux, Windows — Windows has no equivalent, only Docker isolation).

**Effort:** Very high. 4–8 weeks for a robust, cross-platform, well-tested
implementation. Only justified if the threat model shifts from "trusted single
user" to "untrusted or adversarial input."

**Verdict:** 🔵 Correct long-term direction IF the threat model changes, but
**not proportionate to the current threat model**. Worth a tracking issue for
future work if daemon/cloud-hosted operation is pursued. Not a first PR.

---

### Option D: Allowlist/denylist or approval gating in bypass mode

**Description:** Extend the existing `bash-restriction-hook.ts` (which already
blocks access to credential paths like `~/.ssh/id_rsa`) with:
(a) a tighter denylist of patterns, or
(b) prompt the user for approval when the command references an out-of-root
path in bypass mode, or
(c) disable bypass mode by default (switch `DEFAULT_CLI_PERMISSION_MODE`).

**Security gain against C4:** Moderate for (a)/(b), low for (c) (it just
moves the risk to opt-in). The hook is already the right architectural layer
for string-based filtering — it's a PreToolUse hook, has access to the grant
manager, and can block or prompt. Current coverage: credential paths
(`~/.ssh`, `.aws`, `/etc/shadow`, etc.) plus the interpreter-eval guard.
Extending coverage would catch more accidental escapes, though not adversarial
ones (Turing-complete bypass).

**Compatibility cost:** Low if additive (new patterns). Higher if more
aggressive (frequent prompts would interrupt normal agent flows). The ADR
explicitly rejected refusal keyed on `bypassPermissions` + non-empty
`writeRoots` (section 2, line 2 of Decision) because it would break the
primary `afk -w` worktree workflow.

**Cross-platform:** Low — pure TypeScript string matching.

**Effort:** Low to medium. Adding denylist patterns: 1–2 days.
Adding approval prompts for specific cases: 3–5 days.

**Verdict:** ✅ Best marginal improvement for low cost, within the existing
architecture. Extend the hook cautiously; do not add prompts that fire on
normal worktree usage.

---

### Option E: Leave as-is and fix or remove the misleading warning

**Description:** The warning at `bash.ts:129–134` says "Migrate to execFile to
eliminate this risk." As shown in Option A, `execFile(shell, ['-c', cmd])` does
not eliminate the risk. The warning text is inaccurate and should be corrected
or removed. Additionally, the `// tracked C4` annotation is a dangling
reference — issue #354 is **closed** and the ADR is **accepted**. The primary
C4 deliverable is done.

**Security gain:** None vs. current, but improves accuracy: future engineers
will not chase a misleading migration.

**Compatibility cost:** None.

**Cross-platform cost:** None.

**Effort:** Trivial (< 2 hours). Update or delete the `warnIfBypassPermissions`
body; update the JSDoc comment at lines 90–96; optionally remove the dangling
tracking reference now that issue #354 is closed.

**Verdict:** ✅ Should be done regardless of which other option is chosen.
This is the minimum viable PR.

---

## 4 — Blast radius

### Tests that assert current behavior

| File | Scope | Impact of changes |
|---|---|---|
| `src/agent/tools/handlers/bash.test.ts` | Full bash handler behavior (~900 lines; covers all describe blocks) | Any spawn API change breaks the core test suite |
| `src/agent/tools/handlers/bash.test.ts:881` | `describe('bash path-containment scan — C4 (#354)')` — 15+ tests specifically for the advisory scan | Must update if scan behavior changes |
| `src/agent/tools/handlers/bash-scan-exempt.test.ts` | Exempt path list | Must update if exemptions change |
| `tests/posix-guard.test.ts` | R1 rule: forbids literal `/bin/sh` as spawn command or `shell:` value | Explicit shell path in Option A would need a skip annotation |
| `src/agent/tools/handlers/bash-env-scrub.test.ts` | Env var scrubbing | Unaffected |

### Gates that would be touched

| Gate | Trigger | Notes |
|---|---|---|
| **posix-guard R1** (`tests/posix-guard.test.ts`) | Literal `/bin/sh` etc. as spawn command | Option A: needs `// posix-guard-skip R1` if writing `execFile('/bin/sh', ...)` literally |
| **funcsize ceiling** (200 lines, `.funcsize-baseline.json`) | `createBashHandler` is at 386 lines, already **baselined with reason** "legacy: predates the function-size gate; pending helper extraction" | Any Option that adds code will increase the baseline delta; a pure rewrite might allow shrinking the baseline |
| **filesize ceiling** | `bash.ts` is baselined in `.filesize-baseline.json` | Similar note |
| **env audit** (`audit-deps.test.ts`) | New env vars used inside product code | Only triggered if Option C introduces a new env var (e.g. `AFK_SANDBOX_PROFILE`) |

### Docs that would need updating

| Document | Change needed |
|---|---|
| `docs/decisions/0001-bash-tool-path-containment.md` | Update if the Decision changes (Option A/B/C) or to mark warning fix (Option E) |
| `CHANGELOG.md` | Standard changelog entry for whichever option is implemented |
| `src/agent/tools/handlers/bash.ts:90–96` JSDoc | Always needs update; Option E only changes the misleading sentence |
| `src/agent/tools/hooks/bash-restriction-hook.ts:18–22` | Update if OS sandbox is implemented (Option C) |

---

## 5 — Recommendation

### Verdict: **REFRAME** — do not pursue `execFile` migration as described

The proposed migration confuses two distinct concepts:
1. **Spawn API** (`spawn` vs `execFile`): does not affect shell interpretation
   at all if the shell is still invoked with `-c <command-string>`.
2. **Shell invocation** (shell vs. no shell): removing the shell breaks the
   tool's fundamental contract and compatibility with 100% of agent commands
   that use pipes, redirects, or `&&`.

The warning text at `bash.ts:129` ("Migrate to execFile to eliminate this risk")
is technically wrong for the C4 threat. **The execFile form that matches the
model's contract is `execFile(shell, ['-c', command])` — which is identical
in security properties to `spawn(command, { shell: true })`.** A "real"
`execFile` with argv-only parsing would break virtually all agent commands.

### Recommended first PR

**Title:** `fix(bash): correct misleading execFile warning copy (C4 follow-on)`

**Scope:**
1. `src/agent/tools/handlers/bash.ts:129–134` — rewrite `warnIfBypassPermissions` body  
   - Remove the sentence "Migrate to execFile to eliminate this risk"  
   - Replace with accurate text:  
     "Shell metacharacters are interpreted without confirmation.  
     Use `bash-restriction-hook` for path-based gating, or run inside  
     an OS-level sandbox (see `docs/decisions/0001-bash-tool-path-containment.md`)  
     for hard containment."
2. `src/agent/tools/handlers/bash.ts:90–96` JSDoc — replace "(tracked C4)" with  
   "(see `docs/decisions/0001-bash-tool-path-containment.md`; issue #354 closed)"  
   to remove the dangling tracker reference
3. Optional: remove or demote `warnIfBypassPermissions` entirely, since  
   `bypassPermissions` is the **default** CLI mode and the one-time warn fires  
   for every standard user session — adding noise without actionable guidance

**Files touched:** `bash.ts` only. No test changes. No gate changes.
**Risk:** Zero — comment/string changes only.
**Review:** ~1 hour.

### Sequenced follow-ons (priority order)

1. **(Low-medium, Option D extension)** Extend `bash-restriction-hook.ts` with
   additional denylist patterns for common accidental escape patterns
   (e.g. `~/.netrc`, `/etc/sudoers`). Stays within the existing advisory architecture.

2. **(Medium, Option E + D combination)** Add telemetry-only logging when the
   path scan detects an escape in a forked (non-bypass) sub-agent context —
   currently those sessions hit `wouldBeRestricted(…, allowAll=false)` but the
   warning fires only once per handler. Structured telemetry per escape would
   enable dashboarding.

3. **(High effort, Option C — future)** Only if the threat model changes to
   adversarial or cloud-hosted operation: design an OS-level sandbox layer
   (separate config key, opt-in). Start with macOS `sandbox-exec` as a
   prototype; design Linux `bwrap` support in parallel.

---

## Key risks and caveats

| Risk | Severity | Mitigation |
|---|---|---|
| Developer reads the warning, pursues Option A, removes warning without security gain | Medium | This report + accurate warning text |
| OS sandbox (Option C) breaks legitimate agent use (package installs, temp files) | High if C is implemented naively | Opt-in only; extensive policy testing |
| `createBashHandler` (386 lines) already in funcsize baseline — any growth denied | Low | First PR is pure string edits; shrinkage possible if warn function removed |
| hook executor (`command-executor.ts`) also uses `shell: true` but is not labelled C4 | Low | Same threat model; would need same treatment if model shifts |

## Confidence

**High** on the verdict (REFRAME). The `execFile(shell, ['-c', cmd])` identity
is a factual claim about POSIX semantics that can be verified empirically.
The threat model assessment follows directly from the ADR and issue #354.

## Unresolved questions

1. Should `warnIfBypassPermissions` be entirely removed (bypass is the default
   mode — the warning fires for all standard users) or kept with accurate copy?
   This depends on whether the team wants any runtime signal at all.
2. Does the team want to track the OS-sandbox option formally in a new issue,
   or leave it as a docs reference?

## What was not checked

- Runtime behaviour of hook-based approval prompts under daemon/headless mode
  (cannot test without a running daemon)
- GitHub issues beyond #354 (the `gh issue list` call returned no repo results,
  likely a private-repo auth limitation)
- Windows-specific spawn behaviour for `execFile` vs `spawn` forms
  (would require a Windows environment)
- Whether `skills/score/index.ts:257` (`shell: true`) and
  `shell-jobs/streamer.ts:262` share the same threat model and should be
  updated with the same warning-text fix

---

## Report path

`/Users/griffinlong/Projects/open_source/agent-afk/docs/scoping/bash-execfile-migration.md`
