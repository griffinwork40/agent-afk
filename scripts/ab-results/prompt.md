Investigate how agent-afk handles rate limiting and retries across its two provider implementations (anthropic-direct and openai-compatible). Use the compose tool to dispatch three parallel investigation subagents:

1. **Provider A investigator**: Read src/agent/providers/anthropic-direct/ — find every retry loop, rate-limit handler, backoff strategy, and error recovery path. Report each mechanism with file:line citations.

2. **Provider B investigator**: Read src/agent/providers/openai-compatible/ — find every retry loop, rate-limit handler, backoff strategy, and error recovery path. Report each mechanism with file:line citations.

3. **Shared infrastructure investigator**: Read src/agent/providers/index.ts, src/agent/session.ts, src/agent/subagent.ts, and src/config/env.ts — find retry-related env vars, shared error classification, and any provider-agnostic retry/backoff infrastructure. Report with file:line citations.

After all three complete, synthesize a comparison table showing:
- Which retry mechanisms are provider-specific vs shared
- Whether the two providers handle 429s consistently
- Any gaps where one provider has retry coverage the other lacks

Write the comparison to a file at /tmp/workspace-ab-result.md.
