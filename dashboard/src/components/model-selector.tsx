/**
 * Model selector dropdown for the React dashboard.
 *
 * Fetches the model list from GET /api/models (with a static fallback) and
 * renders a styled <select>. Fires onSelect on mount and on every change.
 *
 * Port of src/web-server/frontend/model-selector.ts to React + Tailwind.
 * The badge helper is a bonus used by SessionCard.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
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

const DEFAULT_MODEL_ID = 'sonnet';

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
}

export function ModelSelector({ onSelect, current, className }: ModelSelectorProps) {
  const [models, setModels] = useState<readonly ModelInfo[]>(DEFAULT_MODELS);
  const initialFired = useRef(false);

  // Fetch the real model list once.
  useEffect(() => {
    let cancelled = false;
    apiFetch<{ models: ModelInfo[] }>('/api/models')
      .then((data) => {
        if (!cancelled && data.models.length > 0) setModels(data.models);
      })
      .catch(() => {
        // Swallow -- fallback list is already set.
      });
    return () => { cancelled = true; };
  }, []);

  // Fire onSelect on mount with the initial value.
  const selected = current ?? DEFAULT_MODEL_ID;
  useEffect(() => {
    if (!initialFired.current) {
      initialFired.current = true;
      onSelect(selected);
    }
  }, [onSelect, selected]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      onSelect(e.target.value);
    },
    [onSelect],
  );

  return (
    <div className={cn('relative inline-flex items-center', className)}>
      <select
        value={selected}
        onChange={handleChange}
        aria-label="Model"
        className={cn(
          'appearance-none rounded-md border bg-secondary pl-2 pr-7 py-1',
          'text-xs font-medium text-secondary-foreground',
          'cursor-pointer focus:outline-none focus:ring-1 focus:ring-ring',
        )}
      >
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
