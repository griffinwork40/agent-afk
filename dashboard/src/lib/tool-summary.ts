type Input = Record<string, unknown>;
type Summarizer = (input: Input, cwd?: string) => string;
const text = (input: Input, key: string) => typeof input[key] === 'string' ? input[key] as string : '';
const field = (key: string): Summarizer => input => text(input, key);
const host: Summarizer = input => {
  const url = text(input, 'url');
  try { return new URL(url).host; } catch { return url || text(input, 'query'); }
};

/** Format grep/glob summary as `grep "PATTERN" in <relDir>` when a search path is available. */
function grepSummary(input: Input, cwd?: string): string {
  const pattern = text(input, 'pattern');
  if (!pattern) return ''; // fall through to raw ledger preview
  const searchPath = text(input, 'path') || text(input, 'include');
  let dir = searchPath;
  if (dir && cwd) {
    const root = cwd.replace(/[\\/]+$/, '').replaceAll('\\', '/');
    const norm = dir.replaceAll('\\', '/');
    if (norm.startsWith(`${root}/`)) dir = norm.slice(root.length + 1);
    else if (norm === root) dir = '.';
  }
  return dir ? `grep "${pattern}" in ${dir}` : `grep "${pattern}"`;
}

/** Format glob summary as `glob "PATTERN"` */
function globSummary(input: Input): string {
  const pattern = text(input, 'pattern');
  return pattern ? `glob "${pattern}"` : '';
}

/** One registry for both the compact spine and standalone tool cards. */
const summaries: Record<string, Summarizer> = {
  read_file: field('file_path'), edit_file: field('file_path'), write_file: field('file_path'),
  list_directory: field('path'), extract_document: field('file_path'),
  bash: field('command'), grep: grepSummary, glob: globSummary,
  web_scrape: host, web_request: host, browser_open: host,
  agent: field('prompt'), remote_agent: field('prompt'), skill: field('name'),
};
const pathTools = new Set(['read_file', 'edit_file', 'write_file', 'list_directory', 'extract_document']);

/** Accept structured inputs and legacy ledger previews; never discard an unknown preview. */
export function toolSummary(name: string, preview: string, cwd?: string): string {
  let summary = preview.trim();
  try {
    const input: unknown = JSON.parse(summary);
    if (input && typeof input === 'object' && !Array.isArray(input)) {
      summary = summaries[name]?.(input as Input, cwd) || summary;
    }
  } catch { /* Ledger previews are normally already formatted, not JSON. */ }
  if (pathTools.has(name) && cwd) {
    const root = cwd.replace(/[\\/]+$/, '').replaceAll('\\', '/');
    const p = summary.replaceAll('\\', '/');
    if (p.startsWith(`${root}/`)) summary = p.slice(root.length + 1);
  }
  if ((name === 'grep' || name === 'glob') && cwd) {
    // Ledger previews arrive formatted (`"PATTERN" in /abs/dir`); show the dir repo-relative.
    const root = cwd.replace(/[\\/]+$/, '').replaceAll('\\', '/');
    summary = summary.replaceAll('\\', '/').replace(` in ${root}/`, ' in ').replace(new RegExp(` in ${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), ' in .');
    if (name === 'grep' && summary.startsWith('"')) summary = `grep ${summary}`;
    if (name === 'glob' && summary.startsWith('"')) summary = `glob ${summary}`;
  }
  if (['web_scrape', 'web_request', 'browser_open'].includes(name)) {
    try { summary = new URL(summary).host; } catch { /* Search queries stay readable. */ }
  }
  return summary.split(/\r?\n/, 1)[0] ?? '';
}
