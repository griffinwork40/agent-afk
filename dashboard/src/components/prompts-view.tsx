import { useState, useCallback } from 'react';
import { RefreshCw, Lock, Copy, Check, X, FileText } from 'lucide-react';
import { cn } from '@/lib/utils';
import { usePrompts } from '@/hooks/use-prompts';
import type { PromptEntryWire, PromptDetailWire } from '@/types/api';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KIND_ORDER = ['framework', 'spine', 'skill-phase', 'vendored-agent', 'bundled-skill', 'user-skill'];

const KIND_LABELS: Record<string, string> = {
  framework: 'Framework',
  spine: 'Spine',
  'skill-phase': 'Skill Phase',
  'vendored-agent': 'Vendored Agent',
  'bundled-skill': 'Bundled Skill',
  'user-skill': 'User Skill',
};

const KIND_BADGE_CLASSES: Record<string, string> = {
  framework:       'bg-violet-500/15 text-violet-400',
  spine:           'bg-blue-500/15 text-blue-400',
  'skill-phase':   'bg-emerald-500/15 text-emerald-400',
  'vendored-agent':'bg-amber-500/15 text-amber-400',
  'bundled-skill': 'bg-cyan-500/15 text-cyan-400',
  'user-skill':    'bg-pink-500/15 text-pink-400',
};

// Filter pill ids — "all" plus a collapsed view per group
const FILTER_PILLS = [
  { id: 'all',    label: 'All' },
  { id: 'framework',      label: 'Framework' },
  { id: 'spine',          label: 'Spine' },
  { id: 'skill-phase',    label: 'Skills' },
  { id: 'vendored-agent', label: 'Agents' },
  { id: 'bundled-skill',  label: 'Bundled' },
  { id: 'user-skill',     label: 'User' },
];

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function KindBadge({ kind }: { kind: string }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-xs font-medium',
        KIND_BADGE_CLASSES[kind] ?? 'bg-zinc-700 text-zinc-300',
      )}
    >
      {KIND_LABELS[kind] ?? kind}
    </span>
  );
}

function TokenPill({ count }: { count: number }) {
  const label =
    count >= 1000 ? `${(count / 1000).toFixed(1)}k tok` : `${count} tok`;
  const colorClass =
    count >= 8000
      ? 'text-red-400'
      : count >= 3000
        ? 'text-amber-400'
        : 'text-zinc-400';
  return (
    <span className={cn('shrink-0 font-mono text-xs tabular-nums', colorClass)}>
      {label}
    </span>
  );
}

function PromptRow({
  entry,
  selected,
  onClick,
}: {
  entry: PromptEntryWire;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left',
        'transition-colors hover:bg-accent/40',
        selected && 'bg-accent/60 ring-1 ring-inset ring-brand/40',
      )}
    >
      <span className="min-w-0 flex-1 truncate text-sm">{entry.name}</span>
      {entry.pinned && (
        <Lock className="size-3 shrink-0 text-muted-foreground" aria-label="pinned" />
      )}
      <TokenPill count={entry.tokenEstimate} />
    </button>
  );
}

