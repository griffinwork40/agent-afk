# Provider-Agnostic Wire Seam — Spec

**Status:** Draft  
**Worktree:** `example-worktree`  
**Repo:** `~/projects/agent-afk`

---

## Executive Summary

AFK currently bundles the entire Codex CLI agent runtime inside an AFK session. The `openai-codex.ts` adapter spawns Codex as a subprocess harness *inside* AFK's harness — a harness-inside-a-harness. This spec extracts a clean wire seam so:

- AFK owns the agent loop, tool dispatch, hooks, plan mode, compacting, abort graph, checkpoints, plugins, and skills.
- Providers translate between AFK's normalized event/message/tool contract and each model vendor's wire format.
- Auth is resolved from the richest available source (Codex CLI login state, OpenAI env vars, AFK config) without requiring users to log in twice.
- OpenAI-compatible providers (OpenAI direct, Codex-auth-backed, NVIDIA NIM later) share one adapter.

**Anthropic stays green after every phase. Changes are incremental and reversible.**

---

## Anthropic Workaround vs. Codex Equivalent

### 1. Anthropic Auth Path Today

**Source:** `src/agent/providers/anthropic-direct/auth.ts`, `src/agent/providers/anthropic-direct/index.ts`, `src/cli/keychain.ts`

**Priority chain** (`index.ts:293–296`):
```
1. AgentConfig.apiKey           (explicit, runtime override)
2. process.env.ANTHROPIC_API_KEY
3. process.env.CLAUDE_CODE_OAUTH_TOKEN
→ throws if none found
```

**After token resolution**, `detectAuthMode(token)` at `auth.ts:29` shape-sniffs the prefix:
- `sk-ant-oat01-…` → `'oauth'` → injects `anthropic-beta` header, `x-app: cli`, Claude CLI User-Agent, billing system-prompt prefix
- anything else → `'api-key'` → no extra headers, no billing prefix

**Keychain is not in the initial resolution chain.** It is consulted only reactively:
- `loadClaudeCodeOauthToken()` — during usage-limit wait to detect hot-swap (`query.ts:369`)
- `refreshClaudeCodeOauthToken()` — inside a 401 retry closure (`index.ts:398–403`)

**What keychain reads** (`keychain.ts`):
- **macOS:** `security find-generic-password -s 'Claude Code-credentials' -a <macOS-username> -w` → JSON blob
- **Linux:** `readFileSync('~/.claude/.credentials.json', 'utf-8')` → same JSON blob
- JSON blob field: `claudeAiOauth.accessToken` / `refreshToken` / `expiresAt`

**Refresh:** `POST https://platform.claude.com/v1/oauth/token` with `{ grant_type: 'refresh_token', refresh_token, client_id: '9d1c250a-…' }`. Handled in TypeScript by `postTokenRefresh()` in `keychain.ts`.

### 2. Codex Auth Path Today

**Source:** `src/agent/providers/openai-codex.ts:180–184`, `@openai/codex-sdk/dist/index.js:235–236`, `~/.codex/auth.json` (live on disk)

**Priority chain** (`openai-codex.ts:180–184`):
```
1. AgentConfig.apiKey           (explicit, runtime override)
2. process.env.OPENAI_API_KEY
3. process.env.CODEX_API_KEY
→ nothing — let Codex CLI binary read ~/.codex/auth.json at spawn time
```

When a key is found, it is passed as `CodexOptions.apiKey` to `new Codex({apiKey})`. The SDK injects `CODEX_API_KEY=<value>` into the subprocess environment (`@openai/codex-sdk/dist/index.js:235–236`). When no key is found, `codexCfg` is `{}` and the Codex binary handles auth from `~/.codex/auth.json` transparently.

**The TypeScript SDK does zero auth work.** It is a thin spawn wrapper. All auth logic lives in the Rust binary.

**`~/.codex/auth.json` structure** (confirmed on local disk):
```json
{
  "auth_mode": "chatgpt",
  "OPENAI_API_KEY": null,
  "tokens": {
    "id_token":      "<RS256 JWT, ~1h TTL>",
    "access_token":  "<RS256 JWT, ~10d TTL>",
    "refresh_token": "rt_<opaque ~90 chars>",
    "account_id":    "<uuid>"
  },
  "last_refresh": "2026-05-13T05:24:10.362294Z"
}
```

- `auth_mode: "chatgpt"` → ChatGPT OAuth. Uses `access_token` as Bearer against `https://chatgpt.com/backend-api`.
- `auth_mode: "api_key"` → `OPENAI_API_KEY` stored in the file or read from env. Uses against `https://api.openai.com/v1`.

**Refresh:** Handled by the Rust binary. **Critical limitation:** Token refresh does NOT work in `codex exec` mode (the `--experimental-json` mode the SDK uses). Error message extracted from binary: *"chatgpt auth token refresh is not supported in exec mode."* This means ChatGPT OAuth auth silently stops working after the ~10-day access-token window if you're running headless.

**Refresh tokens are single-use.** Two concurrent processes sharing `~/.codex/auth.json` will race and invalidate each other's tokens.

### 3. Similarities

| Property | Anthropic | Codex |
|---|---|---|
| Priority: explicit > env var > fallback | ✅ | ✅ |
| Has a "reuse logged-in CLI auth" path | ✅ (keychain/file read) | ✅ (binary reads `~/.codex/auth.json`) |
| Auth file is human-readable JSON | ✅ (`~/.claude/.credentials.json` / macOS keychain) | ✅ (`~/.codex/auth.json`, mode 600) |
| Has OAuth + API-key dual-mode | ✅ (`sk-ant-oat01-` prefix detection) | ✅ (`auth_mode` field) |
| Token shape-sniff to pick mode | ✅ (prefix detection) | ✅ (`auth_mode` + `OPENAI_API_KEY` null/not-null) |
| Token refresh possible | ✅ (TypeScript, in-process) | ⚠️ Rust binary only; broken in exec mode |

### 4. Differences

| Property | Anthropic | Codex |
|---|---|---|
| Refresh layer | TypeScript (`keychain.ts`), in-process | Rust binary, NOT available in headless exec mode |
| OAuth client id | `9d1c250a-e61b-44d9-88ed-5944d1962f5e` (Claude Code) | `app_EMoamEEZ73f0CkXaXp7hrann` (Codex CLI) |
| Token endpoint | `https://platform.claude.com/v1/oauth/token` | `https://auth.openai.com/oauth/token` |
| Bearer target | `https://api.anthropic.com` (API key) or `claude.ai` (OAuth) | `https://api.openai.com/v1` (API key) or `https://chatgpt.com/backend-api` (ChatGPT OAuth) |
| Refresh token use | Multi-use (can refresh repeatedly) | **Single-use** — next refresh must use new token from last response |
| AFK reads auth file directly | ✅ | ✅ possible (file is plaintext JSON) |
| AFK handles refresh itself | ✅ (`keychain.ts`) | ❌ not yet — would require custom Rust-equivalent in TypeScript |
| Concurrent process safety | Designed for single-session (AFK) use | Single-use refresh tokens → unsafe for concurrent refresh |
| Headless usability | ✅ full | ⚠️ API key only; ChatGPT OAuth refresh broken in exec mode |

