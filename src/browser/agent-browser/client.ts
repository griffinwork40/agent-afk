/**
 * HTTP client for the Agent Browser local API.
 *
 * Wraps the JSON-RPC-style `POST /agent` endpoint that Agent Browser exposes
 * on `127.0.0.1:8833`. Each method maps to one protocol method (e.g.
 * `tabs.open`, `page.click`). The client handles auth headers, timeouts,
 * and error normalization.
 *
 * Transport: direct HTTP to the local Agent Browser process. This is NOT the
 * MCP stdio adapter -- we speak the native protocol directly for lower latency
 * and simpler lifecycle (no subprocess to manage).
 *
 * @module browser/agent-browser/client
 */

import type { AgentBrowserConnection } from './connection.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentRequest {
  version: 1;
  method: string;
  params: Record<string, unknown> | null;
}

export interface AgentBrowserTab {
  id: string;
  title: string;
  url: string;
  /** v0.3.0 returns `isLoading`, not `loading`. */
  isLoading: boolean;
  isActive?: boolean;
}

export interface InspectElement {
  id: string;
  tag: string;
  role: string;
  label: string;
  kind: string | null;
  value: string | null;
  placeholder: string | null;
  disabled: boolean;
  checked?: boolean;
  selected?: boolean;
  expanded?: boolean;
  bbox: { x: number; y: number; w: number; h: number };
  selector?: string;
}

export interface ReadResult {
  content: string;
  url: string;
  title: string;
  wordCount: number;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class AgentBrowserClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(connection: AgentBrowserConnection) {
    this.baseUrl = connection.url;
    this.token = connection.token;
  }

  // -------------------------------------------------------------------------
  // Core transport
  // -------------------------------------------------------------------------

  private async call<T = unknown>(
    method: string,
    params: Record<string, unknown> | null,
    timeoutMs = 30_000,
  ): Promise<T> {
    const body: AgentRequest = { version: 1, method, params };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(`${this.baseUrl}/agent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
          Host: new URL(this.baseUrl).host,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(
          `Agent Browser ${method} failed (HTTP ${res.status}): ${text}`,
        );
      }

      // v0.3.0 wraps every response in { ok, result, error }. Unwrap the
      // envelope so callers receive the payload directly.
      const envelope = (await res.json()) as Record<string, unknown>;
      if (envelope['ok'] === false) {
        const err = envelope['error'] as Record<string, unknown> | undefined;
        const code = err?.['code'] ?? 'UNKNOWN';
        const msg = err?.['message'] ?? JSON.stringify(envelope);
        throw new Error(
          `Agent Browser ${method} failed: [${String(code)}] ${String(msg)}`,
        );
      }
      return (envelope['result'] ?? envelope) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  // -------------------------------------------------------------------------
  // Tab management
  // -------------------------------------------------------------------------

  async listTabs(): Promise<AgentBrowserTab[]> {
    // v0.3.0 returns the array directly, not wrapped in { tabs }.
    return this.call<AgentBrowserTab[]>('tabs.list', null);
  }

  async openTab(url: string): Promise<{ tabId: string }> {
    // v0.3.0 returns { id } not { tab_id }.
    const result = await this.call<{ id: string }>(
      'tabs.open',
      { url },
      60_000,
    );
    return { tabId: result.id };
  }

  async closeTab(tabId: string): Promise<void> {
    // v0.3.0 does not support tabs.close -- best-effort via navigation.
    await this.call('page.eval', { id: tabId, script: 'window.close()' }).catch(() => {});
  }

  // -------------------------------------------------------------------------
  // Page reading
  // -------------------------------------------------------------------------

  async read(
    tabId: string,
    opts?: { mode?: string; query?: string; budget?: number },
  ): Promise<ReadResult> {
    return this.call<ReadResult>('page.read', {
      id: tabId,
      mode: opts?.mode ?? 'main',
      ...(opts?.query ? { query: opts.query } : {}),
      ...(opts?.budget ? { budget: opts.budget } : {}),
    });
  }

  async inspect(
    tabId: string,
    opts?: { mode?: string; query?: string; limit?: number },
  ): Promise<{ elements: InspectElement[] }> {
    return this.call<{ elements: InspectElement[] }>('page.inspect', {
      id: tabId,
      mode: opts?.mode ?? 'interactive',
      ...(opts?.query ? { query: opts.query } : {}),
      ...(opts?.limit ? { limit: opts.limit } : {}),
    });
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  async click(tabId: string, elementId: string): Promise<void> {
    await this.call('page.click', { id: tabId, elementId });
  }

  async fill(
    tabId: string,
    elementId: string,
    value: string,
  ): Promise<void> {
    await this.call('page.fill', {
      id: tabId,
      elementId,
      value,
    });
  }

  async press(
    tabId: string,
    key: string,
    elementId?: string,
  ): Promise<void> {
    await this.call('page.press', {
      id: tabId,
      key,
      ...(elementId ? { elementId } : {}),
    });
  }

  async select(
    tabId: string,
    elementId: string,
    value: string,
  ): Promise<void> {
    await this.call('page.select', {
      id: tabId,
      elementId,
      value,
    });
  }

  async waitFor(
    tabId: string,
    condition: string,
    opts?: { value?: string; timeout?: number },
  ): Promise<void> {
    await this.call(
      'page.wait',
      {
        id: tabId,
        condition,
        ...(opts?.value ? { value: opts.value } : {}),
        ...(opts?.timeout ? { timeout: opts.timeout } : {}),
      },
      (opts?.timeout ?? 30_000) + 5_000,
    );
  }

  // -------------------------------------------------------------------------
  // Eval & screenshot
  // -------------------------------------------------------------------------

  async evalScript(tabId: string, script: string): Promise<unknown> {
    return this.call<unknown>('page.eval', { id: tabId, script });
  }

  async screenshot(tabId: string): Promise<{ data: string }> {
    return this.call<{ data: string }>('page.screenshot', {
      id: tabId,
    });
  }
}
