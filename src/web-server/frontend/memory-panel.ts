/**
 * Memory viewer panel for the `afk web` SPA.
 *
 * Renders a hot-memory section (HOT.md content + usage meter) and a
 * search interface for querying cross-session facts and procedures.
 * All DOM is built with createElement — never innerHTML.
 */

/** Shape returned by `GET /api/memory/search`. */
interface MemorySearchResult {
  type: 'fact' | 'procedure';
  content: string;
  category?: string;
  created_at: string;
  source_session?: string | null;
  confidence?: number;
}

/** Shape returned by `GET /api/memory/hot`. */
interface HotUsage {
  chars: number;
  tokens: number;
  maxTokens: number;
  pct: number;
  truncated: boolean;
}

interface HotResponse {
  content: string | null;
  usage: HotUsage;
}

interface SearchResponse {
  results: MemorySearchResult[];
}

export interface MemoryPanelOpts {
  api: (path: string, init?: RequestInit) => Promise<unknown>;
}

// ── DOM helpers ──────────────────────────────────────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function relativeDate(iso: string): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(Math.abs(ms) / 1000);
  if (sec < 60) return 'just now';
  const mins = Math.floor(sec / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ── Hot memory section ────────────────────────────────────────────────────────

function buildHotSection(): { root: HTMLElement; update: (r: HotResponse) => void } {
  const root = el('div', 'mem-hot');

  const header = el('div', 'mem-hot-header');
  const title = el('span', 'mem-hot-title', 'Hot Memory');
  const meta = el('div', 'mem-hot-meta');
  const pctSpan = el('span', 'mem-hot-pct', '');
  const truncBadge = el('span', 'mem-hot-truncated', 'truncated');
  truncBadge.style.display = 'none';
  meta.appendChild(pctSpan);
  meta.appendChild(truncBadge);
  header.appendChild(title);
  header.appendChild(meta);

  const barWrap = el('div', 'mem-usage-bar');
  const fill = el('div', 'mem-usage-fill');
  barWrap.appendChild(fill);

  const pre = el('pre', 'mem-hot-pre');
  const emptyMsg = el('p', 'mem-hot-empty', 'No hot memory — HOT.md is empty or not yet created.');

  root.appendChild(header);
  root.appendChild(barWrap);
  root.appendChild(pre);
  root.appendChild(emptyMsg);

  function update(r: HotResponse): void {
    const { content, usage } = r;
    pctSpan.textContent = `${usage.pct}% of ~${usage.maxTokens} token cap`;
    truncBadge.style.display = usage.truncated ? '' : 'none';

    // Usage bar colour thresholds.
    fill.style.width = `${usage.pct}%`;
    fill.className = 'mem-usage-fill';
    if (usage.pct >= 100) fill.classList.add('is-full');
    else if (usage.pct >= 80) fill.classList.add('is-warn');

    if (content) {
      pre.textContent = content;
      pre.style.display = '';
      emptyMsg.style.display = 'none';
    } else {
      pre.style.display = 'none';
      emptyMsg.style.display = '';
    }
  }

  return { root, update };
}

// ── Result card ───────────────────────────────────────────────────────────────

function buildResultCard(r: MemorySearchResult): HTMLElement {
  const card = el('div', 'mem-card');

  const top = el('div', 'mem-card-top');

  // Type badge
  const typeBadge = el('span', `mem-badge-type mem-badge-${r.type}`, r.type);
  top.appendChild(typeBadge);

  // Category badge (facts only)
  if (r.category) {
    const catBadge = el('span', `mem-badge-cat mem-badge-${r.category}`, r.category);
    top.appendChild(catBadge);
  }

  // Date
  const dateEl = el('span', 'mem-card-date', relativeDate(r.created_at));
  dateEl.title = r.created_at;
  top.appendChild(dateEl);

  card.appendChild(top);

  // Content preview (first 200 chars)
  const preview = r.content.length > 200 ? `${r.content.slice(0, 200)}…` : r.content;
  const content = el('p', 'mem-card-content', preview);
  card.appendChild(content);

  return card;
}

// ── Search section ────────────────────────────────────────────────────────────

interface SearchSection {
  root: HTMLElement;
  resultsArea: HTMLElement;
}

const CATEGORIES = ['', 'preference', 'convention', 'decision', 'learning'] as const;

function buildSearchSection(
  api: (path: string, init?: RequestInit) => Promise<unknown>,
): SearchSection {
  const root = el('div');

  // Search bar row
  const row = el('div', 'mem-search-row');

  const input = el('input', 'mem-search-input') as HTMLInputElement;
  input.type = 'text';
  input.placeholder = 'Search your cross-session memory…';
  input.setAttribute('autocomplete', 'off');

  const catSelect = el('select', 'mem-cat-select') as HTMLSelectElement;
  for (const cat of CATEGORIES) {
    const opt = el('option');
    (opt as HTMLOptionElement).value = cat;
    opt.textContent = cat === '' ? 'All categories' : cat;
    catSelect.appendChild(opt);
  }

  const btn = el('button', 'mem-search-btn', 'Search');

  row.appendChild(input);
  row.appendChild(catSelect);
  row.appendChild(btn);
  root.appendChild(row);

  // Results area
  const resultsArea = el('div', 'mem-results');
  renderEmpty(resultsArea);
  root.appendChild(resultsArea);

  // Wire search
  async function doSearch(): Promise<void> {
    const q = input.value.trim();
    if (!q) return;
    btn.setAttribute('disabled', '');
    renderLoading(resultsArea);

    const params = new URLSearchParams({ q });
    const cat = catSelect.value;
    if (cat) params.set('category', cat);

    try {
      const data = (await api(`/api/memory/search?${params.toString()}`)) as SearchResponse;
      renderResults(resultsArea, data.results);
    } catch (err) {
      renderError(resultsArea, err instanceof Error ? err.message : 'Search failed');
    } finally {
      btn.removeAttribute('disabled');
    }
  }

  btn.addEventListener('click', () => void doSearch());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void doSearch();
  });

  return { root, resultsArea };
}

