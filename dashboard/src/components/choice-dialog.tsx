import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { requestComposerFocus } from '@/lib/composer-focus';
import type { ChoiceRequest } from '@/hooks/use-choice-progress';
import { Search } from 'lucide-react';

interface ChoiceDialogProps {
  sessionId: string;
  request: ChoiceRequest;
  onAnswered: () => void;
}

interface ModelRow {
  id: string;
  name: string;
  aliases: string[];
  has1m: boolean;
}

interface ModelGroup {
  label: string;
  rows: ModelRow[];
}

/** Whether the choice dialog is a model-picker (title contains "model"). */
function isModelPicker(title: string): boolean {
  return /model/i.test(title);
}

// ── Generic choice dialog ─────────────────────────────────────────────────

function GenericChoiceDialog({ sessionId, request, onAnswered }: ChoiceDialogProps) {
  const [selected, setSelected] = useState(() => {
    const idx = request.options.findIndex((o) => o.value === request.default);
    return idx < 0 ? 0 : idx;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);
  const optionsRef = useRef<(HTMLButtonElement | null)[]>([]);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    optionsRef.current[selected]?.focus();
    const keepFocus = (event: FocusEvent) => {
      if (!dialogRef.current?.contains(event.target as Node)) optionsRef.current[selected]?.focus();
    };
    document.addEventListener('focusin', keepFocus);
    return () => {
      mounted.current = false;
      document.removeEventListener('focusin', keepFocus);
      previousFocus?.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function answer(value: string | null) {
    if (busy) return;
    setBusy(true); setError('');
    try {
      await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/choices/${encodeURIComponent(request.corrId)}`, {
        method: 'POST', body: JSON.stringify({ value }),
      });
      if (mounted.current) onAnswered();
    } catch {
      if (mounted.current) { setError('Could not submit choice. Try again.'); setBusy(false); }
    }
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (request.cancellable && !busy) { event.preventDefault(); void answer(null); }
      return;
    }
    if (event.key === 'Tab') {
      event.stopPropagation();
      const controls = [
        ...optionsRef.current.filter((el): el is HTMLButtonElement => !!el && !el.disabled),
        ...(request.cancellable && cancelRef.current && !cancelRef.current.disabled ? [cancelRef.current] : []),
        ...(submitRef.current && !submitRef.current.disabled ? [submitRef.current] : []),
      ];
      if (!controls.length) { event.preventDefault(); dialogRef.current?.focus(); return; }
      const index = controls.indexOf(document.activeElement as HTMLButtonElement);
      event.preventDefault();
      const next = index < 0 ? (event.shiftKey ? controls.length - 1 : 0)
        : (index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
      controls[next]?.focus();
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      if (optionsRef.current.includes(document.activeElement as HTMLButtonElement)) {
        event.preventDefault();
        const next = (selected + (event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1) + request.options.length) % request.options.length;
        setSelected(next);
        optionsRef.current[next]?.focus();
      }
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div ref={dialogRef} role="dialog" tabIndex={-1} aria-modal="true" aria-labelledby="choice-title"
        aria-describedby={error ? 'choice-error' : undefined} onKeyDown={onKeyDown}
        className="flex max-h-[calc(100dvh-2rem)] w-full max-w-lg flex-col rounded-lg border bg-background p-5 shadow-xl">
        <h2 id="choice-title" className="text-lg font-semibold">{request.title}</h2>
        <div role="radiogroup" aria-label="Choices" className="mt-4 flex min-h-0 flex-col gap-2 overflow-y-auto">
          {request.options.map((option, index) => (
            <button key={option.value} ref={(el) => { optionsRef.current[index] = el; }}
              type="button" role="radio" aria-checked={selected === index} tabIndex={selected === index ? 0 : -1}
              disabled={busy} onClick={() => setSelected(index)}
              className={`rounded-md border p-3 text-left text-sm focus-visible:ring-2 focus-visible:ring-ring ${selected === index ? 'border-brand bg-accent' : 'border-border'}`}>
              <span className="font-medium">{option.label}</span>
              {option.description && <span className="mt-1 block text-muted-foreground">{option.description}</span>}
            </button>
          ))}
        </div>
        {error && <p id="choice-error" role="alert" className="mt-3 text-sm text-red-400">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          {request.cancellable && <button ref={cancelRef} type="button" disabled={busy}
            className="rounded border px-3 py-2 text-sm" onClick={() => void answer(null)}>Cancel</button>}
          <button ref={submitRef} type="button" disabled={busy}
            className="rounded bg-brand px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
            onClick={() => void answer(request.options[selected]!.value)}>
            {busy ? 'Submitting…' : 'Select'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Model alias chip strip (max 2 visible + overflow count) ──────────────

const MAX_VISIBLE_CHIPS = 2;

function ModelAliasChips({
  aliases,
  has1m,
  selectedAlias,
  rowId,
  onSelect,
}: {
  aliases: string[];
  has1m: boolean;
  selectedAlias: string;
  rowId: string;
  onSelect: (alias: string) => void;
}) {
  const allChips: Array<{ key: string; label: string; alias: string }> = [
    ...aliases.map((a) => ({ key: a, label: a, alias: a })),
    ...(has1m ? [{ key: `${rowId}_1m`, label: '1M', alias: `${rowId}_1m` }] : []),
  ];
  const visible = allChips.slice(0, MAX_VISIBLE_CHIPS);
  const overflow = allChips.length - MAX_VISIBLE_CHIPS;
  return (
    <span className="ml-2 flex shrink-0 items-center gap-1">
      {visible.map(({ key, label, alias }) => (
        <span key={key}
          onClick={(e) => { e.stopPropagation(); onSelect(alias); }}
          className={[
            'cursor-pointer rounded px-1.5 py-0.5 text-[10px] font-mono transition-colors',
            selectedAlias === alias
              ? 'bg-brand text-primary-foreground'
              : 'bg-muted text-muted-foreground hover:bg-muted/70',
          ].join(' ')}>
          {label}
        </span>
      ))}
      {overflow > 0 && (
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
          +{overflow}
        </span>
      )}
    </span>
  );
}

// ── Model picker dialog ───────────────────────────────────────────────────

interface ModelPickerProps {
  sessionId: string;
  request: ChoiceRequest;
  onAnswered: () => void;
  groups: ModelGroup[];
  currentModel: string;
}

function ModelPickerDialog({ sessionId, request, onAnswered, groups, currentModel }: ModelPickerProps) {
  const [filter, setFilter] = useState('');
  const [selectedAlias, setSelectedAlias] = useState<string>(
    request.default ?? currentModel ?? (groups[0]?.rows[0]?.id ?? '')
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const filterRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    mounted.current = true;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    filterRef.current?.focus();
    return () => {
      mounted.current = false;
      // The composer is disabled while the /model command is in flight, so a
      // direct focus() here races its re-enable. Ask the composer to focus
      // itself once it is enabled again (requestComposerFocus).
      if (!requestComposerFocus()) previousFocusRef.current?.focus();
    };
  }, []);

  async function answer(value: string | null) {
    if (busy) return;
    setBusy(true); setError('');
    try {
      await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/choices/${encodeURIComponent(request.corrId)}`, {
        method: 'POST', body: JSON.stringify({ value }),
      });
      if (mounted.current) onAnswered();
    } catch {
      if (mounted.current) { setError('Could not submit. Try again.'); setBusy(false); }
    }
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      event.preventDefault();
      if (!busy) {
        // Dismiss UI immediately so the session becomes interactive again.
        // Then POST null to the server in the background to unblock the coroutine.
        onAnswered();
        if (!requestComposerFocus()) previousFocusRef.current?.focus();
        // Fire-and-forget: let the server know the choice was cancelled.
        void apiFetch(
          `/api/sessions/${encodeURIComponent(sessionId)}/choices/${encodeURIComponent(request.corrId)}`,
          { method: 'POST', body: JSON.stringify({ value: null }) },
        ).catch(() => undefined);
      }
    }
  }

  const q = filter.trim().toLowerCase();
  const filteredGroups = groups.map((g) => ({
    ...g,
    rows: g.rows.filter((r) =>
      !q ||
      r.id.toLowerCase().includes(q) ||
      r.name.toLowerCase().includes(q) ||
      r.aliases.some((a) => a.toLowerCase().includes(q))
    ),
  })).filter((g) => g.rows.length > 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onKeyDown={onKeyDown}>
      <div role="dialog" aria-modal="true" aria-labelledby="mpicker-title"
        aria-describedby={error ? 'mpicker-error' : undefined}
        className="flex max-h-[calc(100dvh-2rem)] w-full max-w-lg flex-col rounded-lg border bg-background shadow-xl">
        {/* Header */}
        <div className="px-5 pt-5 pb-3 shrink-0">
          <h2 id="mpicker-title" className="text-lg font-semibold mb-3">{request.title}</h2>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <input ref={filterRef} type="text" value={filter} onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter models…" aria-label="Filter models"
              className="w-full rounded-md border bg-secondary pl-8 pr-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring" />
          </div>
        </div>
        {/* Scrollable model list */}
        <div role="radiogroup" aria-label="Models" className="min-h-0 overflow-y-auto px-5 pb-2 flex flex-col gap-3">
          {filteredGroups.length === 0 && (
            <p className="py-4 text-center text-sm text-muted-foreground">No models match &ldquo;{filter}&rdquo;</p>
          )}
          {filteredGroups.map((group) => (
            <div key={group.label}>
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{group.label}</p>
              <div className="flex flex-col gap-1">
                {group.rows.map((row) => {
                  const isCurrent = row.aliases.includes(currentModel) || row.id === currentModel;
                  const isSelected = row.aliases.includes(selectedAlias) || row.id === selectedAlias;
                  return (
                    <button key={row.id} type="button" role="radio" disabled={busy}
                      aria-checked={isSelected}
                      aria-label={row.name}
                      tabIndex={isSelected ? 0 : -1}
                      onClick={() => setSelectedAlias(row.id)}
                      onDoubleClick={() => { setSelectedAlias(row.id); void answer(row.id); }}
                      className={[
                        'flex items-center justify-between rounded-md border px-3 py-2 text-left text-sm transition-colors',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        isSelected ? 'border-brand bg-accent' : 'border-border hover:bg-accent/50',
                      ].join(' ')}>
                      {/* Name + current badge — always visible, shrinks before chips do */}
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="font-medium truncate">{row.name}</span>
                        {isCurrent && (
                          <span className="shrink-0 rounded-full bg-status-done/15 px-1.5 py-0.5 text-[10px] font-medium text-status-done">
                            current
                          </span>
                        )}
                      </span>
                      {/* Alias chips — capped at 2 visible + "+N" overflow chip so the
                          model name is never pushed off-screen on narrow viewports. */}
                      <ModelAliasChips
                        aliases={row.aliases}
                        has1m={row.has1m}
                        selectedAlias={selectedAlias}
                        rowId={row.id}
                        onSelect={(a) => { setSelectedAlias(a); }}
                      />
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        {error && <p id="mpicker-error" role="alert" className="mx-5 mt-1 text-sm text-red-400">{error}</p>}
        {/* Footer */}
        <div className="shrink-0 flex justify-end gap-2 border-t border-border/40 px-5 py-3">
          <button type="button" disabled={busy}
            className="rounded border px-3 py-2 text-sm hover:bg-accent"
            onClick={() => {
              void answer(null);
              requestComposerFocus();
            }}>Cancel</button>
          <button type="button" disabled={busy || !selectedAlias}
            className="rounded bg-brand px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
            onClick={() => void answer(selectedAlias)}>
            {busy ? 'Switching…' : 'Select'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Outer shell: fetches groups for model picker, renders generic otherwise ─

/** Keyboard-contained modal for a server-owned, correlated choice request. */
export function ChoiceDialog({ sessionId, request, onAnswered }: ChoiceDialogProps) {
  const [groups, setGroups] = useState<ModelGroup[] | null>(null);
  const [modelLabels, setModelLabels] = useState<Record<string, string>>({});
  const [currentModel, setCurrentModel] = useState<string>('');

  const isPicker = isModelPicker(request.title);

  useEffect(() => {
    if (!isPicker) return;
    let cancelled = false;
    apiFetch<{ groups?: ModelGroup[]; models?: Array<{ id: string; label: string }>; default?: string }>('/api/models').then((data) => {
      if (cancelled) return;
      if (data?.groups) setGroups(data.groups);
      // Build label lookup from flat models list for fallback display.
      if (data?.models) setModelLabels(Object.fromEntries(data.models.map((m) => [m.id, m.label])));
      if (data?.default) setCurrentModel(data.default);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [isPicker]);

  if (isPicker) {
    // If we have server groups, use them. Otherwise build from request options,
    // resolving labels from the flat models list (so resolved names show up).
    const effectiveGroups: ModelGroup[] = groups ?? [{
      label: 'Models',
      rows: request.options.map((o) => ({
        id: o.value,
        name: modelLabels[o.value] ?? o.label,
        aliases: [o.value],
        has1m: false,
      })),
    }];
    return (
      <ModelPickerDialog
        sessionId={sessionId}
        request={request}
        onAnswered={onAnswered}
        groups={effectiveGroups}
        currentModel={currentModel}
      />
    );
  }

  return <GenericChoiceDialog sessionId={sessionId} request={request} onAnswered={onAnswered} />;
}
