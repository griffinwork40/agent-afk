/**
 * Pluggable audio transcription interface and OpenAI-compatible implementation.
 *
 * Design:
 *   - `AudioTranscriber` is a thin interface so callers can substitute any
 *     backend (real API, local Whisper, test stub) without coupling to HTTP.
 *   - `createTranscriber` is the factory callers use at runtime; it reads
 *     env vars only when invoked so tests can stub `process.env` freely.
 *   - When no backend is configured the factory returns `null` and the caller
 *     replies with a human-readable message naming the env var to set.
 *   - Audio bytes are never written to disk; the Buffer is sent directly as a
 *     multipart form-data body and discarded after the call returns.
 *
 * Env vars (all optional, registered in env.telegram.ts):
 *   AFK_TRANSCRIBE_API_URL  — OpenAI-compatible endpoint, e.g.
 *                             https://api.openai.com/v1/audio/transcriptions
 *                             or a local Whisper server URL.
 *   AFK_TRANSCRIBE_API_KEY  — Bearer token for the endpoint.  Required when
 *                             the endpoint enforces authentication.
 *   AFK_TRANSCRIBE_MODEL    — Model name forwarded in the form field
 *                             (default: whisper-1).
 *
 * @module telegram/audio-transcriber
 */

/** Result of a transcription attempt. */
export type TranscribeResult =
  | { status: 'ok'; text: string }
  | { status: 'empty' }
  | { status: 'too-large'; maxBytes: number }
  | { status: 'api-error'; httpStatus: number; safeMessage: string }
  | { status: 'network-error'; safeMessage: string }
  | { status: 'parse-error'; safeMessage: string };

/** Pluggable transcription backend. */
export interface AudioTranscriber {
  /**
   * Transcribe raw audio bytes.
   *
   * @param bytes    Audio data (ogg/opus from Telegram voice, mp3/m4a for
   *                 audio messages).  Must not exceed `maxBytes`.
   * @param fileName Hint for the multipart filename field; the server uses it
   *                 to infer the codec when not given a MIME type.
   * @param maxBytes Hard cap — callers must enforce this before calling, but
   *                 the implementation may re-check and return `too-large`.
   */
  transcribe(bytes: Buffer, fileName: string, maxBytes: number): Promise<TranscribeResult>;
}

/** Strip Bearer tokens from error messages before they reach logs. */
function redactBearer(text: string): string {
  return text.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
}

/** Seam type for the SSRF egress check injected at construction time. */
type EgressCheckFn = (url: string) => Promise<{ allowed: boolean; reason?: string }>;

/**
 * OpenAI-compatible `/audio/transcriptions` transcriber.
 *
 * Sends a multipart/form-data POST with the audio file and model field.
 * The API key is included as a Bearer token when configured.
 * Redirects are never followed (SI-4 from media-download.ts applied here too).
 * When a `checkEgress` function is supplied, it is called before every fetch
 * to reject private/loopback/link-local/cloud-metadata hosts (SSRF guard).
 */

export class OpenAIAudioTranscriber implements AudioTranscriber {
  constructor(
    private readonly apiUrl: string,
    private readonly apiKey: string | undefined,
    private readonly model: string,
    private readonly timeoutMs: number = 60_000,
    private readonly checkEgress?: EgressCheckFn,
  ) {}