### 5. What We Can Safely Copy as an AFK AuthResolver Pattern

From the Anthropic implementation, these patterns are **provider-agnostic and reusable**:

- **`AuthMode` enum + shape-sniff detection** — token prefix → mode → build options. Replace `sk-ant-oat01-` detection with Codex's `auth_mode` field.
- **Priority chain: explicit > env var > file/keychain** — identical pattern for both providers.
- **`buildClientOptions(token, mode)` pattern** — returns `{ authToken }` or `{ apiKey }` depending on mode. For OpenAI: returns `{ bearer: token, accountId? }` or `{ apiKey: token }`.
- **`buildRequestHeaders(mode, ...)` pattern** — mode-conditional headers. For ChatGPT OAuth: `Authorization: Bearer <access_token>`, `ChatGPT-Account-Id: <account_id>`. For API key: `Authorization: Bearer <api_key>`.
- **`refreshPromise` deduplication** (`query.ts:432–446`) — serialize concurrent refresh calls. Required for ChatGPT OAuth since refresh tokens are single-use.
- **`CredentialFileReader` pattern** (`keychain.ts`) — platform-specific file/keychain read behind a clean interface. For Codex: read `~/.codex/auth.json`.
- **`parseAccountIdentifier(token)` pattern** (`keychain.ts:204–220`) — decode JWT payload for display without printing raw token. Reuse for Codex JWTs.
- **Auth source tagging** — `apiKeySource: 'codex-cli-auth' | 'env-OPENAI_API_KEY' | 'env-CODEX_API_KEY' | 'afk-config'` field in `session.init` (already done for Codex at `openai-codex.ts:461–463`).

### 6. What We Should NOT Copy

- `OAUTH_BETA_HEADER`, `CLI_USER_AGENT`, `BILLING_HEADER_TEXT` — Anthropic server-side gate values, meaningless for OpenAI.
- `buildSystemPrefix()` billing text block — Anthropic OAuth billing mechanism.
- `'Claude Code-credentials'` service name, `claudeAiOauth` JSON key — Anthropic-specific.
- The specific `REFRESH_MARGIN_MS = 5min` value may need tuning: Codex `access_token` has ~10-day TTL vs Anthropic's shorter OAuth tokens.
- Direct use of the `security` macOS keychain command — Codex stores auth in a plain JSON file, no keychain.

### 7. Whether Bypassing `@openai/codex-sdk` Would Break Codex CLI Login Auth

**No, it would NOT break access to `~/.codex/auth.json` credentials** — but there are caveats:

For **API key auth** (`OPENAI_API_KEY` / `CODEX_API_KEY`): completely safe to bypass the SDK. Just call `https://api.openai.com/v1/chat/completions` directly with the key as Bearer.

For **ChatGPT OAuth** (`auth_mode: "chatgpt"`): reading `~/.codex/auth.json` and using `tokens.access_token` works for ~10 days. **However:**
- Token refresh is NOT available from TypeScript (it only works in the Rust binary, not in exec mode).
- This means: if you bypass the SDK and the token expires, you need to either (a) surface an error asking the user to run `codex` interactively, or (b) implement TypeScript refresh against `https://auth.openai.com/oauth/token` yourself.
- Refresh tokens are single-use — a custom TypeScript refresh implementation must be the only refresher, not run concurrently with an interactive `codex` session.

**Verdict:** Bypassing the SDK for API key auth is fully safe. For ChatGPT OAuth, it is safe for the 10-day access window; refresh requires new TypeScript code or a fallback prompt.

### 8. Smallest Compatibility Shim if It Would Break

For the ChatGPT OAuth path, the minimal shim is:

```typescript
// Pseudocode — not a file change yet
class CodexAuthResolver {
  async resolve(): Promise<CodexAuthResult> {
    // 1. env OPENAI_API_KEY / CODEX_API_KEY (no file I/O)
    // 2. env CODEX_ACCESS_TOKEN (already-fresh token, skip expiry check)
    // 3. read ~/.codex/auth.json
    //    - auth_mode === 'api_key': return { mode: 'api-key', key: tokens.OPENAI_API_KEY }
    //    - auth_mode === 'chatgpt':
    //        check access_token expiry from JWT exp claim
    //        if valid (> 5min margin): return { mode: 'chatgpt-oauth', accessToken, accountId }
    //        if expired: return { mode: 'chatgpt-oauth-expired', ... }
    //          → caller should surface "run 'codex' interactively to refresh login"
    //          → OR attempt refresh against https://auth.openai.com/oauth/token
    //             with client_id app_EMoamEEZ73f0CkXaXp7hrann and refresh_token
    // 4. no auth: return { mode: 'none' }
  }
}
```

The shim for OAuth refresh needs: one-time-use semantics, single-process owner, write-back to `~/.codex/auth.json`. Mark as Phase 2 optional / Phase 3 full.

---

## Current Auth Map

### Anthropic

| Priority | Source | File:Line | Notes |
|---|---|---|---|
| 1 | `AgentConfig.apiKey` | `index.ts:293` | Explicit override |
| 2 | `ANTHROPIC_API_KEY` env var | `index.ts:294` | Standard API key |
| 3 | `CLAUDE_CODE_OAUTH_TOKEN` env var | `index.ts:295` | OAuth token via env |
| 4 | macOS Keychain (reactive, 401 only) | `keychain.ts:103–123` | `security find-generic-password -s 'Claude Code-credentials'` |
| 4 | `~/.claude/.credentials.json` (Linux, reactive) | `keychain.ts:124–133` | `.claudeAiOauth.accessToken` |

After resolution: `detectAuthMode(token)` → `'oauth'` (prefix `sk-ant-oat01-`) or `'api-key'`.

### Codex / OpenAI

| Priority | Source | File:Line | Notes |
|---|---|---|---|
| 1 | `AgentConfig.apiKey` | `openai-codex.ts:180` | Explicit override |
| 2 | `OPENAI_API_KEY` env var | `openai-codex.ts:182` | Standard OpenAI API key |
| 3 | `CODEX_API_KEY` env var | `openai-codex.ts:183` | Codex alias |
| 4 | `~/.codex/auth.json` (passthrough to Codex binary) | `@openai/codex-sdk/dist/index.js:235` | Binary reads file natively when no key injected |

No AFK code currently reads `~/.codex/auth.json` directly. AFK sees only a subprocess boundary.

---

## Current Execution Map

### Anthropic: What is Harness vs. Wire

| Layer | Class/File | What It Does |
|---|---|---|
| **Harness outer loop** | `AnthropicDirectQuery` (`query.ts`) | Multi-turn loop, abort control, OAuth retry, usage-limit pause/resume, compact |
| **Harness inner loop** | `runTurn()` (`loop.ts`) | Per-turn tool dispatch, iteration cap, cache breakpoints |
| **Wire translate** | `translateMessageStream()` (`translate.ts`) | Raw SDK SSE events → `ProviderEvent` + `TurnResult`. Pure function. |
| **Auth** | `auth.ts`, `keychain.ts` | Pure token resolution + mode-dependent header/option builders |
| **Tool dispatch** | `SessionToolDispatcher`, `tool-dispatcher.ts` | Hooks, permissions, MCP, memory, subagents, skills |
| **Plan mode** | `buildPlanModeAddendumBlock()`, `setPermissionMode()` | System prompt addendum per mode |
| **Compact** | `compact()` in `query.ts:645–779` | Summarization, message splice, trace event |
| **Prompt cache** | `cache-policy.ts` | Non-mutating cache breakpoint stamps |

