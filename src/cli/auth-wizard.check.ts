import { oneShotCompletionWithStop } from '../agent/providers/anthropic-direct/oneshot.js';
import { classifyUsageLimitError } from '../agent/providers/anthropic-direct/usage-limit.js';
import { CLAUDE_HAIKU_ID } from '../agent/session/model-slots.js';
import { loadConfig } from './config.js';

export type CredentialCheck = { kind: 'accepted' | 'rejected' | 'credit' | 'unknown' };

/** One tiny Messages request, no SDK retries, no saved state, no raw errors printed. */
export async function checkCredential(token: string): Promise<CredentialCheck> {
  try {
    // Use the same endpoint resolution as normal Anthropic requests. When no
    // config override exists the SDK still honors ANTHROPIC_BASE_URL itself.
    const { baseUrl } = loadConfig();
    await oneShotCompletionWithStop({
      token, model: CLAUDE_HAIKU_ID, system: '', user: 'Hi', maxTokens: 1,
      signal: AbortSignal.timeout(10_000), baseUrl,
    });
    return { kind: 'accepted' };
  } catch (error) {
    if (error instanceof Error && classifyUsageLimitError(error)?.kind === 'credit-exhausted') {
      return { kind: 'credit' };
    }
    const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
    if (status === 401 || status === 403) return { kind: 'rejected' };
    return { kind: 'unknown' };
  }
}
