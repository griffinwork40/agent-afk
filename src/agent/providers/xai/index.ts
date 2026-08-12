/**
 * First-class xAI provider for Grok models.
 *
 * Composes {@link OpenAICompatibleProvider} for the Chat Completions wire path
 * while owning SuperGrok / SuperGrok Heavy / X Premium+ OAuth + dual endpoints:
 *   - apikey mode → https://api.x.ai/v1 (XAI_API_KEY)
 *   - oauth mode  → https://cli-chat-proxy.grok.com/v1 by default
 *
 * @module agent/providers/xai
 */

import type {
  ModelProvider,
  ProviderQuery,
  ProviderQueryArgs,
  ProviderCompleteArgs,
} from '../../provider.js';
import type { OpenAICompatibleProviderOptions } from '../openai-compatible/index.js';
import { OpenAICompatibleProvider } from '../openai-compatible/index.js';
import {
  formatXaiAuthDiagnostic,
  resolveXaiAuth,
  type XaiAuthForceMode,
  type XaiAuthResolverDeps,
} from './auth.js';
import { resolveCompleteForceMode, resolveXaiForceMode } from './force-mode.js';
import { resolveXaiEndpoint, type XaiAuthMode } from './endpoints.js';
import { ensureFreshAccessToken } from './oauth.js';
import { buildOAuthRefreshQuery } from './query-bootstrap.js';
import { errorOnlyQuery, isAccessTokenExpired } from './query-helpers.js';

export { resolveXaiForceMode, resolveCompleteForceMode } from './force-mode.js';

const PROVIDER_NAME = 'xai';

export interface XaiProviderOptions extends OpenAICompatibleProviderOptions {
  /**
   * Forced auth mode when the provider was built for `--provider xai`
   * (`apikey`) or `xai-oauth` (`oauth`). Slot `forceXaiOAuth` still wins for
   * oauth when set. `undefined` = auto (ambiguous when both credentials).
   */
  authMode?: XaiAuthForceMode;
  /** Injectable auth deps (tests). */
  authDeps?: XaiAuthResolverDeps;
}

export class XaiProvider implements ModelProvider {
  readonly name = PROVIDER_NAME;
  private readonly inner: OpenAICompatibleProvider;
  private readonly authMode: XaiAuthForceMode;
  private readonly authDeps: XaiAuthResolverDeps;
  /** Last resolved auth mode — used to rewrite 402/403 diagnostics. */
  private lastMode: XaiAuthMode = 'apikey';
  /**
   * Contract: `complete()` has no AgentConfig, so slot `forceXai*` / `xaiBaseUrl`
   * are invisible there. After a successful `query()` resolution we reuse the
   * last mode + slot base override so ghost-text oneshots match main turns
   * (dual-cred + slot-forced path). Undefined until the first successful resolve.
   */
  private lastResolvedMode: XaiAuthMode | undefined;
  private lastXaiBaseUrl: string | undefined;

  constructor(opts: XaiProviderOptions = {}) {
    const { authMode, authDeps, ...innerOpts } = opts;
    this.authMode = authMode;
    this.authDeps = authDeps ?? {};
    this.inner = new OpenAICompatibleProvider(innerOpts);
  }

  /**
   * Prepare config + inner endpoint defaults, then delegate to the composed
   * OpenAI-compatible provider. OAuth near-expiry refresh runs in the async
   * bootstrap when mode is oauth or auto.
   */
  query(args: ProviderQueryArgs): ProviderQuery {
    const forceMode = resolveXaiForceMode(
      this.authMode,
      args.config.forceXaiOAuth,
      args.config.forceXaiApiKey,
    );
    if (forceMode === 'oauth' || forceMode === undefined) {
      return buildOAuthRefreshQuery({
        args,
        forceMode,
        authDeps: this.authDeps,
        getLastMode: () => this.lastMode,
        delegate: (a, key, mode) => this.delegateToInner(a, key, mode),
      });
    }
    return this.querySync(args, forceMode);
  }

  private querySync(args: ProviderQueryArgs, forceMode: XaiAuthForceMode): ProviderQuery {
    const resolution = resolveXaiAuth(args.config.apiKey, forceMode, this.authDeps);
    if (resolution.apiKey === null || !resolution.mode) {
      return errorOnlyQuery(formatXaiAuthDiagnostic(resolution));
    }
    return this.delegateToInner(args, resolution.apiKey, resolution.mode);
  }

