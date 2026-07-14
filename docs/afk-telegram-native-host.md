# AFK Telegram-native host (architecture "D") — feasibility + risk brief

**Status:** Design + risk record. The v1 slice below is IMPLEMENTED (gate wired for Telegram, `/afk` command, high-risk hard-refuse); the v2 items remain deferred. 2026-07-14. Branch `afk/afk-mode-cli-telegram`.
**Question:** should AFK sessions run *natively inside the always-on Telegram bot* (one persistent process owns both the agent loop and phone I/O), instead of the CLI-REPL + ledger-relay + separate-watcher design the F-series audit patched?

## Verdict (one line)

**Feasible and architecturally right — it deletes the whole class of bugs the audit patched — but it must be staged and safety-gated: there is one CRITICAL blocker (the AFK risk ceiling is not wired on Telegram), a durability gap (restart loses a pending question), and a containment gap (no trusted narrow root).**

## Why D is attractive

The audited failures (F1 relay buttons, F3 silent phone-leg failures, F5 reply dead-end) are all artifacts of the **two-process ledger bridge**. In D there is no bridge: elicitations use the **native** Telegram handler (already correct), so:
- **F1 doesn't exist** — the native path composes `askHandler + formHandler`; approve/deny forms render as `afk:pa:` buttons and return `content.choice`, which the gate reads. (`bot.ts:352`, `elicitation-telegram.ts:197,315`, `afk-mode-gate.ts:227`.) D bypasses the relay by construction.
- **"Answer whenever" is FREE within a process lifetime** — the bot has **no session idle/TTL** (`session-manager.ts`, in-memory `Map`), dispatches every update **detached** (`bot.ts:252-260`) with a per-chat queue (`handlers/message.ts:113`), so one chat blocked on a question holds it open indefinitely while other chats keep working. On an always-on host, "close the laptop, answer later" works.

## Feasibility by dimension (all read-only, cited)