### OpenAI/Codex: What is SDK Glue vs. What AFK Loses

| Layer | Codex SDK Reality | AFK Consequence |
|---|---|---|
| **Agent loop** | Runs inside Rust binary | AFK cannot intercept tool calls mid-turn |
| **Tool dispatch** | Codex binary dispatches bash, file, MCP tools | No `canUseTool`, no hook dispatch per tool |
| **Plan mode** | Not passed through; Codex has its own permission model | No AFK plan mode for Codex sessions |
| **Compact** | Not defined in adapter | Optional; harness falls back gracefully |
| **Hooks** | Rejected at construction (`assertCodexSupportedConfig`) | Hook-using configs fail fast |
| **Plugins** | Rejected at construction | Plugin-using configs fail fast |
| **Checkpoints** | `rewindFiles()` throws | Not supported |
| **Context usage** | Stub zeros | No context-window progress bar |
| **Abort** | `AbortSignal` passed to `thread.runStreamed()` | Interruption works at turn boundary only |
| **Event translation** | `translateCodexEvent()` + `translateItem()` | `tool.use.start`, `progress`, `suggestion`, `paused`, `resumed` never emitted |

**AFK features Codex hard-rejects:** `continue`, `resumeSessionAt`, `forkSession`, `persistSession=false`, `enableFileCheckpointing`, `thinking`, `maxBudgetUsd`, `taskBudget`, `plugins`, `agents`, `agent`, `onElicitation`, `hooks`, `canUseTool`, `mcpServers`, `includeHookEvents`, `agentProgressSummaries`, `includePartialMessages`.

---

## Proposed Auth Abstraction

### `AuthResolver<T>` Interface

```typescript
// src/agent/wire/auth.ts  (new file — interface definition only in Phase 1)

export type AuthDiagnosticSource =
  | 'explicit-config'
  | 'env-ANTHROPIC_API_KEY'
  | 'env-CLAUDE_CODE_OAUTH_TOKEN'
  | 'claude-keychain'
  | 'env-OPENAI_API_KEY'
  | 'env-CODEX_API_KEY'
  | 'codex-cli-auth-json'
  | 'env-CODEX_ACCESS_TOKEN'
  | 'none';

export interface AuthResolvedResult<TOptions> {
  /** Opaque options for constructing the provider's HTTP client */
  clientOptions: TOptions;
  /** Source label for diagnostics — never contains raw credential material */
  source: AuthDiagnosticSource;
  /** Human-readable summary for `afk provider auth diagnose` */
  summary: string;
  /** Whether this source requires refresh monitoring */
  requiresRefresh: boolean;
}

export interface AuthResolver<TOptions> {
  resolve(config: AgentConfig): Promise<AuthResolvedResult<TOptions>>;
  /** Optional: attempt token refresh, return updated result or null */
  refresh?(): Promise<AuthResolvedResult<TOptions> | null>;
}
```

### `AuthDiagnostic` Command (new `afk provider auth diagnose`)

Output format:
```
Provider: openai-compatible
Auth source: codex-cli-auth-json (~/.codex/auth.json)
Auth mode: chatgpt-oauth
Account: <first 8 chars of account_id>...
Token valid: yes (expires in 7d 14h)
Refresh available: no (exec mode; run `codex` interactively to refresh)

Provider: anthropic-direct
Auth source: claude-keychain (macOS Keychain)
Auth mode: oauth
Account: user@example.com
Token valid: yes (expires in 2h 15m)
Refresh available: yes (in-process)
```

Rules:
- No raw token material ever printed
- Account ID / email always truncated or masked
- Source enum is machine-readable (for tests/pipes)

### Credential Source Priority (OpenAI-Compatible)

```
1. AgentConfig.apiKey                        → mode: api-key
2. OPENAI_API_KEY env var                    → mode: api-key
3. CODEX_API_KEY env var                     → mode: api-key
4. CODEX_ACCESS_TOKEN env var                → mode: chatgpt-oauth (pre-provided token, no refresh)
5. ~/.codex/auth.json                        → mode: api-key OR chatgpt-oauth per auth_mode field
6. none                                      → surface clear error with guidance
```

---

## Proposed Wire Abstraction

### Minimal `WireAdapter` Interface

```typescript
// src/agent/wire/adapter.ts  (new file — Phase 1 interface only)

export interface WireAdapter {
  /** Provider-identifying name. Same as ModelProvider.name. */
  readonly name: string;

  /**
   * Translate a single turn: given the current messages array and a tool
   * dispatcher, stream normalized ProviderEvents.
   *
   * The wire adapter is NOT responsible for:
   * - outer loop (across turns)
   * - tool dispatch (call toolDispatcher)
   * - abort graph management
   * - plan mode system prompt injection (caller does this)
   * - compact decisions (caller decides when to compact)
   * - hooks (caller wraps toolDispatcher)
   */
  runTurn(input: WireTurnInput): AsyncIterable<WireTurnOutput>;

  /** Capability flags — used by harness to enable/disable features */
  capabilities(): WireCapabilities;
}

export interface WireTurnInput {
  messages: NormalizedMessage[];
  system: NormalizedSystemContent;
  tools: NormalizedToolSchema[];
  toolDispatcher: ToolDispatcherLike;
  model: string;
  maxTokens: number;
  signal: AbortSignal;
  headers?: Record<string, string>;    // provider-specific extra headers
}

export type WireTurnOutput =
  | { kind: 'event'; event: ProviderEvent }
  | { kind: 'turn-result'; result: WireTurnResult };

export interface WireTurnResult {
  stopReason: string | null;
  assistantContent: NormalizedContentBlock[];
  toolUseBlocks: NormalizedToolUseBlock[];
  usage: ProviderUsage | null;
  text: string;
}

export interface WireCapabilities {
  /** Whether the provider supports extended thinking/reasoning */
  extendedThinking: boolean;
  /** Whether the provider supports prompt caching */
  promptCaching: boolean;
  /** Prompt caching strategy: 'anthropic-breakpoints' | 'openai-seed' | 'none' */
  promptCachingStrategy: 'anthropic-breakpoints' | 'openai-seed' | 'none';
  /** Whether system prompt is a separate field (true) vs injected as first message (false) */
  hasSystemRole: boolean;
  /** Whether tool calls can be batched in one round-trip */
  batchToolCalls: boolean;
  /** Maximum context window in tokens */
  contextWindowTokens: number;
  /**
   * Provider-native escape hatches.
   * These are passed through opaquely from AgentConfig; the harness doesn't
   * interpret them. Adapters may choose to ignore unknown keys.
   */
  nativeExtensions?: Record<string, unknown>;
}
```

