import { randomUUID } from 'node:crypto';
import type { EffectRecord } from './types.js';

/** Opt-in only: header support is a remote API contract, not an HTTP property. */
export function remoteIdempotencyInput(
  toolName: string, input: unknown, prior: EffectRecord | null,
): { updatedInput?: Record<string, unknown>; remoteIdempotencyKey?: string } {
  if (toolName !== 'web_request' || !input || typeof input !== 'object') return {};
  const args = input as Record<string, unknown>;
  if (args['remote_idempotency'] !== true) return {};
  const rawHeaders = args['headers'];
  if (rawHeaders !== undefined && (!rawHeaders || typeof rawHeaders !== 'object' || Array.isArray(rawHeaders))) return {};
  const headers = (rawHeaders ?? {}) as Record<string, unknown>;
  // Do not repair invalid inputs or replace caller keys, regardless of casing.
  if (Object.values(headers).some((value) => typeof value !== 'string')) return {};
  const supplied = Object.keys(headers).find((name) => name.toLowerCase() === 'idempotency-key');
  // Intentional repetitions and independent sessions must NOT share a remote key.
  // Only retries of an uncertain attempt reuse its persisted remote identity.
  const uncertain = prior?.status === 'unknown' || prior?.status === 'pending';
  const key = supplied ? headers[supplied] as string
    : (uncertain ? prior.remoteIdempotencyKey : undefined) ?? randomUUID();
  return {
    remoteIdempotencyKey: key,
    updatedInput: { ...args, headers: supplied ? { ...headers } : { ...headers, 'Idempotency-Key': key } },
  };
}