  private delegateToInner(
    args: ProviderQueryArgs,
    apiKey: string,
    mode: XaiAuthMode,
  ): ProviderQuery {
    this.rememberResolved(mode, args.config.xaiBaseUrl);
    // Invariant: never use config.openaiBaseUrl (global AFK_OPENAI_BASE_URL /
    // OpenAI shims). Only slot xaiBaseUrl or AFK_XAI_* via resolveXaiEndpoint.
    const endpoint = resolveXaiEndpoint(mode, {
      readEnv: this.authDeps.readEnv
        ? (k) => this.authDeps.readEnv!(k)
        : undefined,
      ...(args.config.xaiBaseUrl !== undefined
        ? { baseUrlOverride: args.config.xaiBaseUrl }
        : {}),
    });
    this.inner.setEndpointDefaults({
      baseURL: endpoint.baseURL,
      defaultHeaders: endpoint.defaultHeaders,
    });
    const config = {
      ...args.config,
      apiKey,
      // Authoritative xAI endpoint — ignore inherited openaiBaseUrl.
      openaiBaseUrl: endpoint.baseURL,
      // Never take ChatGPT OAuth path when composing openai-compatible.
      forceChatgptOAuth: false,
      forceXaiOAuth: mode === 'oauth',
      forceXaiApiKey: mode === 'apikey',
    };
    return this.inner.query({ ...args, config });
  }

  /** Memoize mode + slot base for complete() / diagnostics. */
  private rememberResolved(mode: XaiAuthMode, xaiBaseUrl?: string): void {
    this.lastMode = mode;
    this.lastResolvedMode = mode;
    this.lastXaiBaseUrl = xaiBaseUrl;
  }

  // Grant-manager surface — forward so slash commands work on Grok sessions.
  addReadRoot(absPath: string, source: 'slash' | 'tool' = 'slash', sessionId?: string): void {
    this.inner.addReadRoot(absPath, source, sessionId);
  }
  addWriteRoot(absPath: string, source: 'slash' | 'tool' = 'slash', sessionId?: string): void {
    this.inner.addWriteRoot(absPath, source, sessionId);
  }
  revokeRoot(absPath: string, source: 'slash' | 'tool' = 'slash', sessionId?: string): void {
    this.inner.revokeRoot(absPath, source, sessionId);
  }
  getGrants(): {
    resolveBase: string | undefined;
    readRoots: string[];
    writeRoots: string[];
    allowAll: boolean;
  } {
    return this.inner.getGrants();
  }

  close(): void {
    this.inner.close();
  }

  async complete(args: ProviderCompleteArgs): Promise<string> {
    // Prefer last query() resolution (slot forceXai* / dual-cred) over bare
    // construction authMode — complete() has no AgentConfig to re-read forces.
    const forceMode = resolveCompleteForceMode(this.authMode, this.lastResolvedMode);
    if (forceMode === 'oauth' || forceMode === undefined) {
      await ensureFreshAccessToken({ store: this.authDeps.store });
    }
    const resolution = resolveXaiAuth(args.apiKey, forceMode, this.authDeps);
    if (resolution.apiKey === null || !resolution.mode) {
      throw new Error(formatXaiAuthDiagnostic(resolution));
    }
    if (resolution.mode === 'oauth' && isAccessTokenExpired(resolution.expiresAt)) {
      throw new Error(
        'SuperGrok OAuth access token expired and refresh failed. Re-run `afk provider auth xai login`.',
      );
    }
    this.rememberResolved(resolution.mode, this.lastXaiBaseUrl);
    const endpoint = resolveXaiEndpoint(resolution.mode, {
      readEnv: this.authDeps.readEnv,
      ...(this.lastXaiBaseUrl !== undefined
        ? { baseUrlOverride: this.lastXaiBaseUrl }
        : {}),
    });
    // Match query(): endpoint + CLI-proxy identity headers.
    this.inner.setEndpointDefaults({
      baseURL: endpoint.baseURL,
      defaultHeaders: endpoint.defaultHeaders,
    });
    return this.inner.complete({
      ...args,
      apiKey: resolution.apiKey,
      // Invariant: never forward args.baseUrl (suggest engine passes
      // AFK_OPENAI_BASE_URL). Only resolveXaiEndpoint / lastXaiBaseUrl.
      baseUrl: endpoint.baseURL,
    });
  }
}

export {
  resolveXaiAuth,
  formatXaiAuthDiagnostic,
  formatXaiHttpAuthError,
  type XaiAuthResolution,
  type XaiAuthSource,
} from './auth.js';
export {
  resolveXaiEndpoint,
  DEFAULT_XAI_API_BASE_URL,
  DEFAULT_XAI_OAUTH_BASE_URL,
  type XaiAuthMode,
} from './endpoints.js';
export {
  readXaiTokens,
  writeXaiTokens,
  clearXaiTokens,
  getXaiAuthPath,
} from './auth-store.js';
export {
  startDeviceCodeFlow,
  pollDeviceCodeToken,
  buildPkceAuthorizeUrl,
  exchangeAuthorizationCode,
  generateCodeVerifier,
  generateOAuthState,
  refreshXaiTokens,
  ensureFreshAccessToken,
  discoverXaiOidc,
} from './oauth.js';
export {
  deriveXaiCallCostUsd,
  isGrokModelId,
  XAI_MODEL_PRICING,
} from './pricing.js';