1. **Promote a Telegram session to `autonomous`:** trivial at the API layer — `AgentSession.setPermissionMode('autonomous')` (`agent-session.ts:838` → provider `query.ts:628`); no provider self-escalation guard. `settable-keys.ts:228` marks `permissionMode` human-tier but that only blocks the `config_set` *tool*, not a host call (same as the REPL's `afk-mode-toggle.ts:58`). Telegram builds sessions with `permissionMode` omitted → `'default'` (`telegram.ts:425-437,476`).

2. **CRITICAL BLOCKER — the AFK safety ceiling is NOT registered on Telegram.** `createDefaultHookRegistry` registers the plan-mode AND afk-mode gates only inside `if (getPermissionMode !== undefined)` (`default-hook-registry.ts:141-162`). Telegram passes `undefined` for that arg (`telegram.ts:429` arg4; codex branch `:493`). **Verified directly.** So a naive "promote to autonomous" on Telegram today = an autonomous agent with **no risk-classifier ceiling** — and since `autonomous` also bypasses path-approval via `allowAll` (`permission-policy.ts:36-40`), there would be *zero* path containment. This must be fixed *before* any autonomous promotion is allowed on Telegram.

3. **Durability across bot restart — NOT free.** A pending elicitation is an in-memory `Promise` closure (`handlers/message.ts:141`); on process restart it is lost. Only *completed* turns persist (per-turn `saveSession`), so a conversation resumes but the *pending question* does not. Restart-survival would require porting the ledger `elicitation`/`elicitation_response` protocol (`session-ledger.ts:80-82`, already built for the watch path) into the hosted-session path. (v2.)

4. **Containment — weak.** The gate's workspace-escape rule needs a trusted `workspaceRoot`; on Telegram the root is just the session cwd (`data.cwd` via `/cd` ?? `AFK_TELEGRAM_CWD` ?? default; `session-manager.ts:563-603`), never a narrow managed worktree. A broad cwd (`$HOME`, `/`) makes the escape ceiling nearly toothless (the `~/.ssh` / `/etc` / `.git` denylist still fires — `risk-classifier.ts:174-183` — but little else). `getCwd` handed to Telegram is a *static* closure (`telegram.ts:435`); acceptable only because `/cd` rebuilds the session.

5. **Initiation UX:** adding a `/afk [task]` command is mechanically trivial (`bot.command` + `setMyCommands`), but it is **not UI-only** — it requires wiring the gate (dimension 2) first. No permission-mode toggle exists on Telegram today (REPL-only).

## Risks (ranked; blast-radius of a persistent autonomous phone-driven agent)

1. **Single-tap approval of irreversible ops with near-zero context** — the approval prompt shows tool name + a 300-char redacted preview (`afk-mode-gate.ts:311-315`), no diff/dry-run/2FA. One phone tap could authorize `rm`, `git push --force`, `dd`, MCP `delete`/`deploy`, schedule mutations. This is the genuinely new/scary delta vs laptop-REPL AFK.
2. **Weak/broad containment root** (dimension 4) — the sole path-safety layer in AFK, near-inert under a broad cwd.
3. **Persistence multiplies exposure** — always-on service, `data.cwd` survives restart (`session-manager.ts:41-42`); an allowlisted chat is a *standing* capability, not a session-bounded one. Auto-subscribe already makes the phone a live control surface (`bot.ts:538-583`).
4. **Approval-context confusion across concurrent chats** — one process, many chats, shared module-scope `elicitationRouter`; a phone prompt may be hard to attribute to the right chat/task.
5. **Coarse shared allowlist** — any allowlisted chat can `/afk`, `/cd` anywhere, approve anything; no per-chat capability tiers (`allowlist.ts:20-56`).
6. **Bash gate is best-effort, not a sandbox** (`afk-mode-gate.ts:72-75`).

## Recommendation

**Pursue D, staged, with a safety-first v1.** This also revises the earlier "keep-and-fix" fork *for the D context*:

- **v1 (the safe, high-value slice):**
  1. **Wire the gate for Telegram** — thread a real `getPermissionMode` (per-chat mode mirror, surviving restart) + the live `getCwd` into the two `createDefaultHookRegistry` call sites (`telegram.ts:429,493`). NON-NEGOTIABLE and must land *before* autonomous is reachable on Telegram.
  2. **Add `/afk` on Telegram** — promote/demote the chat's session; mirror mode onto `SessionStats.permissionMode` and persist it.
  3. **Hard-refuse high-risk in the persistent host** — set `promptForApproval: false` (`afk-mode-gate.ts:104-106,297`) so high-risk/irreversible ops degrade to hard-block + Asking summary rather than a phone tap. i.e. **keep-and-fix stays for the laptop REPL; the always-on host gets fail-closed.** Rationale: a phone tap from a standing always-on allowlisted chat with a possibly-broad root removes every mitigating assumption keep-and-fix relied on (bounded session, deliberate arming, trusted narrow worktree, present operator with full context).
  4. "Answer whenever" for *questions* is inherited free (no TTL + persistent host).

- **v2 (hardening, only if remote high-risk approval is wanted):** trusted narrow per-chat worktree root; per-chat autonomous/approve capability tiers; richer approval context (diff/dry-run, unambiguous chat attribution); restart-durable pending elicitations (port the ledger protocol).

## Open decisions for the operator
1. Green-light D v1 (gate-wiring + `/afk`-on-Telegram + **hard-refuse** high-risk)?
2. Safety posture: accept hard-refuse-high-risk in the always-on host (recommended), or insist on phone-approval there (requires v2 hardening first)?
3. Require AFK-on-Telegram to run in a narrow trusted cwd/worktree (mitigates the toothless-ceiling risk)?

## Not verified (spike limits)
- No runtime execution / tests run.
- Codex/openai-compatible Telegram branch line-verified only at the head (`telegram.ts:465+`); shares the same `getPermissionMode=undefined` rationale comment.
- `resumeHistory` fidelity (tool-call/subagent state on resume) — likely text-only (`resume-session.ts:58-61`).
- git history of the "permissionMode omitted (post-C2 fix)" decision.
