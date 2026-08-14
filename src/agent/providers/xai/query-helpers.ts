/**
 * Query-side helpers for the xAI provider (error rewrite, expired-token check,
 * error-only ProviderQuery).
 *
 * @module agent/providers/xai/query-helpers
 */

import type { ProviderQuery } from '../../provider.js';
import { formatXaiHttpAuthError } from './auth.js';
import { resolveXaiEndpoint, type XaiAuthMode } from './endpoints.js';
import { getErrorStatus } from '../openai-compatible/query/retry.js';

export function isAccessTokenExpired(expiresAt: number | undefined): boolean {
  if (typeof expiresAt !== 'number') return false;
  return expiresAt <= Math.floor(Date.now() / 1000);
}

/** Map OpenAI-SDK HTTP 402/403 into SuperGrok-oriented remediation text. */
export function rewriteXaiHttpError(error: unknown, mode: XaiAuthMode): Error {
  const status = getErrorStatus(error);
  if (status !== 402 && status !== 403) {
    return error instanceof Error ? error : new Error(String(error));
  }
  const bodySnippet =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : undefined;
  const endpoint = resolveXaiEndpoint(mode);
  return new Error(
    formatXaiHttpAuthError(status, {
      mode,
      baseURL: endpoint.baseURL,
      ...(bodySnippet !== undefined ? { bodySnippet } : {}),
    }),
  );
}

/** Error-only query used when auth cannot be resolved. */
export function errorOnlyQuery(message: string): ProviderQuery {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'error', error: new Error(message) };
    },
    async interrupt() {},
    async setModel() {},
    async setPermissionMode() {},
    async supportedCommands() {
      return [];
    },
    async supportedModels() {
      return [];
    },
    async supportedAgents() {
      return [];
    },
    async getContextUsage() {
      return {};
    },
    async mcpServerStatus() {
      return [];
    },
    async accountInfo() {
      return {};
    },
    async rewindFiles() {
      return { canRewind: false, error: message };
    },
    async close() {},
  };
}
