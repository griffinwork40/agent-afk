/**
 * Agent Browser connection discovery and health probing.
 *
 * Reads `~/.config/agent-browser/connection.json` to discover a running
 * Agent Browser instance. Validates the connection by checking PID liveness
 * and hitting the `/health` endpoint.
 *
 * Connection file schema (written by Agent Browser on launch):
 * ```json
 * { "url": "http://127.0.0.1:8833", "token": "<base64url>", "pid": 12345, "version": "0.3.0" }
 * ```
 *
 * @module browser/agent-browser/connection
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ---------------------------------------------------------------------------
// Connection file types
// ---------------------------------------------------------------------------

export interface AgentBrowserConnection {
  /** Base URL for the Agent Browser HTTP API (e.g. `http://127.0.0.1:8833`). */
  url: string;
  /** Bearer token for authenticating requests. */
  token: string;
  /** PID of the running Agent Browser process. */
  pid: number;
  /** Agent Browser version string. */
  version: string;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

const CONNECTION_FILE = join(homedir(), '.config', 'agent-browser', 'connection.json');

/**
 * Read the Agent Browser connection file. Returns `null` when the file does
 * not exist or cannot be parsed. Never throws.
 */
export function readConnectionFile(
  path?: string,
): AgentBrowserConnection | null {
  const filePath = path ?? CONNECTION_FILE;
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj['url'] !== 'string' ||
    typeof obj['token'] !== 'string' ||
    typeof obj['pid'] !== 'number'
  ) {
    return null;
  }

  // Validate the URL to ensure it only points to localhost. A tampered
  // connection file could otherwise redirect API traffic (including the bearer
  // token) to an attacker-controlled host.
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(obj['url']);
  } catch {
    return null;
  }
  const { hostname, protocol } = parsedUrl;
  const isLocalhost =
    hostname === '127.0.0.1' ||
    hostname === 'localhost' ||
    hostname === '::1';
  if (!isLocalhost || protocol !== 'http:') {
    throw new Error(
      `Agent Browser connection file contains an untrusted URL: ${obj['url']}. ` +
      'Only http://127.0.0.1 or http://localhost is permitted.',
    );
  }

  return {
    url: obj['url'],
    token: obj['token'],
    pid: obj['pid'],
    version: typeof obj['version'] === 'string' ? obj['version'] : 'unknown',
  };
}

// ---------------------------------------------------------------------------
// PID liveness
// ---------------------------------------------------------------------------

/**
 * Check whether a PID is alive via `kill -0`. Returns `false` for stale PIDs.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Health probe
// ---------------------------------------------------------------------------

/**
 * Probe the Agent Browser `/health` endpoint. Returns `true` when the server
 * responds with a 2xx status within `timeoutMs`. Returns `false` on network
 * errors or timeouts. Never throws.
 */
export async function probeHealth(
  baseUrl: string,
  token: string,
  timeoutMs = 2000,
): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${baseUrl}/health`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Host: '127.0.0.1:8833',
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Full availability check
// ---------------------------------------------------------------------------

export interface AvailabilityResult {
  available: boolean;
  connection: AgentBrowserConnection | null;
  /** Why the backend is unavailable. `null` when available. */
  reason: string | null;
}

/**
 * Check whether Agent Browser is available for use. Performs three checks:
 * 1. Connection file exists and is valid
 * 2. PID is alive
 * 3. Health endpoint responds
 *
 * Returns a structured result with the reason for unavailability.
 */
export async function checkAvailability(
  connectionPath?: string,
): Promise<AvailabilityResult> {
  const conn = readConnectionFile(connectionPath);
  if (conn === null) {
    return {
      available: false,
      connection: null,
      reason: 'connection file missing or invalid',
    };
  }

  if (!isPidAlive(conn.pid)) {
    return {
      available: false,
      connection: conn,
      reason: `stale connection file: PID ${conn.pid} not alive`,
    };
  }

  const healthy = await probeHealth(conn.url, conn.token);
  if (!healthy) {
    return {
      available: false,
      connection: conn,
      reason: `health probe failed at ${conn.url}`,
    };
  }

  return { available: true, connection: conn, reason: null };
}
