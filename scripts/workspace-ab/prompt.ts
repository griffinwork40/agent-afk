import { createHash } from 'node:crypto';

/**
 * Canonical experiment prompt for the workspace A/B runner.
 *
 * The prompt is byte-identical across both arms — only `AFK_WORKSPACE_DISABLED`
 * differs.  The topology is designed to exercise workspace sharing:
 *
 *   1. Three agents receive intentionally overlapping file surfaces.
 *   2. Each must query before reading (workspace_query call encouraged).
 *   3. Each publishes after confirming a module-level fact.
 *   4. Each reaches a second checkpoint where it queries again before
 *      reading the next overlapping module.
 *   5. A final synthesiser agent is identical across both arms.
 *
 * This structure gives workspace-enabled agents an opportunity to skip
 * redundant reads based on sibling findings — the causal mechanism under test.
 *
 * @module scripts/workspace-ab/prompt
 */

export const EXPERIMENT_PROMPT = `\
Investigate how agent-afk handles rate limiting and retries across its two \
provider implementations. Use the compose tool to dispatch three parallel \
investigation subagents:

**IMPORTANT**: Before reading any file, call workspace_query to check whether \
a sibling has already analyzed it.  After confirming a module-level fact, \
call workspace_publish so siblings can benefit.

1. **Provider A investigator**: Query the workspace first. Then read \
src/agent/providers/anthropic-direct/ — find every retry loop, rate-limit \
handler, backoff strategy, and error recovery path.  Publish your findings \
before returning.  Then query the workspace again and read \
src/agent/providers/index.ts if a sibling has not already covered it.

2. **Provider B investigator**: Query the workspace first. Then read \
src/agent/providers/openai-compatible/ — find every retry loop, rate-limit \
handler, backoff strategy, and error recovery path.  Publish your findings \
before returning.  Then query the workspace again and read \
src/agent/providers/index.ts if a sibling has not already covered it.

3. **Shared-infrastructure investigator**: Query the workspace first. Then \
read src/agent/providers/index.ts, src/agent/session.ts, and src/config/env.ts \
— find retry-related env vars, shared error classification, and any \
provider-agnostic retry/backoff infrastructure.  Publish your findings before \
returning.  Then query the workspace again and read \
src/agent/providers/anthropic-direct/index.ts if a sibling has not already \
covered it.

After all three complete, synthesize a comparison table showing:
- Which retry mechanisms are provider-specific vs shared
- Whether the two providers handle 429s consistently
- Any gaps where one provider has retry coverage the other lacks

Write the comparison to a file at /tmp/workspace-ab-result.md.
`.trim();

/**
 * Compute a stable SHA-256 hex digest of the prompt so it can be embedded in
 * the experiment manifest for reproducibility checks.
 */
export function promptHash(prompt: string): string {
  return createHash('sha256').update(prompt, 'utf8').digest('hex');
}
