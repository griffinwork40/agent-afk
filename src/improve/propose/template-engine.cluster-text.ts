/** Safe, bounded error-cluster text at the proposal rendering boundary. */
import { redactSecrets } from '../../agent/redact-secrets.js';
import type { FailureCard } from '../schemas.js';

interface DisplayCluster {
  normalized: string;
  count: number;
  sample: string;
}

const MAX_CLUSTERS = 5;
const MAX_TEXT_LENGTH = 200;
// Deliberately independent of the current machine's home: cards can come from
// other users/platforms. Quoted paths may contain spaces; bare paths end at
// whitespace or an error-message delimiter. Keep the basename, not the home.
const HOME_PATH = /(?:[A-Z]:[\\/](?:Users|Documents and Settings)[\\/][^\\/\s"'`]+|\/(?:Users|home)\/[^/\s"'`]+|\/root)(?:[\\/][^\s"'`<>()[\]{},;]*)?/gi;
const QUOTED_HOME_PATH = /(["'`])((?:[A-Z]:[\\/](?:Users|Documents and Settings)[\\/]|\/(?:Users|home)\/|\/root(?:[\\/]|$))[^\r\n]*?)\1/gi;

function collapsePath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const parts = trimmed.split(/[\\/]/);
  // A home directory alone must not preserve the user's name as the basename.
  const isHome = /^(?:[A-Z]:[\\/](?:Users|Documents and Settings)[\\/][^\\/]+|\/(?:Users|home)\/[^/]+|\/root)$/i.test(trimmed);
  return isHome ? '<home>' : `<home>/…/${parts.at(-1) ?? ''}`;
}

function safeClusterText(raw: string): string {
  // Redact the complete string BEFORE truncating so a boundary cannot leave a
  // secret fragment. The canonical redactor intentionally preserves paths.
  const flat = redactSecrets(raw)
    .replace(QUOTED_HOME_PATH, (_match, _quote: string, path: string) => collapsePath(path))
    .replace(HOME_PATH, collapsePath)
    .replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, ' ')
    .replace(/[`"']/g, '’')
    .trim();
  return flat.length > MAX_TEXT_LENGTH ? `${flat.slice(0, MAX_TEXT_LENGTH - 1)}…` : flat;
}

/** Plain inline Markdown, not executable markup (samples use code spans). */
export function clusterMarkdown(text: string): string {
  return text.replace(/[&<>\\*_\[\]!|#]/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** Invalid/missing/empty arrays retain the original no-clusters fallback. */
export function extractDisplayClusters(card: FailureCard): DisplayCluster[] {
  const raw = card.detail['errorClusters'];
  if (!Array.isArray(raw)) return [];
  const result: DisplayCluster[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue;
    const c = entry as Record<string, unknown>;
    if (typeof c['normalized'] !== 'string' || typeof c['sample'] !== 'string' ||
        typeof c['count'] !== 'number' || !Number.isFinite(c['count'])) continue;
    result.push({ normalized: safeClusterText(c['normalized']), count: c['count'], sample: safeClusterText(c['sample']) });
    if (result.length === MAX_CLUSTERS) break;
  }
  return result;
}

export function renderClusterSection(clusters: DisplayCluster[], failureCount: number): string[] {
  if (clusters.length === 0) return [];
  const lines = ['## Error clusters (normalized error heads, descending by count)', ''];
  for (const c of clusters) {
    const pct = failureCount > 0 ? ` (${((c.count / failureCount) * 100).toFixed(0)}%)` : '';
    lines.push(`- **${clusterMarkdown(c.normalized)}** — ${c.count}${pct} failures · sample: \`${c.sample}\``);
  }
  lines.push('', 'Use the dominant cluster above to pick the most likely root cause in the candidate fixes below.', '');
  return lines;
}
