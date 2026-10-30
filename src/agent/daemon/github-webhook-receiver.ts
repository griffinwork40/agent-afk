/**
 * Authenticated local HTTP webhook receiver for GitHub events (issue #3896).
 *
 * Implements `afk events serve`: a loopback-only HTTP server that accepts
 * GitHub webhook POST requests, verifies the HMAC-SHA256 signature using the
 * operator-supplied secret, extracts the event payload, and writes a task into
 * the existing pull queue — reusing the daemon's executor, budget gate,
 * telemetry, and Telegram notification paths unchanged.
 *
 * Security posture:
 *  - Binds to 127.0.0.1 only by default; refuses non-loopback without
 *    AFK_EVENTS_WEBHOOK_ALLOW_EXTERNAL=1.
 *  - Checks for the presence of `X-Hub-Signature-256` (with `sha256=` prefix)
 *    before reading any payload content; full HMAC verification follows after
 *    the body is buffered.
 *  - Event payloads are untrusted data — wrapped in delimiters in the prompt
 *    and capped at 4000 chars, consistent with the polling producer.
 *  - Permission mode and command template are operator-supplied at startup and
 *    cannot be overridden by the incoming payload.
 *
 * Supported GitHub event types (X-GitHub-Event header):
 *  - pull_request_review_comment : PR review comments
 *  - check_run                   : CI check results (failure, success, etc.)
 *  - issues                      : issue lifecycle events (opened, closed, …)
 *
 * @module agent/daemon/github-webhook-receiver
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { enqueue } from './queue-store.js';
import { renderCommand, type GithubEventType } from './github-event-poller.js';
import { errorMessage } from '../../utils/errors.js';
import { getAfkStateDir } from '../../paths.js';
import { atomicWriteFile } from '../../utils/atomic-write.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface WebhookReceiverOptions {
  /**
   * HMAC-SHA256 secret configured in the GitHub webhook settings page.
   * Every incoming request MUST have a valid X-Hub-Signature-256 header or it
   * is rejected with 401.
   */
  secret: string;
  /**
   * Command template for enqueued tasks. Placeholders:
   *   {{event_type}}  — GitHub event name from X-GitHub-Event header
   *   {{repo}}        — owner/repo extracted from payload.repository.full_name
   *   {{event_id}}    — delivery GUID from X-GitHub-Delivery header
   */
  commandTemplate: string;
  /** TCP port to bind on. Default: 9876. */
  port?: number;
  /** Bind address. Default: '127.0.0.1'. Non-loopback requires allowExternal. */
  host?: string;
  /**
   * Allow binding to a non-loopback address. When false (default) the server
   * refuses to start on a non-loopback host.
   */
  allowExternal?: boolean;
  /** Override the queue directory (for testing). */
  queueDir?: string;
  /** Override the state directory for the dedup store (for testing). */
  stateDir?: string;
}

export const DEFAULT_WEBHOOK_PORT = 9876;
export const DEFAULT_WEBHOOK_HOST = '127.0.0.1';

/** Maximum request body size accepted before the connection is dropped. */
const MAX_BODY_BYTES = 1_000_000; // 1 MB

/**
 * Map GitHub webhook event name + action/conclusion → internal GithubEventType.
 *
 * Unlike the flat Record in the poller (which only subscribes to specific
 * endpoints), the webhook receiver sees every event GitHub sends. We inspect
 * the payload's `action` and `conclusion` fields to derive the correct type:
 *  - check_run with conclusion !== 'failure' is NOT a check_failure.
 *  - issues with action !== 'opened' is NOT an issue_opened.
 *
 * Returns `undefined` for events/actions we do not map, which the handler
 * uses to decide whether to enqueue.
 */
