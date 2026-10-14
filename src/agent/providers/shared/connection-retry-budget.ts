import { env } from '../../../config/env.js';
import { connectionLoopLag } from './connection-loop-lag.js';

export const CONNECT_WAIT_CAP_MS = 8_000;

/** Invalid or unset values preserve the legacy count policy. */
export function connectRetryBudgetMs(): number | undefined {
  const raw = env.AFK_CONNECT_RETRY_BUDGET_MS;
  if (!raw?.trim()) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Per stream opener; never shared between requests. */
export class ConnectionRetryBudget {
  readonly startedAt = Date.now();
  readonly budgetMs = connectRetryBudgetMs();
  elapsedMs(): number { return Math.max(0, Date.now() - this.startedAt); }
  canRetry(attempt: number, legacyMax: number): boolean {
    return this.budgetMs === undefined ? attempt < legacyMax : this.elapsedMs() < this.budgetMs;
  }
  delay(legacyDelay: number, baseMs: number, attempt: number): number {
    if (this.budgetMs === undefined) return legacyDelay;
    // Eight seconds bounds scheduling latency during recovery; equal jitter avoids retry herds.
    const capped = Math.min(CONNECT_WAIT_CAP_MS, baseMs * 2 ** Math.min(attempt, 30));
    return Math.min(capped * (0.5 + Math.random() * 0.5), Math.max(0, this.budgetMs - this.elapsedMs()));
  }
}

/** Only hostname and transport codes are recorded, never URLs, credentials or messages. */
export function connectionFailureMetadata(error: unknown, budget: ConnectionRetryBudget, endpoint?: string): Record<string, string | number | boolean> {
  const metadata: Record<string, string | number | boolean> = {
    elapsedMs: budget.elapsedMs(), budgetMs: budget.budgetMs ?? 0, ...connectionLoopLag(),
  };
  if (endpoint) {
    try { metadata['host'] = new URL(endpoint).hostname; } catch { /* malformed endpoint */ }
  }
  let current = error;
  for (let depth = 0; depth < 8 && current && typeof current === 'object'; depth++) {
    const node = current as { code?: unknown; cause?: unknown; hostname?: unknown; host?: unknown; address?: unknown; url?: unknown };
    if (typeof node.code === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(node.code)) {
      metadata['errorCode'] ??= node.code;
    }
    for (const value of [node.url, node.hostname, node.host]) {
      if (typeof value !== 'string') continue;
      try {
        const host = new URL(value.includes('://') ? value : `https://${value}`).hostname;
        if (host) metadata['host'] ??= host;
      } catch { /* no hostname available */ }
    }
    if (node.cause === current) break;
    current = node.cause;
  }
  metadata['errorCode'] ??= 'unknown';
  metadata['host'] ??= 'unknown';
  return metadata;
}
