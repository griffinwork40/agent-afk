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
// Contract: cards can come from other users/platforms, so this is deliberately
// independent of the current machine's home. Keep the basename, not the home.
//   • POSIX:   /Users/<name>/…  /home/<name>/…  /root/…  (bare or quoted)
//   • Windows: C:\Users\<name>\… or driveless \Users\<name>\… (either slash)
//   • UNC:     \\<host>\<share>\Users\<name>\… (bare or quoted)
// /root boundary: (?![a-zA-Z0-9_]) rejects /rootfs, /root2 but keeps /root/….
// Quoted paths may contain spaces. A bare path ends at whitespace or an
// error-message delimiter, except that a single space is kept inside a
// DIRECTORY name ("My Project/a.ts"): a non-space char and a separator must
// follow within 255 chars (bounded, so matching stays linear).
// Invariant: once a bare match crosses a space, no home root starts anywhere
// after it. Every char after the first crossed space lies in the word that
// directly follows some crossed space, and each crossing is refused when that
// word (up to whitespace or a delimiter) contains a HOME_ROOT start. A refused
// root is then matched and redacted on its own, so no username can become the
// kept basename.
const HOME_ROOT = /(?:\\\\[^\\/\s"'`]+[\\/][^\\/\s"'`]+[\\/](?:Users|Documents and Settings)[\\/][^\\/\s"'`]+|[A-Z]:[\\/](?:Users|Documents and Settings)[\\/][^\\/\s"'`]+|\/(?:Users|home)\/[^/\s"'`]+|\/root(?![a-zA-Z0-9_])|[\\/](?:Users|Documents and Settings)[\\/][^\\/\s"'`]+)/.source;
const SEG_CHAR = /[^\s"'`<>()[\]{},;]/.source;
const DIR_SPACE = /(?![A-Z]:[\\/])(?=[^\t\n\v\f\r"'`<>()[\]{},;\\/]{0,254}[^\s"'`<>()[\]{},;\\/][\\/])/.source;
const HOME_PATH = new RegExp(`${HOME_ROOT}(?:[\\\\/](?:${SEG_CHAR}(?:${SEG_CHAR}| ${DIR_SPACE}(?!${SEG_CHAR}*?${HOME_ROOT}))*)?)?`, 'gi');
const QUOTED_HOME_PATH = /(["'`])((?:\\\\[^\\/\s"'`]+[\\/][^\\/\s"'`]+[\\/](?:Users|Documents and Settings)[\\/]|(?:[A-Z]:)?[\\/](?:Users|Documents and Settings)[\\/]|\/(?:Users|home)\/|\/root(?![a-zA-Z0-9_])(?:[\\/]|$))[^\r\n]*?)\1/gi;

function collapsePath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const parts = trimmed.split(/[\\/]/);
  // A match that ENDS at a home root (top-level or nested, e.g. ".../x/Users/bob")
  // must not keep that root's username as the basename.
  const isHome = /(?:^|[\\/])(?:(?:Users|home|Documents and Settings)[\\/][^\\/]+|root)$/i.test(trimmed);
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
