/**
 * Parent-credential pairing for the compose executor's SubagentManager (#2844).
 *
 * Contract: returns `{ parentCredential }` only when BOTH an API key and a real
 * source model are known; otherwise `{}`. The key is paired with the model it
 * was resolved for (the session's credentialModel, falling back to its
 * defaultModel) so the child-credential fallback can never hand a key to a
 * provider it does not belong to. An undefined model must never be stringified
 * into the literal "undefined", which would make providerForModel() resolve
 * ambiguously and defeat the cross-provider guard.
 *
 * Extracted from compose-executor.ts to keep that baselined file from growing
 * past the 350-code-line ratchet.
 */
import type { AgentModelInput } from '../types.js';

export function buildParentCredentialOpt(
  apiKey: string | undefined,
  sourceModel: AgentModelInput | undefined,
): { parentCredential?: { key: string; sourceModel: string } } {
  if (apiKey === undefined || sourceModel === undefined) return {};
  return { parentCredential: { key: apiKey, sourceModel } };
}