### Normalized Message Types

```typescript
// src/agent/wire/messages.ts  (new file — Phase 1 types only)

export type NormalizedRole = 'user' | 'assistant';

export type NormalizedContentBlock =
  | { type: 'text'; text: string; cacheControl?: CacheControl }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'image'; mediaType: string; data: string };

export interface NormalizedMessage {
  role: NormalizedRole;
  content: NormalizedContentBlock[];
}

export type NormalizedSystemContent =
  | { type: 'text'; blocks: Array<{ text: string; cacheControl?: CacheControl }> }
  | { type: 'injected'; message: NormalizedMessage }; // for providers without a system role

export interface NormalizedToolSchema {
  name: string;
  description: string;
  inputSchema: unknown;        // JSON Schema object
  cacheControl?: CacheControl;
}

export interface NormalizedToolUseBlock {
  id: string;
  name: string;
  input: unknown;
}

export interface CacheControl {
  type: 'ephemeral';
  ttl?: '5m' | '1h';
}
```

---

## Proposed Target Directory Structure

```
src/agent/
  loop/                      ← NEW: extracted harness loop (Phase 3+)
    runner.ts                  multi-turn outer loop (extracted from query.ts)
    tool-runner.ts             per-turn tool dispatch (extracted from loop.ts)
    compactor.ts               compact logic (extracted from query.ts)
    abort-coordinator.ts       abort graph + interrupt (coordination layer)
    plan-mode.ts               plan mode system prompt injection

  wire/                      ← NEW: wire contract (Phase 1: types only)
    adapter.ts                 WireAdapter interface
    auth.ts                    AuthResolver interface, AuthDiagnosticSource enum
    messages.ts                NormalizedMessage, NormalizedContentBlock, etc.
    capabilities.ts            WireCapabilities interface

  wires/                     ← NEW: provider adapters (Phase 2+)
    anthropic/
      adapter.ts               AnthropicWireAdapter (wraps existing translate.ts + loop.ts)
      auth.ts                  AnthropicAuthResolver (wraps existing auth.ts + keychain.ts)
    openai-compatible/
      adapter.ts               OpenAICompatibleWireAdapter (new — direct /v1/chat/completions)
      auth.ts                  OpenAICompatibleAuthResolver (reads env + ~/.codex/auth.json)
      codex-auth-reader.ts     CodexAuthFileReader (reads ~/.codex/auth.json, parses JWT)
      nvidia-nim.config.ts     NVIDIA NIM baseURL + model config (Phase 3+)

  providers/                 ← EXISTING (unchanged until Phase 3)
    anthropic-direct/          untouched
    openai-codex.ts            wrapped/bridged in Phase 2; removed in Phase 3
    index.ts                   updated routing in Phase 2 to point new adapter
```

---

## Phase Plan

### Phase 0 — Ground Truth (No Code Changes)

**Goal:** Verify every factual claim in this spec against the actual codebase before writing a line.

**Tasks:**
- [ ] Confirm `index.ts:293–296` priority chain is exactly as documented here
- [ ] Confirm `openai-codex.ts:180–184` auth chain
- [ ] Confirm `~/.codex/auth.json` JSON structure on CI or developer machines
- [ ] Confirm `@openai/codex-sdk/dist/index.js:235–236` is the complete auth injection
- [ ] Confirm `runTurn()` and `AnthropicDirectQuery` split is stable and untouched since last green build
- [ ] Run `pnpm test` on the worktree — confirm Anthropic and Codex tests pass

**Acceptance criteria:** All tests green, no surprises in file contents.

**Do not touch yet:** All source files.

---

### Phase 1 — Wire Contract Types (Interface-Only)

**Goal:** Add the type definitions for the wire contract. Zero behavior change. Anthropic stays green.

**New files:**
- `src/agent/wire/adapter.ts` — `WireAdapter`, `WireTurnInput`, `WireTurnOutput`, `WireTurnResult`, `WireCapabilities`
- `src/agent/wire/auth.ts` — `AuthResolver<T>`, `AuthResolvedResult<T>`, `AuthDiagnosticSource`
- `src/agent/wire/messages.ts` — `NormalizedMessage`, `NormalizedContentBlock`, `NormalizedSystemContent`, `NormalizedToolSchema`, `CacheControl`
- `src/agent/wire/index.ts` — barrel re-export

**Zero changes to existing files.** These are additive type definitions only.

**Tests:**
- TypeScript compilation passes with `tsc --noEmit`
- No existing tests break
- No runtime behavior changes

**Acceptance criteria:**
- `pnpm build` passes
- `pnpm test` unchanged (all green)
- New files have zero `any` except where explicitly documented

---

### Phase 2A — `OpenAICompatibleAuthResolver`

**Goal:** AFK can read credentials for OpenAI-compatible calls without spawning the Codex binary. Codex behavior unchanged until Phase 2B.

**New files:**
- `src/agent/wires/openai-compatible/codex-auth-reader.ts`
  - `readCodexAuthFile(): CodexAuthFileResult | null` — reads `~/.codex/auth.json`, parses, checks expiry
  - `parseJwtExpiry(token: string): Date | null` — decodes JWT `exp` claim without verifying signature
  - `redactToken(token: string): string` — returns `sk-…<last-8>` or `<8-chars>…` (never full token)
  - JSON structure: `{ auth_mode, OPENAI_API_KEY, tokens: { id_token, access_token, refresh_token, account_id } }`
  - Expiry check: JWT `exp` claim vs. `Date.now()` with 5-minute safety margin
  - Write-back: `writeCodexAuthFile(result: CodexAuthFileResult): void` — for Phase 2C refresh

- `src/agent/wires/openai-compatible/auth.ts`
  - `OpenAICompatibleAuthResolver implements AuthResolver<OpenAICompatibleClientOptions>`
  - Priority chain: `AgentConfig.apiKey` → `OPENAI_API_KEY` → `CODEX_API_KEY` → `CODEX_ACCESS_TOKEN` → `~/.codex/auth.json` → `none`
  - Returns `AuthResolvedResult` with `source`, `summary`, `requiresRefresh`
  - All token material redacted in `summary`

**Test coverage:**
- `codex-auth-reader.test.ts`: fixture JSON files for `chatgpt` and `api_key` modes, expired token, near-expiry token
- `auth.test.ts`: each priority level, `none` path, redaction checks (no raw token in `summary`)
- Tests use filesystem fixtures (no subprocess spawning)

**No changes to `openai-codex.ts`.** No routing changes. Purely additive.

**Acceptance criteria:**
- All priority paths resolve correctly
- Expired token returns `{ mode: 'chatgpt-oauth-expired' }` not a throw
- No raw token material appears in `summary` output (fuzz test this)
- `pnpm test` still green

---

### Phase 2B — `afk provider auth diagnose` Command

**Goal:** Operators can see which auth source AFK will use, with redacted output.

**New file:** `src/cli/commands/provider-auth-diagnose.ts`  
**Updated:** `src/cli/` command registry to add the new command

**Behavior:**
```bash
afk provider auth diagnose
# or: afk provider auth diagnose --provider openai-compatible
```

