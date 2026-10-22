import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api';
import type { ChoiceRequest } from '@/hooks/use-choice-progress';

interface ChoiceDialogProps {
  sessionId: string;
  request: ChoiceRequest;
  onAnswered: () => void;
}

/** Keyboard-contained modal for a server-owned, correlated choice request. */
export function ChoiceDialog({ sessionId, request, onAnswered }: ChoiceDialogProps) {
  const [selected, setSelected] = useState(() => request.options.findIndex((o) => o.value === request.default) < 0
    ? 0 : request.options.findIndex((o) => o.value === request.default));
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
    // Keep keyboard focus inside even if a background control steals it.
    const keepFocus = (event: FocusEvent) => {
      if (!dialogRef.current?.contains(event.target as Node)) optionsRef.current[selected]?.focus();
    };
    document.addEventListener('focusin', keepFocus);
    return () => {
      mounted.current = false;
      document.removeEventListener('focusin', keepFocus);
      previousFocus?.focus();
    };
    // Opening a new request remounts the keyed dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function answer(value: string | null) {
    if (busy) return;
    setBusy(true);
    setError('');
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
        ...optionsRef.current.filter((item): item is HTMLButtonElement => !!item && !item.disabled),
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
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight' ||
        event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      if (optionsRef.current.includes(document.activeElement as HTMLButtonElement)) {
        event.preventDefault();
        const next = (selected + (event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1)
          + request.options.length) % request.options.length;
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
            <button key={option.value} ref={(element) => { optionsRef.current[index] = element; }}
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
