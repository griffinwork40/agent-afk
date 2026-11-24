import { NAME_PATTERN } from './protocol.js';

export const RESERVED_NAMES: readonly string[] = Object.freeze([
  'afk', 'admin', 'administrator', 'mod', 'moderator', 'system', 'relay',
  'maintainer', 'staff', 'support', 'anthropic', 'agent-afk',
]);
export type NameValidation = { ok: true } | { ok: false; code: 'bad_name' | 'reserved_name' };
export interface DisplayName { name: string; tag: string }
export function isReservedName(name: string): boolean {
  return RESERVED_NAMES.includes(name.toLowerCase());
}
export function validateName(name: string): NameValidation {
  if (!NAME_PATTERN.test(name) || name.includes('\n')) return { ok: false, code: 'bad_name' };
  if (isReservedName(name)) return { ok: false, code: 'reserved_name' };
  return { ok: true };
}
/** Reserved names remain parseable for display; validation is a separate policy check. */
export function formatDisplayName(name: string, tag: string): string {
  if (!NAME_PATTERN.test(name) || name.includes('\n') || tag.length !== 4 || !/^[0-9a-f]{4}$/.test(tag)) throw new Error('Invalid display name');
  return `${name}#${tag}`;
}
export function parseDisplayName(display: string): DisplayName | null {
  const match = /^([a-z0-9_-]{2,16})#([0-9a-f]{4})$/.exec(display);
  if (!match?.[1] || !match[2] || match[0] !== display) return null;
  return { name: match[1], tag: match[2] };
}
