# Threat Model — agent-afk

> **Status:** living document · last reviewed 2026-10-15

agent-afk executes shell commands, reads and writes files, and automates a
browser on behalf of an AI model. It runs with **bypass permissions by default**
and with your OS-level access (SECURITY.md:6). This document makes the trust
assumptions, control classes, and known gaps explicit in one place.

---

## 1. Assets

| Asset | Why it matters |
|---|---|
| **Credentials** | SSH keys, cloud tokens, API keys, browser sessions — readable from `~/.ssh`, `~/.aws`, `~/.afk/config`, etc. |
| **Operator files** | Any file reachable by the OS user running `afk`. |
| **The machine** | Arbitrary code execution via `bash`; network access via the model's web tools. |
| **Outbound identity** | `git push`, Telegram sends, email (gog CLI), and any authenticated HTTP call the model initiates on the operator's behalf. |

---

## 2. Trusted and untrusted parties

**Trusted — full authority:**
- The human operator running `afk`.

**Untrusted — no inherent authority:**
- Web content fetched by `web_scrape` / `web_request` (prompt-injection surface).
- Tool output returned to the model (can contain adversarial text).
- MCP servers (SECURITY.md:54; malicious server responses, SSRF vectors).
- Plugins installed from git sources (SECURITY.md:53).
- Peer session messages — sender identity is not authenticated; accepted risk (docs/peer-messaging.md:212).
- Telegram chats not in `AFK_TELEGRAM_ALLOWED_CHAT_IDS`.
- Model mistakes — the model is trusted to be cooperative, not infallible.

The design premise is **single-user-on-laptop with trusted task descriptions**
(docs/decisions/0001-bash-tool-path-containment.md:78). The operator is assumed
not to be feeding the runtime adversarial prompts crafted to exfiltrate their own
files. AFK is not hardened for running fully untrusted, adversarial task input.

---

## 3. Two classes of control

### HARD BOUNDARIES — meant to hold against adversarial input

These are designed to be difficult to bypass even if the model is actively
adversarial. A bypass here is a security bug.

| Control | What it does | Source |
|---|---|---|
| **Browser domain policy** | Pre-navigation and post-redirect domain allow/block checks on every `browser_open` call; combined with an SSRF egress guard that blocks private/loopback/link-local/cloud-metadata ranges before the browser touches the network. | `src/browser/config.ts:374` (`enforceDomainPolicy`), `src/browser/playwright/index.ts:135-143` |
| **Credential denylist floor** | Blocks bash and typed-file access to `~/.ssh`, `~/.aws`, `~/.afk/config`, `/etc/shadow`, and ~25 other credential roots. The bash and typed-tool denylists are kept in sync so a future entry covers both paths. | `src/agent/tools/hooks/bash-restriction-hook.ts:58-59`, `src/agent/tools/handlers/read-denylist.ts`, `src/agent/tools/handlers/write-denylist.ts` |
| **SSRF / egress guard** | Rejects HTTP requests to private/loopback/link-local/cloud-metadata ranges before they leave the process. | `src/http-client/egress-guard.ts`, `src/agent/tools/handlers/web-scrape.ts:22` |
| **Telegram allowlist** | Inbound messages from chat IDs not in `AFK_TELEGRAM_ALLOWED_CHAT_IDS` are silently dropped; outbound sends are routed only to allowlisted IDs. | `src/telegram/notify-routing.ts` |
| **Web-server / daemon HMAC auth** | Abort requests and elicitation responses on the ledger channel are HMAC-verified per session key; a stray write with a bad HMAC is silently ignored. | `src/agent/afk-ledger-channel.ts:14-17` |
| **Egress secret redaction** | `redactSecrets` strips common token shapes from error text before it is written to the trace `errorHead` or returned to the model. | `src/agent/redact-secrets.ts`, `src/agent/tools/handlers/model-complete.ts:181` |
| **Human-gated config keys** | System prompt, hooks, API keys, and endpoint base URLs cannot be set by the model via `config_set`; the agent receives a hard refusal directing it to the `afk config` CLI. | `src/config/settable-keys.ts:121-123`, `src/config/mutate.ts:88` |
| **No MCP for forks** | Forked sub-agents are built without an `mcpManager`; MCP tools are visible only to the top-level session. Prevents privilege escalation through child dispatch. | `src/agent/tools/permissions.ts:60`, `src/agent/tools/nesting.ts` |

### ACCIDENT GUARDRAILS — stop a well-behaved model's mistakes, not a security boundary

