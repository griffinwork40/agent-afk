/**
 * Bounded, security-hardened Telegram file download pipeline.
 *
 * Both the document handler and the photo handler need the same pipeline:
 *   URL coercion → HTTPS/host/port restriction → redirect rejection →
 *   15 s timeout → bounded streaming → typed result
 *
 * Because the URL contains the live bot token, error messages produced here
 * are token-safe: the raw URL is never included in any returned string.
 *
 * Callers are responsible for classifying the result and deciding what
 * user-facing message to send.
 *
 * @module telegram/media-download
 */

import { readResponseBytesWithLimit } from './handlers/message.media-helpers.js';

export type DownloadResult =
  | { status: 'ok'; bytes: Buffer }
  | { status: 'ssrf-rejected'; protocol: string; hostname: string }
  | { status: 'fetch-failed'; httpStatus: number }
  | { status: 'too-large'; bytesRead: number }
  | { status: 'missing-body' }
  | { status: 'network-error'; safeMessage: string };

/**
 * Download a Telegram CDN file with all security restrictions applied.
 *
 * @param fileUrlRaw  - The raw value returned by `ctx.telegram.getFileLink()`.
 *                      Accepts both `URL` instances and plain strings (some
 *                      Telegraf forks return a string).
 * @param options.maxBytes - Hard cap on the response body. Requests whose
 *                           Content-Length header already exceeds the cap are
 *                           rejected without reading the body.
 *
 * Security invariants preserved:
 *   SI-1  Protocol must be `https:` (rejects `http:`, `ftp:`, custom schemes).
 *   SI-2  Hostname must be `api.telegram.org` exactly (prevents SSRF to
 *         internal or attacker-controlled hosts).
 *   SI-3  Port must be absent or `443` (non-standard ports are rejected even
 *         on the allowed host).
 *   SI-4  Redirects are never followed (`redirect: 'error'`), preventing a
 *         redirect chain that bypasses SI-1/SI-2/SI-3 after the initial check.
 *   SI-5  A 15-second `AbortSignal.timeout` prevents a stalled CDN response
 *         from blocking the event loop indefinitely.
 *   SI-6  The bot token (embedded in the URL path) is never included in any
 *         returned error field — callers may safely log the result.
 */
export async function downloadTelegramFile(
  fileUrlRaw: URL | string,
  options: { maxBytes: number },
): Promise<DownloadResult> {
  const { maxBytes } = options;

  // Coerce to URL — some Telegraf forks return a plain string.
  let url: URL;
  try {
    url = fileUrlRaw instanceof URL ? fileUrlRaw : new URL(String(fileUrlRaw));
  } catch {
    // Malformed URL — treat like an SSRF rejection (empty hostname/protocol).
    return { status: 'ssrf-rejected', protocol: '', hostname: '' };
  }

  // SI-1, SI-2, SI-3: validate before making any network call.
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'api.telegram.org' ||
    (url.port !== '' && url.port !== '443')
  ) {
    return { status: 'ssrf-rejected', protocol: url.protocol, hostname: url.hostname };
  }

  let response: Response;
  try {
    // SI-4, SI-5: no redirects, 15 s hard timeout.
    response = await globalThis.fetch(url.href, {
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
    });
  } catch (err) {
    // Network-level failures: ECONNREFUSED, AbortError (timeout), opaque
    // redirect error from redirect:'error'. SI-6: strip the URL entirely.
    const raw = err instanceof Error ? err.message : String(err);
    // Replace any path-like token reference in thrown error text just in case.
    const safeMessage = raw.replace(/\/bot[^/\s]+(?:\/|$)/g, '/bot[REDACTED]/');
    return { status: 'network-error', safeMessage };
  }

  if (!response.ok) {
    return { status: 'fetch-failed', httpStatus: response.status };
  }

  let readResult;
  try {
    readResult = await readResponseBytesWithLimit(response, maxBytes);
  } catch (err) {
    // Mid-stream body read failure (ECONNRESET, abort after headers).
    const raw = err instanceof Error ? err.message : String(err);
    const safeMessage = raw.replace(/\/bot[^/\s]+(?:\/|$)/g, '/bot[REDACTED]/');
    return { status: 'network-error', safeMessage };
  }
  // readResult discriminant matches DownloadResult directly for these two cases.
  if (readResult.status === 'too-large' || readResult.status === 'missing-body') {
    return readResult;
  }

  return { status: 'ok', bytes: readResult.bytes };
}
