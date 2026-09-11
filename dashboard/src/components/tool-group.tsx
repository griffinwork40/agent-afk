import { useState, useEffect, useRef } from 'react';
import { CheckCircle2, AlertCircle, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ToolCallCard, type ToolCallCardProps } from './tool-call-card';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ToolGroupProps {
  tools: ToolCallCardProps[];
  isActive: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sumDurations(tools: ToolCallCardProps[]): number | undefined {
  const values = tools.map((t) => t.durationMs).filter((ms): ms is number => ms !== undefined);
  return values.length > 0 ? values.reduce((a, b) => a + b, 0) : undefined;
}

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

// ── Animated collapse (same CSS grid technique as ToolCallCard) ───────────────

// Invariant: grid-rows transition is hardware-accelerated; inner div uses
// min-h-0 to contain overflow without explicit height calculations.
function Collapse({ open, children }: { open: boolean; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        'grid transition-[grid-template-rows] duration-200 ease-out',
        open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
      )}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}

// ── Header states ─────────────────────────────────────────────────────────────

function RunningHeader({ tools }: { tools: ToolCallCardProps[] }) {
  const runningIdx = tools.findIndex((t) => t.status === 'running');
  const current = runningIdx >= 0 ? runningIdx + 1 : tools.length;

  return (
    <span className="animate-shimmer-pulse font-medium text-status-blocked">
      Running tool {current} of {tools.length}...
    </span>
  );
}

function CompleteHeader({ tools }: { tools: ToolCallCardProps[] }) {
  const total = sumDurations(tools);
  return (
    <span className="flex items-center gap-1.5 font-medium text-status-running">
      <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
      Tools complete ✓{total !== undefined && ` ${formatMs(total)}`}
    </span>
  );
}

function ErrorHeader({ tools }: { tools: ToolCallCardProps[] }) {
  const errorCount = tools.filter((t) => t.status === 'error').length;
  return (
    <span className="flex items-center gap-1.5 font-medium text-status-failed">
      <AlertCircle className="h-3.5 w-3.5 shrink-0" />
      {errorCount} error{errorCount !== 1 ? 's' : ''}
    </span>
  );
}

// ── Live elapsed for active groups with no durations yet ──────────────────────

function LiveElapsed({ isActive }: { isActive: boolean }) {
  const [seconds, setSeconds] = useState(0);
  const ref = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (isActive) {
      ref.current = setInterval(() => setSeconds((s) => s + 1), 1000);
    } else {
      if (ref.current !== null) {
        clearInterval(ref.current);
        ref.current = null;
      }
    }
    return () => {
      if (ref.current !== null) clearInterval(ref.current);
    };
  }, [isActive]);

  if (!isActive) return null;
  return (
    <span className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
      ...{seconds}s
    </span>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

/**
 * Groups a set of ToolCallCards under a collapsible header that summarises the
 * overall state (running / complete / error) and total elapsed time.
 *
 * Invariant: body auto-expands while isActive and auto-collapses when the group
 * transitions to complete — unless the user has manually toggled it (userToggled
 * tracks that override so we respect their intent).
 */
export function ToolGroup({ tools, isActive }: ToolGroupProps) {
  // Track whether the user has explicitly toggled so auto-collapse is opt-outable.
  const [userToggled, setUserToggled] = useState(false);
  const [open, setOpen] = useState(isActive);

  // Auto-manage open state unless the user has taken control.
  useEffect(() => {
    if (userToggled) return;
    setOpen(isActive);
  }, [isActive, userToggled]);

  function handleToggle() {
    setUserToggled(true);
    setOpen((v) => !v);
  }

  const hasError = tools.some((t) => t.status === 'error');
  const totalDuration = sumDurations(tools);

  return (
    <div className="rounded-md border border-border bg-card">
      {/* ── Group header ─────────────────────────────────────────────────── */}
      <button
        type="button"
        onClick={handleToggle}
        className="flex w-full items-center gap-2 px-3 py-2 text-xs select-none hover:bg-muted/30"
        aria-expanded={open}
      >
        <ChevronDown
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-150',
            !open && '-rotate-90',
          )}
        />

        <span className="flex-1 text-left">
          {hasError ? (
            <ErrorHeader tools={tools} />
          ) : isActive ? (
            <RunningHeader tools={tools} />
          ) : (
            <CompleteHeader tools={tools} />
          )}
        </span>

        {/* Duration badge — live while active, final sum when done */}
        {isActive && totalDuration === undefined ? (
          <LiveElapsed isActive={isActive} />
        ) : totalDuration !== undefined && !isActive ? (
          <span className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            {formatMs(totalDuration)}
          </span>
        ) : null}

        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
          {tools.length} tool{tools.length !== 1 ? 's' : ''}
        </span>
      </button>

      {/* ── Collapsible tool list ─────────────────────────────────────────── */}
      <Collapse open={open}>
        <div className="flex flex-col gap-1.5 border-t border-border/50 p-2">
          {tools.map((tool, i) => (
            <ToolCallCard key={i} {...tool} />
          ))}
        </div>
      </Collapse>
    </div>
  );
}