Output:
```
[anthropic-direct]
  Source:  claude-keychain (macOS Keychain)
  Mode:    oauth
  Account: user@ex…
  Valid:   yes (expires in 2h 15m)
  Refresh: yes (in-process)

[openai-compatible]
  Source:  codex-cli-auth-json (~/.codex/auth.json)
  Mode:    chatgpt-oauth
  Account: abc12345…
  Valid:   yes (expires in 7d 3h)
  Refresh: no (exec mode; run `codex` interactively to refresh token)
```

**Rules:**
- No raw token material in output
- Account ID: first 8 chars + `…`
- Token validity from JWT `exp` claim
- Expiry displayed as human-readable delta (`7d 3h`, not epoch)
- Machine-readable `--json` output for scripting/tests

**Tests:**
- Mock `AuthResolver.resolve()` outputs; verify output format
- Verify no token material leaks in any code path (`--json` included)

**Acceptance criteria:**
- Command exits 0 when at least one provider has valid auth
- Command exits 1 with descriptive message when no provider has auth
- JSON output parseable, redacted

---

### Phase 2C — `OpenAICompatibleWireAdapter` (Direct HTTP, API Key Mode First)

**Goal:** AFK can drive a single turn of `gpt-4o` (or any OpenAI-compatible model) using direct HTTP `/v1/chat/completions` with Server-Sent Events, without spawning the Codex binary. **Only `api-key` auth mode in this phase.** ChatGPT OAuth in Phase 2D.

**New file:** `src/agent/wires/openai-compatible/adapter.ts`

**Implements `WireAdapter`:**
- `runTurn(input: WireTurnInput): AsyncIterable<WireTurnOutput>`
  - Translates `NormalizedMessage[]` → OpenAI `messages[]` format (no `system` role separate field; system injected as first `{ role: 'system', content: ... }` message)
  - Translates `NormalizedToolSchema[]` → OpenAI `tools[]` format
  - Calls `POST {baseUrl}/v1/chat/completions` with `stream: true`
  - Consumes SSE stream: `delta.content`, `delta.tool_calls`, `finish_reason`, `usage`
  - Translates SSE events → `ProviderEvent` (same types as Anthropic, different provenance)
  - Handles tool call accumulation (OpenAI streams tool calls in fragments across deltas)
  - Dispatches tools via `input.toolDispatcher` (same interface as Anthropic)
  - Returns `WireTurnResult`

- `capabilities(): WireCapabilities`
  - `extendedThinking: false` (gpt-4o; true for `o1`/`o3` reasoning models — Phase 3)
  - `promptCaching: false` (standard OpenAI; true for some endpoints — Phase 3)
  - `promptCachingStrategy: 'none'`
  - `hasSystemRole: false` (system injected as first message)
  - `batchToolCalls: true`
  - `contextWindowTokens: 128000` (gpt-4o default; configurable)

**New file:** `src/agent/wires/openai-compatible/translate.ts`
- `translateChatCompletionDelta(delta, acc): ProviderEvent[]` — pure function
- `translateToolCallDeltas(deltaToolCalls, acc): ToolCallAccumulator` — accumulates fragmented tool call JSON
- `buildOpenAIMessages(messages: NormalizedMessage[]): OpenAIChatMessage[]`
- `buildOpenAITools(tools: NormalizedToolSchema[]): OpenAITool[]`

**HTTP client:** Use Node.js native `fetch` with SSE parsing. **Do NOT import `openai` npm package yet.** Raw fetch keeps the dependency graph clean and makes the wire seam obvious.

*If raw fetch proves too tedious for stream parsing, add `openai` npm package as a dev-dependency of the wire module only — but prefer raw fetch for Phase 2C.*

**Tests:**
- `adapter.test.ts`: mock `fetch`, drive full turn with text response + tool call response
- `translate.test.ts`: pure unit tests for all translation functions
- Fixture JSON for fragmented OpenAI SSE tool call deltas (these are tricky — document test cases)

**Routing:** Phase 2C does NOT change `providers/index.ts`. The new adapter is tested in isolation only.

**Acceptance criteria:**
- Single-turn text response: `delta.text` events + `assistant.message` + `turn.completed`
- Single tool call: `tool.use.start` + `tool.output` + continuation turn + `turn.completed`
- Abort signal honored (fetch aborted before stream end)
- Tool call JSON fragments accumulated correctly across deltas
- `pnpm test` still green (Anthropic unaffected)

---

### Phase 2D — ChatGPT OAuth Path in `OpenAICompatibleAuthResolver`

**Goal:** AFK can use `~/.codex/auth.json` `access_token` for direct HTTP calls.

**Updates `src/agent/wires/openai-compatible/auth.ts`:**
- Complete the `chatgpt-oauth` branch: read `access_token` + `account_id`
- Set `requiresRefresh: true` (token expires ~10 days)
- `buildRequestHeaders()` for chatgpt-oauth mode:
  ```typescript
  { 'Authorization': `Bearer ${accessToken}`, 'ChatGPT-Account-Id': accountId }
  ```
- Target base URL for ChatGPT OAuth: `https://chatgpt.com/backend-api` (NOT `api.openai.com`)
  - **This requires verification** — open question whether `/chat/completions` shape is identical

**Refresh strategy (Phase 2D only: detect + warn, no auto-refresh):**
- If token expires in < 5 min: return `{ mode: 'chatgpt-oauth-expiring-soon', ... }`
- Surface in `afk provider auth diagnose` output: `⚠ expires in 4m 30s — run 'codex' to refresh`
- Auto-refresh NOT implemented in Phase 2D (requires Phase 2E for safety)

**Tests:**
- Mock `~/.codex/auth.json` with ChatGPT OAuth mode; verify headers built correctly
- Expired token: verify graceful handling (no throw, descriptive result)
- Platform test: ensure reader works on macOS + Linux (no `security` keychain call needed)

**Open question:** Does `https://chatgpt.com/backend-api/v1/chat/completions` accept the same OpenAI SSE format? If not, ChatGPT OAuth may need a different wire adapter. **Verify before implementing Phase 2D's HTTP calls.**

---

### Phase 2E — Token Refresh for ChatGPT OAuth (Optional, Explicit Consent)

**Goal:** AFK can refresh expired ChatGPT OAuth tokens without running the Codex binary.

**Implements `AuthResolver.refresh()` in `OpenAICompatibleAuthResolver`:**
- POST `https://auth.openai.com/oauth/token` with `{ grant_type: 'refresh_token', refresh_token, client_id: 'app_EMoamEEZ73f0CkXaXp7hrann' }`
- On success: write new tokens back to `~/.codex/auth.json` (preserve all other fields)
- `refreshPromise` deduplication — never run two refreshes concurrently
- Log `last_refresh` timestamp on write-back
- **Safety:** only attempt if AFK is the sole process with `auth.json` open (flock or stale-check)
- **Gate:** only enabled by explicit `AFK_OPENAI_MANAGE_TOKEN_REFRESH=true` env var (off by default, so existing `codex` users retain binary-managed refresh)

