/**
 * Model selector dropdown for the React dashboard.
 *
 * Fetches the model list from GET /api/models (with a static fallback) and
 * renders a controlled <select>. Fires onSelect only on deliberate changes.
 * Uses the same ordered, deduped data as the /model picker (via groups).
 */

import { useCallback, useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import type { ModelInfo } from '@/types/api';
import { cn } from '@/lib/utils';

// ---- constants ----------------------------------------------------------------

const DEFAULT_MODELS: readonly ModelInfo[] = [
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
  { id: 'opus', label: 'Opus' },
];

// ---- badge colour map ---------------------------------------------------------

const BADGE_CLASSES: Readonly<Record<string, string>> = {
  opus: 'bg-brand/15 text-brand',
  sonnet: 'bg-status-running/15 text-status-running',
  haiku: 'bg-muted text-muted-foreground',
};

function badgeClasses(modelId: string): string {
  const lower = modelId.toLowerCase();
  for (const key of Object.keys(BADGE_CLASSES)) {
    if (lower.includes(key)) return BADGE_CLASSES[key] ?? '';
  }
  return 'bg-muted text-muted-foreground';
}

/**
 * Derive a short display label from a model id.
 *
 * 'claude-3-5-sonnet-20241022' -> 'sonnet'
 * 'sonnet'                      -> 'sonnet'
 */
function shortLabel(modelId: string): string {
  const lower = modelId.toLowerCase();
  for (const key of ['opus', 'sonnet', 'haiku']) {
    if (lower.includes(key)) return key;
  }
  return modelId.length > 12 ? `${modelId.slice(0, 12)}\u2026` : modelId;
}

// ---- public components --------------------------------------------------------

interface ModelSelectorProps {
  /** Called with the chosen model id whenever the selection changes. */
  onSelect: (modelId: string) => void;
  /** Currently selected model id. */
  current?: string;
  className?: string;
  disabled?: boolean;
}

interface ModelGroup {
  label: string;
  rows: Array<{ id: string; name: string; aliases: string[] }>;
}

export function ModelSelector({ onSelect, current, className, disabled }: ModelSelectorProps) {
  const [models, setModels] = useState<readonly ModelInfo[]>(DEFAULT_MODELS);
  const [serverDefault, setServerDefault] = useState<string>();

  // Fetch the real model list once — use groups for deduped ordered data.
  useEffect(() => {
    let cancelled = false;
    apiFetch<{ models: ModelInfo[]; groups?: ModelGroup[]; default?: string }>('/api/models')
      .then((data) => {
        if (cancelled) return;
        // Prefer flat models list (already deduped and ordered by the server).
        if (data.models?.length > 0) setModels(data.models);
        if (data.default) setServerDefault(data.default);
      })
      .catch(() => {
        // Swallow -- fallback list is already set.
      });
    return () => { cancelled = true; };
  }, []);

  // Mounting or loading a session must not mutate its provider model.
  const selected = current ?? serverDefault ?? '';

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      if (e.target.value) onSelect(e.target.value);
    },
    [onSelect],
  );

  return (
    <div className={cn('relative inline-flex items-center', className)}>
      <select
        value={selected}
        disabled={disabled}
        onChange={handleChange}
        aria-label="Model"
        className={cn(
          'max-w-44 appearance-none rounded-md border bg-secondary pl-2 pr-7 py-1',
          'text-xs font-medium text-secondary-foreground',
          'cursor-pointer focus:outline-none focus:ring-1 focus:ring-ring',
        )}
      >
        {!models.some((m) => m.id === selected) && (
          <option value={selected} disabled={!selected}>{selected || 'Server default'}</option>
        )}
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-1.5 h-3 w-3 text-muted-foreground" />
    </div>
  );
}

/** Small coloured pill badge showing the model tier. */
export function ModelBadge({ model }: { model: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium',
        badgeClasses(model),
      )}
    >
      {shortLabel(model)}
    </span>
  );
}