function GroupSection({
  kind,
  entries,
  selectedId,
  onSelect,
}: {
  kind: string;
  entries: PromptEntryWire[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="flex flex-col gap-0.5">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="flex items-center gap-2 px-1 py-1 text-left"
      >
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {KIND_LABELS[kind] ?? kind}
        </span>
        <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
          {entries.length}
        </span>
        <span className="ml-auto text-xs text-muted-foreground">
          {collapsed ? '▸' : '▾'}
        </span>
      </button>
      {!collapsed &&
        entries.map((e) => (
          <PromptRow
            key={e.id}
            entry={e}
            selected={selectedId === e.id}
            onClick={() => onSelect(e.id)}
          />
        ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail panel
// ---------------------------------------------------------------------------

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [text]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={cn(
        'flex items-center gap-1.5 rounded-md px-2 py-1 text-xs',
        'border border-border bg-secondary text-secondary-foreground',
        'hover:bg-accent hover:text-foreground transition-colors',
      )}
      aria-label="Copy prompt content"
    >
      {copied ? (
        <Check className="size-3 text-status-done" />
      ) : (
        <Copy className="size-3" />
      )}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

function MetaRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <span className="w-32 shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 break-all text-xs text-foreground">{value}</span>
    </div>
  );
}

function DetailPanel({
  prompt,
  loading,
  onClose,
}: {
  prompt: PromptDetailWire | null;
  loading: boolean;
  onClose: () => void;
}) {
  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  if (!prompt) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
        <FileText className="size-8 opacity-30" />
        <p className="text-sm">Select a prompt to view its content</p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Detail header */}
      <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-semibold">{prompt.name}</span>
            <KindBadge kind={prompt.kind} />
            {prompt.pinned && (
              <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                <Lock className="size-3" /> pinned
              </span>
            )}
          </div>
          <span className="font-mono text-xs text-muted-foreground">{prompt.relativePath}</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close detail"
          className="mt-0.5 shrink-0 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>

      {/* Metadata */}
      <div className="flex shrink-0 flex-col gap-1.5 border-b border-border px-4 py-3">
        <MetaRow label="Tokens" value={<TokenPill count={prompt.tokenEstimate} />} />
        <MetaRow label="Injection" value={prompt.injectionContext} />
        <MetaRow label="Editable" value={prompt.editable ? 'Yes' : 'No'} />
        {prompt.skill && <MetaRow label="Skill" value={prompt.skill} />}
        {prompt.phase && <MetaRow label="Phase" value={prompt.phase} />}
      </div>

      {/* Content area */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div className="absolute right-3 top-2 z-10">
          <CopyButton text={prompt.content} />
        </div>
        <pre className="min-h-0 flex-1 overflow-y-auto overflow-x-auto whitespace-pre-wrap break-words p-4 font-mono text-xs text-foreground">
          {prompt.content}
        </pre>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function PromptsView() {
  const {
    prompts,
    loading,
    error,
    searchQuery,
    setSearchQuery,
    selectedPrompt,
    loadingDetail,
    selectPrompt,
    clearSelection,
    refresh,
  } = usePrompts();

  const [kindFilter, setKindFilter] = useState('all');

  const filteredPrompts =
    kindFilter === 'all' ? prompts : prompts.filter((p) => p.kind === kindFilter);

  // Group by kind in canonical order
  const groups = KIND_ORDER.reduce<Record<string, PromptEntryWire[]>>((acc, k) => {
    const entries = filteredPrompts.filter((p) => p.kind === k);
    if (entries.length > 0) acc[k] = entries;
    return acc;
  }, {});

  // Any kinds not in KIND_ORDER (future-proof)
  const unknownKinds = [...new Set(filteredPrompts.map((p) => p.kind))].filter(
    (k) => !KIND_ORDER.includes(k),
  );
  unknownKinds.forEach((k) => {
    const entries = filteredPrompts.filter((p) => p.kind === k);
    if (entries.length > 0) groups[k] = entries;
  });

  const totalShown = filteredPrompts.length;

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left panel: list */}
      <div className="flex w-72 shrink-0 flex-col border-r border-border overflow-hidden">
        {/* List header */}
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
          <span className="text-xs text-muted-foreground">
            {loading ? '…' : `${totalShown} prompt${totalShown !== 1 ? 's' : ''}`}
          </span>
          <button
            type="button"
            onClick={refresh}
            aria-label="Refresh prompts"
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <RefreshCw className="size-3.5" />
          </button>
        </div>

        {/* Search input */}
        <div className="shrink-0 px-3 py-2">
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search prompts…"
            className={cn(
              'w-full rounded-md border border-border bg-secondary px-3 py-1.5 text-sm',
              'placeholder:text-muted-foreground/60',
              'focus:outline-none focus:ring-2 focus:ring-ring',
            )}
          />
        </div>

        {/* Kind filter pills */}
        <div className="flex shrink-0 flex-wrap gap-1 px-3 pb-2">
          {FILTER_PILLS.map((pill) => (
            <button
              key={pill.id}
              type="button"
              onClick={() => setKindFilter(pill.id)}
              className={cn(
                'rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors',
                kindFilter === pill.id
                  ? 'bg-brand text-white'
                  : 'bg-muted text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              {pill.label}
            </button>
          ))}
        </div>

        {/* Error */}
        {error && (
          <p className="mx-3 mb-2 rounded-md border border-status-failed/30 bg-status-failed/10 px-3 py-2 text-xs text-status-failed">
            {error}
          </p>
        )}

        {/* List body */}
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-2 py-1">
          {loading && (
            <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
          )}
          {!loading && totalShown === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {searchQuery ? 'No results.' : 'No prompts found.'}
            </p>
          )}
          {!loading &&
            Object.entries(groups).map(([kind, entries]) => (
              <GroupSection
                key={kind}
                kind={kind}
                entries={entries}
                selectedId={selectedPrompt?.id ?? null}
                onSelect={(id) => void selectPrompt(id)}
              />
            ))}
        </div>
      </div>

      {/* Right panel: detail */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <DetailPanel
          prompt={selectedPrompt}
          loading={loadingDetail}
          onClose={clearSelection}
        />
      </div>
    </div>
  );
}