These catch the mutation and access shapes that a cooperative model naturally
emits. Because bash is Turing-complete, any string-based filter has known
bypasses (variable assembly, brace expansion, process substitution — see
`src/agent/tools/hooks/bash-restriction-hook.ts:10-18`). **A determined
adversarial model can circumvent all of these.** A bypass here is a UX/friction
issue, not a security vulnerability.

| Control | What it does | Source |
|---|---|---|
| **Path / bash string filters** | Warn-only scan of bash command strings for out-of-root path references; block typed-file calls outside `readRoots`/`writeRoots`. | `src/agent/tools/hooks/bash-restriction-hook.ts`, `src/agent/tools/hooks/path-approval-hook.ts` |
| **Read-only bash mode** | Blocks high-frequency mutation forms (writes, pipes to interpreter) for recon sub-agents. Classifier is best-effort, default-ALLOW. | `src/agent/tools/readonly-bash.ts:18`, `src/agent/tools/readonly-bash.ts:133` |
| **AFK-mode gate** | Safety ceiling applied when running in AFK (unattended) mode; raises the bar for destructive actions without OS-level enforcement. | `src/agent/afk-mode-gate.ts`, `src/agent/default-hook-registry.ts:231` |
| **Safe-destruct detect** | Observes or blocks destructive command patterns; worktree-scoped patterns (e.g. `git stash` mutating ops) are blocked only inside `.afk-worktrees/` linked worktrees. | `src/agent/safe-destruct-detect.ts`, `src/agent/safe-destruct-patterns.ts` |
| **Release-boundary detect** | Observes sync-boundary commands (publish, deploy, release) to surface them before they escape in interactive sessions. | `src/agent/release-boundary-detect.ts` |
| **Plan-mode gate** | Blocks write-capable tools while `exit_plan_mode` has not been called. Explicitly an honesty guardrail, not a security boundary. | `src/agent/plan-mode-gate.ts:27` |

---

## 4. Design rule

Guardrails must keep a **low false-positive rate**. They are judged on the
friction they impose on normal operator workflows, not on worst-case attacker
models. A guardrail that fires constantly on benign commands is a liability: it
trains the operator to ignore it and erodes the signal that a genuine accidental
access produces. Hard boundaries have no such constraint — they are expected to
block, and a false positive there is an acceptable cost.

When adding a new guardrail, ask: *does this fire on the `2>/dev/null` class of
benign commands?* If yes, either scope it more narrowly or promote it to a hard
boundary with a real enforcement mechanism.

---

## 5. Known gaps

**No OS-level bash sandbox.** The path/bash string filters are advisory.
Claude Code uses `sandbox-exec` (macOS) or `bwrap` (Linux) to contain shell
commands at the OS level; Codex CLI runs with network off by default and scoped
workspace writes. agent-afk does neither — see
`src/agent/tools/hooks/bash-restriction-hook.ts:20-22` and
docs/decisions/0001-bash-tool-path-containment.md for the accepted rationale.
The OS-sandbox work is tracked in #3845 (historically deferred as C4 in CHANGELOG.md).

**Peer message sender identity is not authenticated.** Any process running as
the same OS user can write an envelope with any sender ID. Trust rests entirely
on same-user filesystem ACLs (`0700`/`0600`). Autonomous and bypass receivers
accept peer messages by default (`AFK_PEER_INBOUND=accept`). This is an
explicitly accepted risk (docs/peer-messaging.md:212, operator decision
2026-10-02). The `/inbox` hold path (`AFK_PEER_INBOUND=hold`) is available for
sensitive deployments.

---

## 6. Measuring guardrail friction

Two signals in the witness trace quantify how often guardrails fire:

- **`hook_decision` block events** — every PreToolUse block by a guardrail hook
  is recorded as a `hook_decision` event with `payload.decision = "block"` and
  a `reason` field. Query with `afk trace show` or filter the NDJSON:
  ```
  afk trace show --json | jq 'select(.kind=="hook_decision" and .payload.decision=="block")'
  ```

- **`tool_call` errorHead** — when a tool call returns `isError: true`, the
  trace carries `errorHead`: the first ≤200 characters of the error text (secrets
  redacted). This surfaces denylist rejections, SSRF blocks, and path containment
  errors without storing the full output.

High block rates on a specific hook are a signal to widen an exemption or
reclassify the control, not to tighten it further. See AFK.md (Observability /
tracing) for the full trace schema.
