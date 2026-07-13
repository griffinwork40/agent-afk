# Shadow verification — gpt-5.5 subagent auth failure

## Claim verified
The failed `gpt-5.5` subagent dispatch is an AFK subagent-auth/routing bug: the agent-tool executor deliberately clears `apiKey` for OpenAI-compatible children, but `SubagentManager.forkSubagent` later reintroduces the parent's `parentApiKey`, so an Anthropic `sk-ant-*` parent credential can reach the OpenAI-compatible child.

## Verdict
**CONFIRMED** for source HEAD and the agent-tool path.

A secondary subclaim — "installed global v5.15.5 may differ from source HEAD in this area" — is **REFUTED**. The installed package appears to be v5.15.5 and source HEAD is effectively the same runtime code plus docs-only commits; the bug is in both/source behavior, not an installed-vs-source mismatch.

## Independent verifier results

### Verifier 1 — auth flow
**CONFIRMED.**

Evidence:
- `src/agent/tools/subagent-executor.ts:554` computes `childIsOpenAI = providerForModel(childModel) === 'openai-compatible'`.
- `src/agent/tools/subagent-executor.ts:580` sets `apiKey: childIsOpenAI ? undefined : resolvedChildApiKey`, with comments at `:546-552` explicitly saying this is to prevent forwarding a parent Anthropic key to OpenAI.
- `src/agent/subagent.ts:420` then builds the actual child `AgentConfig` with `apiKey: options.config.apiKey || this.parentApiKey`, so the deliberate `undefined` becomes the parent credential.
- `src/agent/providers/openai-compatible/auth.ts:117-120` treats any non-empty explicit config key as Tier-1 OpenAI auth, so an inherited `sk-ant-*` would be used as OpenAI auth.

### Verifier 2 — tests
**CONFIRMED.**

Evidence:
- `src/agent/tools/subagent-executor.test.ts:545-567` asserts the executor passes `apiKey: undefined` for an OpenAI child, but uses a mocked manager, so the real `SubagentManager.forkSubagent` fallback is not exercised.
- `subagent.ts:420` is the missing boundary: it is downstream of the mocked boundary and reintroduces `parentApiKey`.
- The recommended regression belongs in `subagent.test.ts` or an integration-style executor test that uses the real manager and asserts an OpenAI child never receives `sk-ant-*` after `forkSubagent` constructs the real child config.

### Verifier 3 — installed dist parity
**PARTIAL / corrected.**

The verifier correctly refuted the installed-vs-source mismatch: installed global AFK is v5.15.5, and source HEAD differs by docs-only commits.

However, its broader refutation of the bug is rejected because it stopped at the executor's guard and did not account for `SubagentManager.forkSubagent` applying `apiKey: options.config.apiKey || this.parentApiKey` after that guard. That is the composition boundary the first two verifiers checked.

## Composition-boundary decision
Accepted as **CONFIRMED** because the decisive boundary is executor → manager → AgentSession/provider:
1. Executor clears OpenAI child key (`subagent-executor.ts:580`).
2. Manager reintroduces parent key (`subagent.ts:420`).
3. AgentSession applies slot clearing only when a matching slot exists (`agent-session.ts:238`; `slot-credentials.ts:57-77`). For raw `gpt-5.5` without a matching model-slot binding, this does not clear the leak.
4. OpenAI auth accepts explicit `config.apiKey` before env/codex auth (`openai-compatible/auth.ts:117-120`).

## Recommended fix
Make `SubagentManager.forkSubagent`'s `apiKey` and `baseUrl` fallback provider-aware, or otherwise preserve an explicit child decision to clear credentials. For example, for OpenAI-compatible child models, do not fall back to an Anthropic parent `apiKey` or Anthropic `baseUrl`; leave them undefined so the OpenAI-compatible provider resolves its own env/Codex/ChatGPT auth.

## Recommended regression tests
1. Add a real-manager test that constructs `SubagentManager({ apiKey: 'sk-ant-oat01-PARENT' })`, forks a child with `{ model: 'gpt-5.5', apiKey: undefined }`, and asserts the resulting child `AgentConfig.apiKey` is not `sk-ant-oat01-PARENT`.
2. Add the same shape for `baseUrl` if an Anthropic parent base URL can be inherited into OpenAI-compatible children.
3. Keep the existing executor-boundary test, but add the manager/integration test because the existing mock test is insufficient.
