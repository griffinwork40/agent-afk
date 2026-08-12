/**
 * Async query bootstrap for SuperGrok OAuth (refresh + 402/403 rewrite).
 *
 * @module agent/providers/xai/query-bootstrap
 */

import type { ProviderQuery, ProviderQueryArgs } from '../../provider.js';
import {
  formatXaiAuthDiagnostic,
  resolveXaiAuth,
  type XaiAuthForceMode,
  type XaiAuthResolverDeps,
} from './auth.js';
import type { XaiAuthMode } from './endpoints.js';
import { ensureFreshAccessToken } from './oauth.js';
import type { XaiAuthStoreDeps } from './auth-store.js';
import {
  isAccessTokenExpired,
  rewriteXaiHttpError,
} from './query-helpers.js';

export interface XaiQueryBootstrapArgs {
  args: ProviderQueryArgs;
  forceMode: XaiAuthForceMode;
  authDeps: XaiAuthResolverDeps;
  getLastMode: () => XaiAuthMode;
  delegate: (args: ProviderQueryArgs, apiKey: string, mode: XaiAuthMode) => ProviderQuery;
}

/** Prefer forced/resolved mode for diagnostics before first successful delegate. */
function diagnosticMode(
  forceMode: XaiAuthForceMode,
  getLastMode: () => XaiAuthMode,
): XaiAuthMode {
  if (forceMode === 'oauth' || forceMode === 'apikey') return forceMode;
  return getLastMode();
}

/**
 * Build a ProviderQuery that refreshes OAuth when needed, then pumps the
 * inner query and rewrites 402/403 errors into SuperGrok remediation text.
 */
export function buildOAuthRefreshQuery(opts: XaiQueryBootstrapArgs): ProviderQuery {
  const { args, forceMode, authDeps, getLastMode, delegate } = opts;
  let innerQuery: ProviderQuery | undefined;
  let initError: Error | undefined;

  const ensureInner = async (): Promise<ProviderQuery> => {
    if (initError) throw initError;
    if (innerQuery) return innerQuery;
    try {
      // Refresh OAuth when needed; skip pure apikey construction mode.
      if (forceMode !== 'apikey') {
        await ensureFreshAccessToken({
          store: authDeps.store as XaiAuthStoreDeps | undefined,
        });
      }
      const resolution = resolveXaiAuth(args.config.apiKey, forceMode, authDeps);
      if (resolution.apiKey === null || !resolution.mode) {
        throw new Error(formatXaiAuthDiagnostic(resolution));
      }
      if (resolution.mode === 'oauth' && isAccessTokenExpired(resolution.expiresAt)) {
        throw new Error(
          'SuperGrok OAuth access token expired and refresh failed. Re-run `afk provider auth xai login`.',
        );
      }
      innerQuery = delegate(args, resolution.apiKey, resolution.mode);
      return innerQuery;
    } catch (e) {
      initError = e instanceof Error ? e : new Error(String(e));
      throw initError;
    }
  };

  return {
    async *[Symbol.asyncIterator]() {
      try {
        const q = await ensureInner();
        for await (const ev of q) {
          if (ev.type === 'error') {
            yield {
              type: 'error',
              error: rewriteXaiHttpError(ev.error, diagnosticMode(forceMode, getLastMode)),
            };
          } else {
            yield ev;
          }
        }
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        yield {
          type: 'error',
          error: rewriteXaiHttpError(err, diagnosticMode(forceMode, getLastMode)),
        };
      }
    },
    async interrupt(reason) {
      const q = innerQuery ?? (await ensureInner().catch(() => undefined));
      await q?.interrupt(reason);
    },
    async setModel(model) {
      const q = innerQuery ?? (await ensureInner().catch(() => undefined));
      await q?.setModel(model);
    },
    async setPermissionMode(mode) {
      const q = innerQuery ?? (await ensureInner().catch(() => undefined));
      await q?.setPermissionMode(mode);
    },
    setCwd(cwd: string) {
      innerQuery?.setCwd?.(cwd);
    },
    setSystemPrompt(basePrompt: string | undefined) {
      return innerQuery?.setSystemPrompt?.(basePrompt) ?? false;
    },
    async reauth() {
      const q = innerQuery ?? (await ensureInner().catch(() => undefined));
      return (await q?.reauth?.()) ?? null;
    },
    async supportedCommands() {
      const q = innerQuery ?? (await ensureInner().catch(() => undefined));
      return (await q?.supportedCommands()) ?? [];
    },
    async supportedModels() {
      const q = innerQuery ?? (await ensureInner().catch(() => undefined));
      return (await q?.supportedModels()) ?? [];
    },
    async supportedAgents() {
      const q = innerQuery ?? (await ensureInner().catch(() => undefined));
      return (await q?.supportedAgents()) ?? [];
    },
    async getContextUsage() {
      const q = innerQuery ?? (await ensureInner().catch(() => undefined));
      return (await q?.getContextUsage()) ?? {};
    },
    async mcpServerStatus() {
      const q = innerQuery ?? (await ensureInner().catch(() => undefined));
      return (await q?.mcpServerStatus()) ?? [];
    },
    async accountInfo() {
      const q = innerQuery ?? (await ensureInner().catch(() => undefined));
      return (await q?.accountInfo()) ?? {};
    },
    async rewindFiles(userMessageId, options) {
      const q = innerQuery ?? (await ensureInner().catch(() => undefined));
      if (!q) return { canRewind: false, error: 'xAI provider not initialized' };
      return q.rewindFiles(userMessageId, options);
    },
    async compact() {
      const q = innerQuery ?? (await ensureInner().catch(() => undefined));
      if (q?.compact) return q.compact();
      return {
        compacted: false,
        reason: 'provider does not support compaction',
        messagesBefore: 0,
        messagesAfter: 0,
      };
    },
    listRewindTargets() {
      return innerQuery?.listRewindTargets?.() ?? [];
    },
    async rewindConversation(turnIndex) {
      const q = innerQuery ?? (await ensureInner().catch(() => undefined));
      if (q?.rewindConversation) return q.rewindConversation(turnIndex);
      return {
        rewound: false,
        reason: 'not-supported',
        messagesBefore: 0,
        messagesAfter: 0,
      };
    },
    async close() {
      await innerQuery?.close();
    },
  };
}
