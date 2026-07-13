/**
 * Pure formatting utilities — no external dependencies.
 */

export function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  if (totalSec <= 0) return "0s";

  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;

  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function formatCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatToolCallStat(count: number): string {
  // Renders a subagent/turn tool-invocation tally as "N tool call(s)" — the
  // count of tool CALLS made, NOT the size of the tool allowlist. The distinct
  // wording ("tool calls", matching `afk trace show`) disambiguates from
  // `/info`'s "N tools" line, which counts AVAILABLE tool definitions. Single
  // source of truth for the four interactive stat-line renderers.
  return `${count} tool call${count === 1 ? '' : 's'}`;
}

export function formatTokens(count: number): string {
  // Defensive backstop: a non-finite count (undefined/NaN slipping through a
  // loosely-typed usage payload) must never render as "NaNm". Render "0"
  // instead. The provider fix that populates totalTokens makes this
  // unreachable in practice, but the guard keeps the failure mode dead.
  if (!Number.isFinite(count)) return "0";
  if (count < 1000) return String(count);
  if (count < 1_000_000) {
    const v = count / 1000;
    return v % 1 === 0 ? `${v}k` : `${v.toFixed(1).replace(/\.0$/, "")}k`;
  }
  const v = count / 1_000_000;
  return v % 1 === 0 ? `${v}m` : `${v.toFixed(1).replace(/\.0$/, "")}m`;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024;
    return `${kb.toFixed(1).replace(/\.0$/, "")}KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    const mb = bytes / (1024 * 1024);
    return `${mb.toFixed(1).replace(/\.0$/, "")}MB`;
  }
  const gb = bytes / (1024 * 1024 * 1024);
  return `${gb.toFixed(1).replace(/\.0$/, "")}GB`;
}
