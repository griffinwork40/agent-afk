/**
 * SuperGrok / SuperGrok Heavy / X Premium+ OAuth login/logout helpers.
 * Used by `afk provider auth xai login|logout`. Device-code is the default
 * (daemon / Telegram / SSH); browser PKCE is available via --browser.
 *
 * @module cli/commands/provider-xai-login
 */

// Import leaf modules only — avoid `xai/index` (pulls OpenAICompatibleProvider
// + better-sqlite3 MemoryStore at module load).
import { clearXaiTokens, writeXaiTokens } from '../../agent/providers/xai/auth-store.js';
import {
  startDeviceCodeFlow,
  pollDeviceCodeToken,
  positiveSeconds,
  type DevicePollResult,
} from '../../agent/providers/xai/oauth-device.js';
import {
  discoverXaiOidc,
} from '../../agent/providers/xai/oauth-http.js';
import {
  buildPkceAuthorizeUrl,
  exchangeAuthorizationCode,
  generateCodeVerifier,
  generateOAuthState,
} from '../../agent/providers/xai/oauth-pkce.js';
import { XAI_OAUTH_REDIRECT_URI } from '../../agent/providers/xai/oauth-constants.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { URL } from 'node:url';

export interface XaiLoginResult {
  ok: boolean;
  message: string;
  last4?: string;
}

/**
 * Run device-code login. Prints progress via `onStatus`.
 */
export async function runXaiDeviceCodeLogin(opts: {
  onStatus?: (line: string) => void;
  /** Max wall-clock wait in ms (default 15 minutes). */
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<XaiLoginResult> {
  const log = opts.onStatus ?? (() => undefined);
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const timeoutMs = opts.timeoutMs ?? 15 * 60 * 1000;

  const { discovery, device } = await startDeviceCodeFlow();
  log('Sign in with SuperGrok / SuperGrok Heavy / X Premium+ (device code):');
  log('');
  log(`  Visit: ${device.verification_uri_complete ?? device.verification_uri}`);
  log(`  Code:  ${device.user_code}`);
  log('');
  log('Waiting for authorization…');

  const deadline = Date.now() + timeoutMs;
  // positiveSeconds rejects NaN/≤0 from a misbehaving device endpoint.
  let intervalMs = positiveSeconds(device.interval, 5) * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const result: DevicePollResult = await pollDeviceCodeToken(discovery, device.device_code);
    if (result.status === 'pending') continue;
    if (result.status === 'slow_down') {
      // RFC 8628 / OpenCode: bump by at least 5s; also honor a larger server interval.
      const serverMs = positiveSeconds(result.interval, 5) * 1000;
      intervalMs = Math.max(intervalMs + 5000, serverMs);
      continue;
    }
    if (result.status === 'expired') {
      return { ok: false, message: 'Device code expired. Re-run `afk provider auth xai login`.' };
    }
    if (result.status === 'denied') {
      return { ok: false, message: 'Authorization denied.' };
    }
    if (result.status === 'error') {
      return { ok: false, message: `OAuth error: ${result.message}` };
    }
    // success
    writeXaiTokens(result.tokens);
    const last4 = result.tokens.access_token.slice(-4);
    return {
      ok: true,
      message:
        'SuperGrok / SuperGrok Heavy / X Premium+ OAuth tokens saved. ' +
        'Use Grok models with `--provider xai-oauth` or auto-routing when no XAI_API_KEY is set.',
      last4,
    };
  }
  return { ok: false, message: 'Timed out waiting for device authorization.' };
}

/**
 * Browser PKCE loopback login on http://127.0.0.1:56121/callback.
 */
export async function runXaiBrowserLogin(opts: {
  onStatus?: (line: string) => void;
  openBrowser?: (url: string) => void;
  timeoutMs?: number;
}): Promise<XaiLoginResult> {
  const log = opts.onStatus ?? (() => undefined);
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
  const discovery = await discoverXaiOidc();
  const codeVerifier = generateCodeVerifier();
  const state = generateOAuthState();
  const pkce = buildPkceAuthorizeUrl(discovery, { codeVerifier, state });

  const code = await waitForLoopbackCode({
    expectedState: state,
    authorizationUrl: pkce.authorizationUrl,
    onStatus: log,
    openBrowser: opts.openBrowser,
    timeoutMs,
  });

  const tokens = await exchangeAuthorizationCode(discovery, {
    code,
    codeVerifier: pkce.codeVerifier,
    redirectUri: pkce.redirectUri,
  });
  writeXaiTokens(tokens);
  return {
    ok: true,
    message: 'SuperGrok OAuth tokens saved via browser PKCE.',
    last4: tokens.access_token.slice(-4),
  };
}

export function runXaiLogout(): XaiLoginResult {
  clearXaiTokens();
  return {
    ok: true,
    message: 'Cleared SuperGrok / SuperGrok Heavy / X Premium+ OAuth tokens.',
  };
}

async function waitForLoopbackCode(opts: {
  expectedState: string;
  authorizationUrl: string;
  onStatus: (line: string) => void;
  openBrowser?: (url: string) => void;
  timeoutMs: number;
}): Promise<string> {
  const redirect = new URL(XAI_OAUTH_REDIRECT_URI);
  const port = Number(redirect.port || 56121);

  return new Promise<string>((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      try {
        const u = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
        if (u.pathname !== redirect.pathname) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        const err = u.searchParams.get('error');
        if (err) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end(`Authorization failed: ${err}`);
          server.close();
          reject(new Error(`OAuth error: ${err}`));
          return;
        }
        const gotState = u.searchParams.get('state');
        const code = u.searchParams.get('code');
        if (!code || gotState !== opts.expectedState) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Invalid state or missing code');
          server.close();
          reject(new Error('Invalid OAuth callback (state/code)'));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('agent-afk: SuperGrok login complete. You can close this tab.');
        server.close();
        resolve(code);
      } catch (e) {
        server.close();
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });

    const timer = setTimeout(() => {
      server.close();
      reject(new Error('Timed out waiting for browser OAuth callback'));
    }, opts.timeoutMs);

    server.listen(port, '127.0.0.1', () => {
      opts.onStatus(`Open this URL to sign in (loopback :${port}):`);
      opts.onStatus(opts.authorizationUrl);
      opts.onStatus('');
      opts.openBrowser?.(opts.authorizationUrl);
    });

    server.on('close', () => clearTimeout(timer));
    server.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}
