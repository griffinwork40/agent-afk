import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { MemorySearchResult, HotMemoryResponse } from '@/types/api';

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const CATEGORY_LABELS: Record<string, string> = {
  preference: 'Preference',
  convention: 'Convention',
  decision: 'Decision',
  learning: 'Learning',
};

function TypeBadge({ type }: { type: 'fact' | 'procedure' }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium',
        type === 'fact'
          ? 'bg-blue-500/15 text-blue-400'
          : 'bg-violet-500/15 text-violet-400',
      )}
    >
      {type}
    </span>
  );
}

function CategoryBadge({ category }: { category?: string }) {
  if (!category) return null;
  return (
    <span className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium bg-zinc-700 text-zinc-300">
      {CATEGORY_LABELS[category] ?? category}
    </span>
  );
}

function ResultCard({ result }: { result: MemorySearchResult }) {
  const preview =
    result.content.length > 200
      ? result.content.slice(0, 200) + '…'
      : result.content;

  const date = result.created_at
    ? new Date(result.created_at).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : null;

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-3 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <TypeBadge type={result.type} />
        <CategoryBadge category={result.category} />
        {date && <span className="text-xs text-zinc-500 ml-auto">{date}</span>}
      </div>
      <p className="text-sm text-zinc-300 leading-relaxed whitespace-pre-wrap break-words">
        {preview}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hot Memory section
// ---------------------------------------------------------------------------

function UsageBar({ pct, truncated }: { pct: number; truncated: boolean }) {
  const clamped = Math.min(pct, 100);
  const fillClass =
    pct >= 100
      ? 'bg-red-500'
      : pct >= 80
        ? 'bg-amber-400'
        : 'bg-accent';

  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-2 rounded-full bg-zinc-800 overflow-hidden">
        <div
          className={cn('h-full rounded-full transition-all', fillClass)}
          style={{ width: `${clamped}%` }}
        />
      </div>
      {truncated && (
        <span className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium bg-amber-400/15 text-amber-400">
          Truncated
        </span>
      )}
    </div>
  );
}

function HotSection({ hot }: { hot: HotMemoryResponse | null }) {
  if (!hot) return null;
  const { content, usage } = hot;

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-zinc-200">HOT Memory</h3>
        <span className="text-xs text-zinc-500">
          {usage.tokens.toLocaleString()} / {usage.maxTokens.toLocaleString()} tokens
        </span>
      </div>
      <UsageBar pct={usage.pct} truncated={usage.truncated} />
      {content ? (
        <pre className="rounded-md border border-zinc-800 bg-zinc-950 p-3 text-xs text-zinc-300 font-mono overflow-x-auto whitespace-pre-wrap max-h-48">
          {content}
        </pre>
      ) : (
        <p className="text-xs text-zinc-500 italic">No hot memory loaded.</p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Search section
// ---------------------------------------------------------------------------

const CATEGORIES = [
  { value: '', label: 'All Categories' },
  { value: 'preference', label: 'Preference' },
  { value: 'convention', label: 'Convention' },
  { value: 'decision', label: 'Decision' },
  { value: 'learning', label: 'Learning' },
];

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function MemoryView() {
  const [hot, setHot] = useState<HotMemoryResponse | null>(null);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [results, setResults] = useState<MemorySearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch hot memory on mount
  useEffect(() => {
    apiFetch<HotMemoryResponse>('/api/memory/hot')
      .then(setHot)
      .catch(() => {/* non-fatal */});
  }, []);

  const handleSearch = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setSearching(true);
      setError(null);
      try {
        const params = new URLSearchParams({ q: query, limit: '20' });
        if (category) params.set('category', category);
        const res = await apiFetch<{ results: MemorySearchResult[] }>(
          `/api/memory/search?${params.toString()}`,
        );
        setResults(res.results);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Search failed');
      } finally {
        setSearching(false);
      }
    },
    [query, category],
  );

  return (
    <div className="flex flex-col gap-6 p-4">
      <HotSection hot={hot} />

      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-zinc-200">Search Memory</h3>

        <form onSubmit={handleSearch} className="flex gap-2 flex-wrap">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="FTS5 query…"
            className="flex-1 min-w-0 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 focus:outline-none focus:ring-1 focus:ring-accent"
          >
            {CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
          <button
            type="submit"
            disabled={searching}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 hover:opacity-90 transition-opacity"
          >
            {searching ? 'Searching…' : 'Search'}
          </button>
        </form>

        {error && (
          <p className="text-xs text-red-400">{error}</p>
        )}

        {results !== null && (
          <div className="space-y-2">
            {results.length === 0 ? (
              <p className="text-sm text-zinc-500 italic text-center py-6">
                No results found.
              </p>
            ) : (
              results.map((r) => (
                <ResultCard
                  key={`${r.type}-${r.created_at}-${r.content.slice(0, 32)}`}
                  result={r}
                />
              ))
            )}
          </div>
        )}
      </section>
    </div>
  );
}