**Tests:**
- Mock `https://auth.openai.com/oauth/token`; verify write-back preserves other fields
- Single-use token safety: second concurrent call waits on `refreshPromise`, uses same result
- Stale-state guard: if `auth.json` changed externally between read and write-back, abort refresh and surface error

---

### Phase 3 — Wire the `OpenAICompatibleWireAdapter` into the Harness

**Goal:** `providers/index.ts` routes `gpt-*` model IDs to a new `OpenAICompatibleProvider` that wraps the wire adapter with AFK's native loop. **`openai-codex.ts` stays for now as legacy fallback.**

**New file:** `src/agent/wires/openai-compatible/provider.ts`
- `OpenAICompatibleProvider implements ModelProvider`
- `query(args)` → constructs `OpenAICompatibleQuery` (a full `ProviderQuery`)
  - Uses `WireAdapter.runTurn()` for wire I/O
  - Delegates loop, tool dispatch, hooks, plan mode, compact to AFK harness code (extracted from `query.ts` / `loop.ts`)
  - Initially: inline the multi-turn loop from `query.ts` (copy, not extract — extraction is a separate refactor)

**Updated `providers/index.ts`:**
- New routing flag: `AFK_OPENAI_PROVIDER=wire` (opt-in) → routes `gpt-*` to `OpenAICompatibleProvider`
- Default: routes `gpt-*` to existing `openai-codex.ts` (no behavioral regression)
- `AFK_OPENAI_PROVIDER=legacy` → explicit fallback to old path

**Acceptance criteria:**
- With `AFK_OPENAI_PROVIDER=wire`: `gpt-4o` model completes a multi-turn session with tool calls
- Hooks fire on tool calls (was impossible with Codex subprocess)
- Plan mode system prompt injection works
- `compact()` works (AFK-owned, not Codex-owned)
- `interrupt()` works mid-stream
- `AFK_OPENAI_PROVIDER=legacy`: existing behavior unchanged
- Anthropic tests unaffected

---

### Phase 4 — Deprecate `openai-codex.ts` (Legacy Flag Removal)

**Goal:** Remove `@openai/codex-sdk` dependency. Migration gate: Phase 3 has been green for ≥2 weeks, all features validated.

**Tasks:**
- [ ] Audit which `assertCodexSupportedConfig()` fields become supported (hooks, plan mode, etc.)
- [ ] Update routing: `gpt-*` → `OpenAICompatibleProvider` always (no flag needed)
- [ ] Remove `openai-codex.ts` and its tests
- [ ] Remove `@openai/codex-sdk` from `package.json`
- [ ] Update `afk login` codex guidance (was: "run `codex login`"; now: "run `codex login` OR set `OPENAI_API_KEY`")
- [ ] Update CHANGELOG

**Migration criteria for removal:**
- `OpenAICompatibleProvider` passes all tests from `openai-codex.test.ts` (rewritten to use new adapter)
- `openai-codex-agent-session.test.ts` passes against new provider
- Manual validation: full session with ChatGPT OAuth auth, API key auth, NVIDIA NIM config

---

### Phase 5 — NVIDIA NIM as Proof Case

**Goal:** Add NVIDIA NIM as a zero-code-change proof that OpenAI-compatible config works.

**New file:** `src/agent/wires/openai-compatible/presets/nvidia-nim.ts`
```typescript
export const NVIDIA_NIM_PRESET: OpenAICompatibleConfig = {
  baseUrl: 'https://integrate.api.nvidia.com/v1',
  authEnvVar: 'NVIDIA_API_KEY',
  modelPrefix: 'nvidia/',
  capabilities: {
    extendedThinking: false,
    promptCaching: false,
    promptCachingStrategy: 'none',
    hasSystemRole: true,   // VERIFY: NIM likely accepts system role
    batchToolCalls: true,
    contextWindowTokens: 128000, // VERIFY: model-specific
  },
};
```

**Updated routing:** `nvidia/*` model prefix → `OpenAICompatibleProvider` with NVIDIA NIM preset.

**Verification required before Phase 5:**
- Confirm NVIDIA NIM endpoint is exactly `https://integrate.api.nvidia.com/v1/chat/completions`
- Confirm SSE format is OpenAI-compatible (deltas, tool call fragments, finish_reason)
- Confirm tool call support for target models (e.g., `nvidia/llama-3.1-nemotron-70b-instruct`)
- Confirm `system` role in messages array (vs. separate field)
- Document any NVIDIA-specific headers required

---

## File-by-File Plan

### Phase 1 (New Files Only)

| File | Action | Description |
|---|---|---|
| `src/agent/wire/adapter.ts` | **NEW** | `WireAdapter`, `WireTurnInput/Output/Result`, `WireCapabilities` |
| `src/agent/wire/auth.ts` | **NEW** | `AuthResolver<T>`, `AuthResolvedResult<T>`, `AuthDiagnosticSource` |
| `src/agent/wire/messages.ts` | **NEW** | `NormalizedMessage`, `NormalizedContentBlock`, `NormalizedSystemContent`, `NormalizedToolSchema`, `CacheControl` |
| `src/agent/wire/index.ts` | **NEW** | Barrel export |

### Phase 2A–2E (New Files)

| File | Action | Description |
|---|---|---|
| `src/agent/wires/openai-compatible/codex-auth-reader.ts` | **NEW** | `readCodexAuthFile`, `parseJwtExpiry`, `redactToken`, `writeCodexAuthFile` |
| `src/agent/wires/openai-compatible/auth.ts` | **NEW** | `OpenAICompatibleAuthResolver` |
| `src/agent/wires/openai-compatible/codex-auth-reader.test.ts` | **NEW** | Unit tests with fixture JSON |
| `src/agent/wires/openai-compatible/auth.test.ts` | **NEW** | Priority chain tests, redaction tests |
| `src/cli/commands/provider-auth-diagnose.ts` | **NEW** | `afk provider auth diagnose` |
| `src/agent/wires/openai-compatible/adapter.ts` | **NEW** | `OpenAICompatibleWireAdapter` |
| `src/agent/wires/openai-compatible/translate.ts` | **NEW** | SSE translation pure functions |
| `src/agent/wires/openai-compatible/adapter.test.ts` | **NEW** | Mock fetch, full turn coverage |
| `src/agent/wires/openai-compatible/translate.test.ts` | **NEW** | Pure unit tests |

### Phase 3 (First Modified Files)

| File | Action | Description |
|---|---|---|
| `src/agent/wires/openai-compatible/provider.ts` | **NEW** | `OpenAICompatibleProvider implements ModelProvider` |
| `src/agent/providers/index.ts` | **MODIFY** | Add `AFK_OPENAI_PROVIDER=wire` routing opt-in |

### Phase 4 (Removals)

| File | Action | Description |
|---|---|---|
| `src/agent/providers/openai-codex.ts` | **REMOVE** | After Phase 3 validated |
| `src/agent/providers/openai-codex.test.ts` | **REMOVE/REPLACE** | Replaced by new adapter tests |
| `src/agent/providers/openai-codex-agent-session.test.ts` | **REMOVE/REPLACE** | Replaced by provider-level tests |
| `package.json` | **MODIFY** | Remove `@openai/codex-sdk` |

---

## Migration Strategy for `openai-codex.ts`