// ── Results rendering helpers ─────────────────────────────────────────────────

function renderEmpty(area: HTMLElement): void {
  area.textContent = '';
  const wrap = el('div', 'mem-empty');
  wrap.appendChild(el('div', 'mem-empty-icon', '🧠'));
  wrap.appendChild(el('div', 'mem-empty-title', 'Search your cross-session memory'));
  wrap.appendChild(el('div', 'mem-empty-sub', 'Type a query above to find facts and procedures.'));
  area.appendChild(wrap);
}

function renderLoading(area: HTMLElement): void {
  area.textContent = '';
  area.appendChild(el('div', 'mem-loading', 'Searching…'));
}

function renderError(area: HTMLElement, message: string): void {
  area.textContent = '';
  area.appendChild(el('div', 'mem-error', `Error: ${message}`));
}

function renderResults(area: HTMLElement, results: MemorySearchResult[]): void {
  area.textContent = '';
  if (results.length === 0) {
    const wrap = el('div', 'mem-empty');
    wrap.appendChild(el('div', 'mem-empty-icon', '🔍'));
    wrap.appendChild(el('div', 'mem-empty-title', 'No results found'));
    wrap.appendChild(el('div', 'mem-empty-sub', 'Try a different query or category.'));
    area.appendChild(wrap);
    return;
  }
  for (const r of results) {
    area.appendChild(buildResultCard(r));
  }
}

// ── Public factory ────────────────────────────────────────────────────────────

/**
 * Build and return the memory panel element.
 * Fetches hot memory on mount; search is triggered by user action.
 */
export function createMemoryPanel(opts: MemoryPanelOpts): HTMLElement {
  const { api } = opts;

  const panel = el('div', 'mem-panel');

  const inner = el('div', 'mem-inner');
  inner.appendChild(el('h2', 'mem-title', 'Memory'));

  // Hot memory section
  const { root: hotRoot, update: updateHot } = buildHotSection();
  inner.appendChild(hotRoot);

  // Search section
  const { root: searchRoot } = buildSearchSection(api);
  inner.appendChild(searchRoot);

  panel.appendChild(inner);

  // Fetch hot memory immediately on construction — this fires once.
  // The panel is constructed lazily (first nav to the memory view), so
  // timing is equivalent to a mount callback in a component framework.
  void (async () => {
    try {
      const data = (await api('/api/memory/hot')) as HotResponse;
      updateHot(data);
    } catch {
      // Non-fatal: hot section remains in loading state but search still works.
    }
  })();

  return panel;
}
