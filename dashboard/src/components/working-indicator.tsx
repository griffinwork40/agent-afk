/**
 * WorkingIndicator — assistant placeholder shown while the model is computing.
 *
 * Invariant: rendered ONLY when turnActive is true and no live draft text has
 * arrived yet for the current turn (drafts replace it). A fixed min-height
 * prevents layout shift when the first token arrives and the placeholder morphs
 * into the streaming AssistantRow.
 *
 * Phases in order:
 *   "Thinking"   — immediately on send, before any tool rows appear
 *   "Running <tool>" — while a tool group is active (passed from tool-group)
 *   "Writing…"   — after tools finish and before the first text token
 *
 * The elapsed timer updates every second. Reduced-motion: the pulsing dot is
 * replaced by a static dot (no animation class). Screen reader: a single
 * aria-live="polite" region announces the phase once on change; the timer is
 * aria-hidden so it does not announce every second.
 */
import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

export type WorkingPhase = 'thinking' | 'running' | 'writing';

export interface WorkingIndicatorProps {
  phase?: WorkingPhase;
  /** Tool name when phase === 'running' */
  toolName?: string;
  className?: string;
}

function useElapsed(): number {
  const [elapsed, setElapsed] = useState(0);
  const ref = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    setElapsed(0);
    ref.current = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => {
      if (ref.current !== null) clearInterval(ref.current);
    };
  }, []);

  return elapsed;
}

function phaseLabel(phase: WorkingPhase, toolName?: string): string {
  if (phase === 'running') return toolName ? `Running ${toolName}` : 'Running tool';
  if (phase === 'writing') return 'Writing\u2026';
  return 'Thinking';
}

/** Pulsing dot that respects prefers-reduced-motion. */
function PulseDot({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-block h-2 w-2 rounded-full bg-brand motion-safe:animate-pulse',
        className,
      )}
    />
  );
}

/**
 * Assistant placeholder row: pulsing dot + phase label + elapsed timer.
 * Fixed min-height (h-10) prevents layout shift on first token.
 */
export function WorkingIndicator({ phase = 'thinking', toolName, className }: WorkingIndicatorProps) {
  const elapsed = useElapsed();
  const label = phaseLabel(phase, toolName);

  return (
    <div
      className={cn(
        'flex min-h-10 items-center gap-2 rounded-md px-1 py-2',
        className,
      )}
    >
      {/* Accessible phase announcement — updates only when label changes */}
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {label}
      </span>

      <PulseDot />

      <span className="text-sm text-muted-foreground" aria-hidden="true">
        {label}
      </span>

      <span
        className="font-mono text-xs text-muted-foreground"
        aria-hidden="true"
      >
        {elapsed}s
      </span>
    </div>
  );
}