### Phase 2: Parallel New Path
`openai-codex.ts` runs unchanged. New wire code is additive only. Zero routing changes.

### Phase 3: Feature-Flagged Opt-In
```bash
AFK_OPENAI_PROVIDER=wire afk ask "hello"   # uses new OpenAICompatibleProvider
AFK_OPENAI_PROVIDER=legacy afk ask "hello" # uses old openai-codex.ts (default)
```

Tests run against both paths. Behavioral delta documented.

### Phase 3 → 4 Gate (No Removal Until All Pass)
- [ ] `openai-codex.test.ts` cases all pass on new provider (rewritten tests)
- [ ] `openai-codex-agent-session.test.ts` cases all pass
- [ ] Hook dispatch works on tool calls
- [ ] Plan mode system prompt injected
- [ ] `compact()` works
- [ ] `interrupt()` works mid-stream
- [ ] Auth: API key + Codex CLI login auth both tested
- [ ] Manual smoke test: 5-turn session with at least one tool call
- [ ] `AFK_OPENAI_PROVIDER=wire` has been default for ≥1 week without regression reports

### Phase 4: Hard Removal
Remove `openai-codex.ts`, `@openai/codex-sdk`, feature flag. Update routing unconditionally.

---

## Acceptance Criteria Per Phase

| Phase | Criteria |
|---|---|
| **0** | `pnpm test` green; file contents match spec claims |
| **1** | `tsc --noEmit` passes; no existing tests break; new files compile clean |
| **2A** | Auth priority chain correct for all 6 sources; expired token handled; no token leaks in summary |
| **2B** | `afk provider auth diagnose` outputs correct source/mode/validity; `--json` parseable; no raw token in any output |
| **2C** | Single-turn text + tool call against mocked OpenAI SSE; abort honored; Anthropic tests unaffected |
| **2D** | ChatGPT OAuth headers built correctly; expired token surfaces graceful warning |
| **2E** | Refresh writes back to auth.json; concurrent calls serialized; opt-in gate works |
| **3** | With flag: hooks + plan mode + compact work; without flag: old behavior unchanged |
| **4** | `@openai/codex-sdk` removed; all existing tests pass without it |
| **5** | NVIDIA NIM single-turn text + tool call against mocked endpoint |

---

## Tests Per Phase

### Phase 1
- `pnpm tsc --noEmit` (compilation check only)

### Phase 2A
- `src/agent/wires/openai-compatible/codex-auth-reader.test.ts`
  - fixture: `auth_mode: chatgpt`, valid token
  - fixture: `auth_mode: chatgpt`, expired token (exp in past)
  - fixture: `auth_mode: chatgpt`, near-expiry (exp in 4 min)
  - fixture: `auth_mode: api_key`
  - fixture: file missing
  - fixture: malformed JSON
  - verify: `redactToken` never returns full token (property-based fuzz)

- `src/agent/wires/openai-compatible/auth.test.ts`
  - `AgentConfig.apiKey` → source `explicit-config`
  - `OPENAI_API_KEY` env → source `env-OPENAI_API_KEY`
  - `CODEX_API_KEY` env → source `env-CODEX_API_KEY`
  - `CODEX_ACCESS_TOKEN` env → source `env-CODEX_ACCESS_TOKEN`
  - `~/.codex/auth.json` chatgpt → source `codex-cli-auth-json`
  - nothing → source `none`, no throw
  - verify: `summary` contains no token material for all sources

### Phase 2B
- `src/cli/commands/provider-auth-diagnose.test.ts`
  - mock both resolvers; verify text output format
  - `--json` output: parseable, no token material
  - exit code 0 when at least one source valid
  - exit code 1 when all sources return `none`

### Phase 2C
- `src/agent/wires/openai-compatible/translate.test.ts`
  - text delta SSE → `delta.text` events
  - tool call delta fragments accumulation → single `tool.use` event
  - `finish_reason: stop` → `turn.completed`
  - `finish_reason: tool_calls` → tool calls extracted
  - error chunk → `error` event

- `src/agent/wires/openai-compatible/adapter.test.ts`
  - text response: mock fetch SSE; expect `delta.text`, `assistant.message`, `turn.completed`
  - tool call: mock fetch SSE with fragmented tool call; expect dispatch + `tool.output` + continuation
  - abort: `AbortSignal.abort()` mid-stream; expect stream terminates cleanly

### Phase 3
- Existing `openai-codex.test.ts` re-run against new `OpenAICompatibleProvider` (with mock)
- Existing `openai-codex-agent-session.test.ts` re-run against new provider
- Hook dispatch test: verify `hookRegistry` callbacks fire on tool calls
- Plan mode test: verify system prompt contains plan mode addendum

---

## Risks and Unknowns

### Auth Storage Stability
**Risk:** OpenAI changes `~/.codex/auth.json` field names or structure in a future Codex CLI release.  
**Mitigation:** `codex-auth-reader.ts` validates field presence before use; returns `null` gracefully on unexpected structure; log warning with field path that was missing.  
**Unknown:** No semver guarantee on `~/.codex/auth.json` schema.

### ChatGPT OAuth Token Refresh  
**Risk:** Token refresh requires client_id `app_EMoamEEZ73f0CkXaXp7hrann` — this was extracted from the Codex binary and is not a documented public value. It may change.  
**Mitigation:** Phase 2E is opt-in only. Default path: surface error and ask user to run `codex` interactively.  
**Unknown:** Whether OpenAI will accept refresh requests from non-browser contexts with this client_id.

### ChatGPT OAuth vs. API Key Feature Parity  
**Risk:** ChatGPT OAuth routes to `chatgpt.com/backend-api`, not `api.openai.com`. These endpoints may have different tool call formats, streaming behavior, or model support.  
**Mitigation:** Phase 2D is explicitly gated on verifying endpoint shape. Do not implement HTTP calls for ChatGPT OAuth until verified.  
**Unknown:** Whether `chatgpt.com/backend-api/chat/completions` accepts identical OpenAI SSE format.

### OpenAI Tool Call Streaming Differences  
**Risk:** OpenAI streams tool calls as fragmented JSON deltas across multiple SSE events. The accumulator in `translate.ts` must handle: partial JSON, multiple concurrent tool calls (OpenAI sends them interleaved by `index`), and the difference between `delta.tool_calls[0].function.arguments` accumulation vs. Anthropic's `input_json_delta`.  
**Mitigation:** Thorough test fixtures for fragmented tool calls. Reference the OpenAI streaming docs for delta accumulation spec.

### `o1`/`o3` Reasoning Models  
**Risk:** `o1` and `o3` models use `reasoning_effort` and `max_completion_tokens` instead of `max_tokens`. `reasoning` content blocks appear in the response. These are not standard `gpt-4o` behavior.  
**Mitigation:** Defer reasoning model support to Phase 3+. `WireCapabilities.extendedThinking` flag gates this. Phase 2C targets `gpt-4o` only.

### Prompt Caching Semantics  
**Risk:** OpenAI has prompt caching but it's automatic (no cache control headers in the message format), unlike Anthropic's explicit `cache_control` breakpoints.  
**Mitigation:** `WireCapabilities.promptCachingStrategy: 'none'` for Phase 2C. No cache control injection for OpenAI messages.

