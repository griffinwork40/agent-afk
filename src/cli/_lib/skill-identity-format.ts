import type { SkillIdentity } from '../../agent/types/skill-identity.js';
import { redactSecrets } from '../../agent/redact-secrets.js';
import { sanitizeForDisplay } from '../../utils/terminal-sanitize.js';
import { truncateDisplayWidth } from '../display.js';
export type { SkillIdentity } from '../../agent/types/skill-identity.js';

/** Column budgets, not UTF-16 lengths. Redaction always precedes truncation. */
export const SKILL_IDENTITY_BUDGETS = { name: 32, purpose: 96, arguments: 96, total: 240 } as const;
const clean = (text: string): string => sanitizeForDisplay(text).replace(/\s+/gu, ' ').trim();
// Deliberately conservative: omit the entire argument summary rather than parse
// shell quoting. This is heuristic, not a guarantee of detecting every secret.
const credentialMaterial = /(?:password|passwd|secret|token|api[-_]?key|authorization|cookie|credential|bearer)\b|:\/\/[^\s/]+:[^\s/]+@|BEGIN .*PRIVATE KEY/i;

export function sanitizeSkillIdentity(input: SkillIdentity): SkillIdentity {
  const name = truncateDisplayWidth(redactSecrets(clean(input.name)), SKILL_IDENTITY_BUDGETS.name);
  const purpose = input.purpose ? truncateDisplayWidth(redactSecrets(clean(input.purpose)), SKILL_IDENTITY_BUDGETS.purpose) : '';
  const args = input.arguments ? clean(input.arguments) : '';
  const argumentsText = credentialMaterial.test(args) ? '[arguments omitted]' : truncateDisplayWidth(redactSecrets(args), SKILL_IDENTITY_BUDGETS.arguments);
  return { name, ...(purpose ? { purpose } : {}), ...(argumentsText ? { arguments: argumentsText } : {}) };
}

/** Activity displaces optional context, never the invocation name. */
export function formatSkillIdentity(input: SkillIdentity, width: number, activity?: string): string {
  const identity = sanitizeSkillIdentity(input);
  const detail = activity || [identity.purpose, identity.arguments ? `args: ${identity.arguments}` : undefined].filter(Boolean).join(' · ');
  return truncateDisplayWidth(`/${identity.name}${detail ? ` · ${detail}` : ''}`, Math.max(0, Math.min(width, SKILL_IDENTITY_BUDGETS.total)));
}

/** Same progress-slot composition for OverlayComposer and direct fallback. */
export function skillIdentityBanner(identity: SkillIdentity | undefined, lines: string[], width: number): string {
  if (!identity) return lines.join('\n');
  return formatSkillIdentity(identity, width, lines.length ? lines.join(' · ').trim() : undefined);
}
