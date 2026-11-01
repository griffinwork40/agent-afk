# Unattended budget defaults (partial #2194)

Daemon tasks (including cron, sessionstart and pull) and Telegram sessions now
receive a **$5 cumulative session budget** and **100 root tool-use rounds per
turn** when limits are unset. The defaults are intentionally conservative and
provider-independent. They reuse the existing budget accounting and provider
wind-down mechanisms; they do not add another governor.

REPL, `afk chat`, SDK-created sessions and subagent defaults are unchanged.

## Configuration and precedence

Explicit `AgentConfig.maxBudgetUsd` / `maxToolUseIterations` values win over
`AFK_MAX_BUDGET_USD` / `AFK_MAX_TOOL_USE_ITERATIONS`, which win over the unattended
defaults. For example, `AFK_MAX_BUDGET_USD=10` and
`AFK_MAX_TOOL_USE_ITERATIONS=150` raise the unattended allowance. Telegram factory
callers can also provide explicit session limits.

- Empty or whitespace-only environment values select the unattended default.
- Invalid dollar values (negative/non-finite/non-numeric) warn without echoing
  their contents and select $5; invalid/non-finite round values select 100.
- Numeric round values <=0 retain the existing unlimited-round escape hatch.
  Positive fractions are floored, with a minimum of one round.
- Dollar zero retains the existing zero-ceiling sentinel. It is **not** an
  unlimited setting and does not guarantee no initial request is billed.
- Explicit config values retain their existing semantics, including round zero.

## Enforcement limitations

This is a **bounded first-slice proposal, not the complete pause governor**.
Dollar cost is observed at root-turn and child-completion boundaries, not
reserved before every inference. In-flight work, tool rounds within a turn,
concurrent children and the final tools-stripped wind-down inference may incur
cost before enforcement sees it. Models without price data cannot be bounded
by dollar accounting; the root round cap remains useful but does not cap child
spend. Round limits are per turn, not a lifetime tree-wide work limit.

Consequently this change **does not promise zero dollar overshoot**. At a dollar
breach the existing abort path still runs; at the root-round cap the existing
provider wind-down path still runs. Telegram sessions accumulate their dollar
budget over the session, rather than receiving a fresh allowance per message.

## Remaining acceptance for #2194's first slice

- Send deduplicated Telegram notifications at 80% and 100% of the accounted
  dollar budget, including child-completion crossings, routed to the originating
  chat/topic when known; notification failures must not bypass enforcement.
- Persist a host-owned durable budget handoff before notification on dollar or
  root-round exhaustion. Existing elicitation rejects an already-aborted signal,
  so simply invoking `ask_question` after budget abort is insufficient.
- Park unattended work until explicit operator approval, survive restart, and
  preserve cumulative spend/identity/cwd while granting an explicit additional
  allowance on resume. Do not silently reset the allowance or repeat side effects.
- Exercise all breach/resume paths with deterministic mocks (no real Telegram
  notifications) and report paused-for-approval versus aborted outcomes.

Later loop/stall recovery, missing-child reporting, model step-down, goal judges,
quality/evidence packets and reactive event ingress remain outside this proposal.