function resolveEventType(
  githubEvent: string,
  payload: GithubPayload,
): GithubEventType | undefined {
  switch (githubEvent) {
    case 'pull_request_review_comment':
      // Deleted comments are no longer actionable — skip them.
      if (payload.action === 'deleted') return undefined;
      return 'pr_comment';
    case 'check_run': {
      // Only completed check_runs with a failure-class conclusion map to
      // check_failure. Successful / in-progress / neutral runs are not
      // actionable failures.
      const conclusion = payload.check_run?.conclusion ?? '';
      const isFailureClass = (
        conclusion === 'failure' ||
        conclusion === 'timed_out' ||
        conclusion === 'cancelled' ||
        conclusion === 'action_required' ||
        conclusion === 'stale'
      );
      if (payload.action === 'completed' && isFailureClass) {
        return 'check_failure';
      }
      return undefined;
    }
    case 'issues':
      // Only newly opened issues are actionable; closed/edited/etc are not.
      if (payload.action === 'opened') return 'issue_opened';
      return undefined;
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Delivery dedup store — prevents replayed webhooks from creating duplicates
// ---------------------------------------------------------------------------

const DEDUP_FILENAME = 'webhook-delivery-seen.json';
const DEDUP_MAX_ENTRIES = 10_000;

function getDedupPath(stateDir?: string): string {
  const dir = stateDir ?? getAfkStateDir();
  return join(dir, DEDUP_FILENAME);
}

function loadSeenSet(dedupPath: string): Set<string> {
  try {
    if (!existsSync(dedupPath)) return new Set();
    const raw = JSON.parse(readFileSync(dedupPath, 'utf-8')) as string[];
    return new Set(raw);
  } catch {
    return new Set();
  }
}

function persistSeenSet(dedupPath: string, seen: Set<string>): void {
  // Evict oldest entries when the set grows too large.
  const arr = [...seen];
  const trimmed = arr.length > DEDUP_MAX_ENTRIES
    ? arr.slice(arr.length - DEDUP_MAX_ENTRIES)
    : arr;
  const dir = join(dedupPath, '..');
  mkdirSync(dir, { recursive: true });
  atomicWriteFile(dedupPath, JSON.stringify(trimmed));
}

// ---------------------------------------------------------------------------
// HMAC verification
// ---------------------------------------------------------------------------

/**
 * Verify a GitHub `X-Hub-Signature-256` header against the raw body bytes.
 * Uses `timingSafeEqual` to prevent timing-oracle attacks.
 */
export function verifySignature(
  secret: string,
  rawBody: Buffer,
  signatureHeader: string | undefined,
): boolean {
  if (!signatureHeader) return false;
  const prefix = 'sha256=';
  if (!signatureHeader.startsWith(prefix)) return false;
  const received = signatureHeader.slice(prefix.length);
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  // Both must be the same length for timingSafeEqual; pad/truncate is not
  // needed because hex digests of the same algo are always 64 chars.
  if (received.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(received, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    // Buffer.from('hex') can throw on non-hex chars — treat as invalid.
    return false;
  }
}

// ---------------------------------------------------------------------------
// Request body reading
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        settled = true;
        req.destroy();
        reject(new Error('request body exceeds 1 MB limit'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!settled) resolve(Buffer.concat(chunks)); });
    req.on('error', (err) => { if (!settled) { settled = true; reject(err); } });
  });
}

// ---------------------------------------------------------------------------
// Payload summariser — extracts a human-readable summary from the raw payload
// ---------------------------------------------------------------------------

interface GithubPayload {
  action?: string;
  repository?: { full_name?: string };
  comment?: { body?: string; html_url?: string };
  check_run?: { name?: string; conclusion?: string; html_url?: string };
  issue?: { number?: number; title?: string; html_url?: string };
}

/**
 * Extract a brief, safe summary from the decoded payload. Never throws —
 * returns a fallback string on any parse failure.
 */
