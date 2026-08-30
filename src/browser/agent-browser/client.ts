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
  loading: boolean;
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

      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  // -------------------------------------------------------------------------
  // Tab management
  // -------------------------------------------------------------------------

  async listTabs(): Promise<AgentBrowserTab[]> {
    const result = await this.call<{ tabs: AgentBrowserTab[] }>(
      'tabs.list',
      null,
    );
    return result.tabs;
  }

  async openTab(url: string): Promise<{ tabId: string }> {
    const result = await this.call<{ tab_id: string }>(
      'tabs.open',
      { url },
      60_000,
    );
    return { tabId: result.tab_id };
  }

  async closeTab(tabId: string): Promise<void> {
    await this.call('tabs.close', { tab_id: tabId });
  }

  // -------------------------------------------------------------------------
  // Page reading
  // -------------------------------------------------------------------------

  async read(
    tabId: string,
    opts?: { mode?: string; query?: string; budget?: number },
  ): Promise<ReadResult> {
    return this.call<ReadResult>('page.read', {
      tab_id: tabId,
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
      tab_id: tabId,
      mode: opts?.mode ?? 'interactive',
      ...(opts?.query ? { query: opts.query } : {}),
      ...(opts?.limit ? { limit: opts.limit } : {}),
    });
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  async click(tabId: string, elementId: string): Promise<void> {
    await this.call('page.click', { tab_id: tabId, element_id: elementId });
  }

  async fill(
    tabId: string,
    elementId: string,
    value: string,
  ): Promise<void> {
    await this.call('page.fill', {
      tab_id: tabId,
      element_id: elementId,
      value,
    });
  }

  async press(
    tabId: string,
    key: string,
    elementId?: string,
  ): Promise<void> {
    await this.call('page.press', {
      tab_id: tabId,
      key,
      ...(elementId ? { element_id: elementId } : {}),
    });
  }

  async select(
    tabId: string,
    elementId: string,
    value: string,
  ): Promise<void> {
    await this.call('page.select', {
      tab_id: tabId,
      element_id: elementId,
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
        tab_id: tabId,
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
    return this.call<unknown>('page.eval', { tab_id: tabId, script });
  }

  async screenshot(tabId: string): Promise<{ data: string }> {
    return this.call<{ data: string }>('page.screenshot', {
      tab_id: tabId,
    });
  }
}