### Anthropic Regression Risk  
**Risk:** Any change to `providers/index.ts` routing could accidentally route Anthropic models to the new adapter.  
**Mitigation:** Phase 1–2 make zero changes to `providers/index.ts`. Phase 3 adds an opt-in env var with explicit model-prefix gating. Anthropic routing is pattern-matched on `claude-*` / `opus` / `sonnet` / `haiku` / `auto` (unchanged from `index.ts:32–51`).

### Concurrent Codex Process Safety  
**Risk:** If both AFK and the interactive `codex` CLI are running, both may attempt to refresh the single-use `refresh_token` in `~/.codex/auth.json` simultaneously.  
**Mitigation:** Phase 2E includes a stale-state guard (read → check mtime → write-back only if unchanged). Gate Phase 2E behind `AFK_OPENAI_MANAGE_TOKEN_REFRESH=true` (off by default).

### OPENAI_API_KEY vs. Codex OAuth Permission Differences  
**Risk:** ChatGPT OAuth login (Codex native) may give access to different models or have different rate limits than a standard `OPENAI_API_KEY`. Mixing them in the same priority chain may yield confusing behavior if a user has both.  
**Mitigation:** Priority chain is deterministic (API key wins over file-based auth). Diagnostic command shows which source is active. Document clearly that API key and ChatGPT OAuth are separate billing channels.

### Env Var Conflicts  
**Risk:** `CODEX_API_KEY` is set by the Codex SDK in the subprocess environment (for sub-agent spawning). If AFK ever spawns subprocesses and inherits env, it may pick up a Codex-injected key.  
**Mitigation:** `CODEX_API_KEY` is in the AFK priority chain only for the top-level `OpenAICompatibleAuthResolver`. Subagent sessions resolve auth fresh from `AgentConfig`, not environment inheritance. No change needed now.

### Capability Detection  
**Risk:** How do we know whether a given model (e.g., future `gpt-5`) supports tool calls, reasoning, or extended context?  
**Mitigation:** `WireCapabilities` is set per-adapter instance, not per-model at runtime. Phase 2C uses a static default for `gpt-4o`. Phase 3+ can add a model capabilities registry similar to `model-limits.ts`.

---

## "Do Not Touch Yet" List

- `src/agent/providers/anthropic-direct/` — entire directory, all files, all phases until Phase 4+
- `src/agent/providers/openai-codex.ts` — until Phase 3 is green and flagged as stable
- `src/agent/providers/index.ts` — until Phase 3 (routing change is additive, not replacement)
- `src/agent/session/` — entire session layer. The harness loop refactor (moving loop into `src/agent/loop/`) is a separate, later spec.
- `src/agent/provider.ts` — `ModelProvider` and `ProviderQuery` interfaces. Wire types are additive only; `provider.ts` does not change until Phase 3.
- `src/cli/keychain.ts` — Anthropic keychain logic. `codex-auth-reader.ts` is a parallel file, not a replacement.
- Any existing test files — until the phase explicitly calls for rewriting them.
- `package.json` — until Phase 4 removes `@openai/codex-sdk`.

---

## Open Questions Requiring Human Decision

1. **ChatGPT OAuth endpoint shape** (blocks Phase 2D): Is `https://chatgpt.com/backend-api/v1/chat/completions` identical in SSE format to `https://api.openai.com/v1/chat/completions`? Should we skip ChatGPT OAuth entirely in Phase 2 and make API key the only wire path (simpler, but loses the "reuse Codex login" goal)?

2. **Token refresh ownership** (blocks Phase 2E): Should AFK ever own ChatGPT OAuth token refresh, or should the contract be "use API key for headless, and if you want ChatGPT OAuth, run `codex` interactively"? The single-use refresh token is a concurrency hazard.

3. **`openai` npm package vs. raw fetch** (Phase 2C design): Should we add the `openai` npm package as a thin HTTP client (it handles SSE streaming, tool call delta accumulation, and response types), or use raw `fetch` to avoid the dependency? The `openai` package is well-maintained and matches the OpenAI wire format exactly. Raw fetch is more explicit but requires more code.

4. **Harness extraction timing** (Phase 3 design): Should `src/agent/loop/` extraction (moving multi-turn loop out of `query.ts`) happen before or after the OpenAI wire adapter? Extracting first makes `OpenAICompatibleProvider` cleaner. Extracting after means duplicating some loop logic temporarily. Recommendation: extract after (Phase 3B), keep duplication for < 4 weeks.

5. **NVIDIA NIM priority** (Phase 5): Is NVIDIA NIM a real near-term use case, or is it primarily a proof-of-concept for the OpenAI-compatible adapter design? This affects whether Phase 5 needs production-level auth (NVIDIA API key management) or is just a config preset smoke test.

6. **`supportedModels()` for OpenAI-compatible** (Phase 3): The new provider will need a model list. Should this query `GET /v1/models` at session init, use a static curated list (like the current 2-entry stub), or expose a configuration option for custom model lists (relevant for NVIDIA NIM which has a different catalog)?

7. **`rewindFiles()` and checkpoints** (Phase 3 architecture): The wire seam makes AFK own the loop, so file checkpointing becomes possible for OpenAI models. Is this in scope? It was hard-rejected in `openai-codex.ts`. Recommendation: out of scope for Phase 3, revisit when the harness loop extraction is complete.

---

## Epistemic Confidence

### High Confidence (verified from actual files)
- `@openai/codex-sdk` is purely a subprocess spawn wrapper — confirmed from `dist/index.js` (466 lines, no HTTP client)
- `~/.codex/auth.json` structure — confirmed from live file on local disk
- Anthropic auth priority chain — confirmed from `index.ts:293–296`
- Codex auth priority chain — confirmed from `openai-codex.ts:180–184`
- Token refresh is broken in exec mode — extracted from Rust binary error strings
- OAuth client IDs — extracted from binary strings (not documented; may change)
- `ModelProvider` interface is exactly `{ name: string; query(args): ProviderQuery }` — confirmed from `provider.ts`

### Medium Confidence (inferred from code + external research, not directly verified)
- ChatGPT OAuth target endpoint (`chatgpt.com/backend-api`) — from binary strings, not OpenAI docs
- `app_EMoamEEZ73f0CkXaXp7hrann` client ID stability — binary strings only, no public doc
- NVIDIA NIM endpoint shape — from NVIDIA developer docs, not live test
- Single-use refresh token behavior — from binary error messages, not official OpenAI docs

### Requires Verification Before Implementation
- **Phase 2D blocker:** ChatGPT OAuth SSE format identity with OpenAI API format
- **Phase 5 blocker:** NVIDIA NIM tool call support for target models; exact base URL; system role in messages
- **Phase 2E blocker:** Whether OpenAI will accept refresh requests from AFK (not the browser) using `app_EMoamEEZ73f0CkXaXp7hrann`

### Human Judgment Required
- Token refresh ownership (open question 2)
- `openai` npm package vs. raw fetch (open question 3)
- Harness extraction timing (open question 4)