export function summarisePayload(rawBody: Buffer, eventName: string): string {
  try {
    const payload = JSON.parse(rawBody.toString('utf-8')) as GithubPayload;
    const repo = payload.repository?.full_name ?? 'unknown/repo';
    const action = payload.action ?? '';

    switch (eventName) {
      case 'pull_request_review_comment': {
        const url = payload.comment?.html_url ?? '';
        const body = (payload.comment?.body ?? '').slice(0, 500);
        return [`type: pr_comment`, `repo: ${repo}`, `action: ${action}`, `url: ${url}`, `body: ${body}`].join('\n');
      }
      case 'check_run': {
        const name = payload.check_run?.name ?? '';
        const conclusion = payload.check_run?.conclusion ?? '';
        const url = payload.check_run?.html_url ?? '';
        return [`type: check_run`, `repo: ${repo}`, `action: ${action}`, `name: ${name}`, `conclusion: ${conclusion}`, `url: ${url}`].join('\n');
      }
      case 'issues': {
        const num = payload.issue?.number ?? '';
        const title = payload.issue?.title ?? '';
        const url = payload.issue?.html_url ?? '';
        return [`type: issues`, `repo: ${repo}`, `action: ${action}`, `number: #${num}`, `title: ${title}`, `url: ${url}`].join('\n');
      }
      default:
        return [`type: ${eventName}`, `repo: ${repo}`, `action: ${action}`].join('\n');
    }
  } catch {
    return `type: ${eventName} (payload parse error)`;
  }
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

function sendResponse(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}

// ---------------------------------------------------------------------------
// WebhookReceiver class
// ---------------------------------------------------------------------------

export class WebhookReceiver {
  private readonly secret: string;
  private readonly commandTemplate: string;
  private readonly port: number;
  private readonly host: string;
  private readonly queueDir: string | undefined;
  private readonly dedupPath: string;
  private readonly seen: Set<string>;
  private server: Server | null = null;

  constructor(opts: WebhookReceiverOptions) {
    const host = opts.host ?? DEFAULT_WEBHOOK_HOST;
    const allowExternal = opts.allowExternal ?? false;

    // Refuse non-loopback binding unless the operator explicitly allows it.
    const isLoopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';
    if (!isLoopback && !allowExternal) {
      throw new Error(
        `WebhookReceiver: refusing to bind on non-loopback address "${host}" ` +
        `without allowExternal:true (or AFK_EVENTS_WEBHOOK_ALLOW_EXTERNAL=1). ` +
        `Exposing the webhook endpoint to the network without a reverse proxy is ` +
        `a security risk.`,
      );
    }

    if (!opts.secret) {
      throw new Error('WebhookReceiver: secret must be a non-empty string');
    }

    this.secret = opts.secret;
    this.commandTemplate = opts.commandTemplate;
    this.port = opts.port ?? DEFAULT_WEBHOOK_PORT;
    this.host = host;
    this.queueDir = opts.queueDir;
    this.dedupPath = getDedupPath(opts.stateDir);
    this.seen = loadSeenSet(this.dedupPath);
  }

  /**
   * Start listening. Returns a Promise that resolves once the server is bound.
   */
  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const srv = createServer((req, res) => {
        void this.handleRequest(req, res);
      });
      srv.on('error', reject);
      srv.listen(this.port, this.host, () => {
        this.server = srv;
        resolve();
      });
    });
  }

  /** Actual bound address (port may differ from requested when port=0). */
  address(): { host: string; port: number } | null {
    if (!this.server) return null;
    const addr = this.server.address();
    if (!addr || typeof addr === 'string') return null;
    return { host: addr.address, port: addr.port };
  }

  /** Stop the server. */
  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) { resolve(); return; }
      this.server.close((err) => (err ? reject(err) : resolve()));
      this.server = null;
    });
  }

  // -------------------------------------------------------------------------
  // Request handler (exposed for testing without a real network)
  // -------------------------------------------------------------------------

  /** Handle a single HTTP request. Exported for unit-test injection. */
  async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      // Only accept POST to /webhook
      if (req.method !== 'POST' || req.url !== '/webhook') {
        sendResponse(res, 404, 'Not found. POST to /webhook');
        return;
      }

      // Pre-auth gate: reject requests that are obviously unauthenticated
      // (missing or malformed signature header) before buffering any body.
      // This prevents unauthenticated callers from exhausting memory via the
      // 1 MB readBody buffer, especially when allowExternal:true is set.
      // Note: this only checks header presence/prefix — full HMAC verification
      // still requires the body and happens below.
      const sigHeaderEarly = req.headers['x-hub-signature-256'] as string | undefined;
      if (!sigHeaderEarly || !sigHeaderEarly.startsWith('sha256=')) {
        sendResponse(res, 401, 'Invalid or missing X-Hub-Signature-256');
        return;
      }

      // Read body — now gated behind the pre-auth header check.
      let rawBody: Buffer;
      try {
        rawBody = await readBody(req);
      } catch (err) {
        sendResponse(res, 413, `Request body error: ${errorMessage(err)}`);
        return;
      }

      // Full HMAC verification — constant-time comparison against the raw body.
      if (!verifySignature(this.secret, rawBody, sigHeaderEarly)) {
        sendResponse(res, 401, 'Invalid or missing X-Hub-Signature-256');
        return;
      }

      const githubEvent = req.headers['x-github-event'] as string | undefined;
      const deliveryId = req.headers['x-github-delivery'] as string | undefined;

      if (!githubEvent || !deliveryId) {
        sendResponse(res, 400, 'Missing X-GitHub-Event or X-GitHub-Delivery header');
        return;
      }

      // Dedup: reject replayed deliveries (same X-GitHub-Delivery GUID).
      if (this.seen.has(deliveryId)) {
        sendResponse(res, 200, `Already processed: ${deliveryId}`);
        return;
      }

      // Parse payload once for action/conclusion inspection and repo extraction.
      let payload: GithubPayload = {};
      try {
        payload = JSON.parse(rawBody.toString('utf-8')) as GithubPayload;
      } catch {
        // Non-JSON payloads: we can still record the delivery but cannot map.
      }

      // Map GitHub event + action/conclusion → internal type.
      // Unknown or non-actionable combinations are silently dropped.
      const eventType = resolveEventType(githubEvent, payload);
      if (eventType === undefined) {
        // Record the delivery as seen so retries don't re-evaluate.
        this.seen.add(deliveryId);
        persistSeenSet(this.dedupPath, this.seen);
        sendResponse(res, 200, `Ignored: unsupported event ${githubEvent}/${payload.action ?? 'unknown'}`);
        return;
      }

      const repo = payload.repository?.full_name ?? 'unknown/repo';
      const eventId = `webhook:${githubEvent}:${deliveryId}`;
      const summary = summarisePayload(rawBody, githubEvent);

      const command = renderCommand(
        this.commandTemplate,
        eventType,
        repo,
        eventId,
        summary,
      );

      enqueue(command, {}, this.queueDir);

      // Record delivery as processed after successful enqueue.
      this.seen.add(deliveryId);
      persistSeenSet(this.dedupPath, this.seen);

      // eslint-disable-next-line no-console
      console.log(`[github-webhook-receiver] enqueued task for ${githubEvent} delivery ${deliveryId}`);

      sendResponse(res, 200, `Accepted: ${eventId}`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[github-webhook-receiver] handler error: ${errorMessage(err)}`);
      sendResponse(res, 500, 'Internal error');
    }
  }
}