  async transcribe(bytes: Buffer, fileName: string, maxBytes: number): Promise<TranscribeResult> {
    if (bytes.byteLength > maxBytes) {
      return { status: 'too-large', maxBytes };
    }

    // SSRF host guard: reject private/loopback/link-local/cloud-metadata hosts.
    // Runs at transcribe-time so async DNS resolution is available.
    //
    // DNS-rebinding TOCTOU note: the egress guard resolves the hostname once
    // here; `fetch()` performs its own independent resolution milliseconds
    // later.  A DNS entry with a short TTL could map to a public IP at guard
    // time and a private IP at fetch time, bypassing the guard.  This is a
    // pre-existing pattern shared by all egress-guard consumers in this
    // codebase.  Mitigations (pinned IP connection, 0-TTL detection) are
    // tracked as a separate hardening item.
    if (this.checkEgress) {
      let verdict: { allowed: boolean; reason?: string };
      try {
        verdict = await this.checkEgress(this.apiUrl);
      } catch (err) {
        const raw = String(err instanceof Error ? err.message : err);
        return { status: 'network-error', safeMessage: `SSRF egress check failed: ${redactBearer(raw)}` };
      }
      if (!verdict.allowed) {
        return {
          status: 'network-error',
          safeMessage: `AFK_TRANSCRIBE_API_URL blocked by SSRF guard: ${redactBearer(verdict.reason ?? 'private or internal host')}`,
        };
      }
    }

    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(bytes)]), fileName);
    form.append('model', this.model);
    form.append('response_format', 'json');

    const headers: Record<string, string> = {};
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    let response: Response;
    try {
      response = await globalThis.fetch(this.apiUrl, {
        method: 'POST',
        headers,
        body: form,
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error',
      });
    } catch (err) {
      const raw = String(err instanceof Error ? err.message : err);
      const safeMessage = redactBearer(raw);
      return { status: 'network-error', safeMessage };
    }

    if (!response.ok) {
      const safeMessage = `HTTP ${response.status}`;
      return { status: 'api-error', httpStatus: response.status, safeMessage };
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (err) {
      return { status: 'parse-error', safeMessage: 'Response was not valid JSON' };
    }

    if (
      json == null ||
      typeof json !== 'object' ||
      !('text' in json) ||
      typeof (json as { text: unknown }).text !== 'string'
    ) {
      return { status: 'parse-error', safeMessage: 'Missing "text" field in response' };
    }

    const text = ((json as { text: string }).text).trim();
    if (!text) return { status: 'empty' };
    return { status: 'ok', text };
  }
}

/** Default model name for OpenAI-compatible Whisper endpoints. */
const DEFAULT_WHISPER_MODEL = 'whisper-1';

/**
 * Factory: return a configured transcriber or `null` when no backend is set.
 *
 * Reads env vars at call time so tests can stub `process.env` without module
 * re-loading.  Only `AFK_TRANSCRIBE_API_URL` is required; the key and model
 * have defaults.
 *
 * @param opts.checkEgress  SSRF egress-check function injected by the caller.
 *   When omitted (default `{}`), the SSRF guard is disabled and any URL
 *   (including private/loopback/cloud-metadata hosts) will be fetched.
 *   Production callers should always supply this from `ssrf-guard.ts`.
 */
export function createTranscriber(
  env: {
    AFK_TRANSCRIBE_API_URL?: string;
    AFK_TRANSCRIBE_API_KEY?: string;
    AFK_TRANSCRIBE_MODEL?: string;
    AFK_TRANSCRIBE_TIMEOUT_MS?: string;
  },
  opts: { checkEgress?: (url: string) => Promise<{ allowed: boolean; reason?: string }> } = {},
): AudioTranscriber | null {
  const url = env.AFK_TRANSCRIBE_API_URL?.trim();
  if (!url) return null;

  // Reject non-http(s) schemes — the download path has an SSRF guard;
  // this POST to the transcription endpoint must not be looser.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`AFK_TRANSCRIBE_API_URL is not a valid URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `AFK_TRANSCRIBE_API_URL must use http or https (got ${parsed.protocol}): ${url}`,
    );
  }

  const rawTimeout = env.AFK_TRANSCRIBE_TIMEOUT_MS?.trim();
  const timeoutMs = rawTimeout ? parseInt(rawTimeout, 10) : 60_000;
  if (rawTimeout && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    console.warn(`[audio-transcriber] AFK_TRANSCRIBE_TIMEOUT_MS="${rawTimeout}" is not a valid positive integer; falling back to 60 000 ms`);
  }
  const resolvedTimeout =
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60_000;

  return new OpenAIAudioTranscriber(
    url,
    env.AFK_TRANSCRIBE_API_KEY?.trim() || undefined,
    env.AFK_TRANSCRIBE_MODEL?.trim() || DEFAULT_WHISPER_MODEL,
    resolvedTimeout,
    opts.checkEgress,
  );
}
