import type { SubagentProgressSink } from '../../types/session-types.js';
import type { SkillIdentity } from '../../types/skill-identity.js';

/** Only the direct child of this tool call carries its resolved identity. */
export function withSkillIdentity(sink: SubagentProgressSink | undefined, callId: string, identity: SkillIdentity): SubagentProgressSink | undefined {
  if (!sink) return undefined;
  return (event, meta) => sink(event, meta.parentId === callId ? { ...meta, skillIdentity: identity } : meta);
}
