import { useState, useEffect, useRef } from 'react';
import {
  FileSearch,
  FilePen,
  Terminal,
  GitBranch,
  Globe,
  ExternalLink,
  Database,
  Wrench,
  Loader2,
  CheckCircle2,
  AlertCircle,
  ChevronRight,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { DiffViewer } from './diff-viewer';

// ── Types ────────────────────────────────────────────────────────────────────

type Status = 'running' | 'ok' | 'error';

export interface ToolCallCardProps {
  name: string;
  inputPreview: string;
  status: Status;
  output?: string;
  outputUnavailable?: boolean;
  diff?: string;
  durationMs?: number;
}

// ── Category icon map ─────────────────────────────────────────────────────────

// Contract: every tool name maps to exactly one icon + color pair.
// "default" key is the fallback for unmapped tool names.
const CATEGORY_MAP: Record<string, { Icon: React.ElementType; colorClass: string }> = {
  read_file:       { Icon: FileSearch,   colorClass: 'text-cat-read'    },
  glob:            { Icon: FileSearch,   colorClass: 'text-cat-read'    },
  grep:            { Icon: FileSearch,   colorClass: 'text-cat-read'    },
  list_directory:  { Icon: FileSearch,   colorClass: 'text-cat-read'    },
  json_query:      { Icon: FileSearch,   colorClass: 'text-cat-read'    },
  write_file:      { Icon: FilePen,      colorClass: 'text-cat-write'   },
  edit_file:       { Icon: FilePen,      colorClass: 'text-cat-write'   },
  patch_apply:     { Icon: FilePen,      colorClass: 'text-cat-write'   },
  bash:            { Icon: Terminal,     colorClass: 'text-cat-shell'   },
  test_run:        { Icon: Terminal,     colorClass: 'text-cat-shell'   },
  agent:           { Icon: GitBranch,    colorClass: 'text-cat-agent'   },
  compose:         { Icon: GitBranch,    colorClass: 'text-cat-agent'   },
  skill:           { Icon: GitBranch,    colorClass: 'text-cat-agent'   },
  browser_open:    { Icon: Globe,        colorClass: 'text-cat-browser' },
  browser_act:     { Icon: Globe,        colorClass: 'text-cat-browser' },
  browser_observe: { Icon: Globe,        colorClass: 'text-cat-browser' },
  browser_screenshot: { Icon: Globe,    colorClass: 'text-cat-browser' },
  web_scrape:      { Icon: ExternalLink, colorClass: 'text-cat-web'    },
  web_request:     { Icon: ExternalLink, colorClass: 'text-cat-web'    },
  memory_search:   { Icon: Database,     colorClass: 'text-cat-mcp'    },
  memory_update:   { Icon: Database,     colorClass: 'text-cat-mcp'    },
  state_get:       { Icon: Database,     colorClass: 'text-cat-mcp'    },
  state_put:       { Icon: Database,     colorClass: 'text-cat-mcp'    },
};

function getCategoryIcon(name: string) {
  return CATEGORY_MAP[name] ?? { Icon: Wrench, colorClass: 'text-cat-other' };
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatusIcon({ status }: { status: Status }) {
  if (status === 'running') {
    return <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin-slow text-status-blocked" aria-label="running" />;
  }
  if (status === 'ok') {
    return <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-status-running" aria-label="ok" />;
  }
  return <AlertCircle className="h-3.5 w-3.5 shrink-0 text-status-failed" aria-label="error" />;
}

function DurationBadge({ ms, live }: { ms?: number; live?: number }) {
  const display = ms !== undefined
    ? `${(ms / 1000).toFixed(1)}s`
    : live !== undefined
    ? `...${live}s`
    : null;

  if (display === null) return null;

  return (
    <span className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
      {display}
    </span>
  );
}

// ── Animated collapse via CSS grid trick ──────────────────────────────────────

// Invariant: outer div uses `grid` with `grid-template-rows`; inner div uses
// `min-h-0` so the overflow is contained. Transition is on `grid-template-rows`
// which browsers can animate without triggering a layout recalc each frame.
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

// ── Main component ────────────────────────────────────────────────────────────

/** Collapsible card for a single tool invocation. */
export function ToolCallCard({
  name,
  inputPreview,
  status,
  output,
  outputUnavailable,
  diff,
  durationMs,
}: ToolCallCardProps) {
  const [outputOpen, setOutputOpen] = useState(false);
  const [inputExpanded, setInputExpanded] = useState(false);
  const [liveSeconds, setLiveSeconds] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Live elapsed counter — only ticks while running and no final duration yet.
  useEffect(() => {
    if (status === 'running' && durationMs === undefined) {
      intervalRef.current = setInterval(() => {
        setLiveSeconds((s) => s + 1);
      }, 1000);
    } else {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    }
    return () => {
      if (intervalRef.current !== null) clearInterval(intervalRef.current);
    };
  }, [status, durationMs]);

  const { Icon, colorClass } = getCategoryIcon(name);
  const hasOutput = diff || outputUnavailable || (output && output.trim().length > 0);
  const trimmedInput = inputPreview.trim();

  return (
    <div
      className={cn(
        'rounded-md border bg-card text-sm',
        status === 'error' ? 'border-status-failed/40' : 'border-border',
      )}
    >
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 px-3 py-2">
        <Icon className={cn('h-3.5 w-3.5 shrink-0', colorClass)} />
        <span className="font-mono text-xs font-medium text-foreground">{name}</span>
        <div className="ml-auto flex items-center gap-1.5">
          <DurationBadge ms={durationMs} live={status === 'running' ? liveSeconds : undefined} />
          <StatusIcon status={status} />
        </div>
      </div>

      {/* ── Input preview ───────────────────────────────────────────────── */}
      {trimmedInput.length > 0 && (
        <button
          type="button"
          onClick={() => setInputExpanded((v) => !v)}
          className="w-full border-t border-border/50 px-3 py-1.5 text-left"
          aria-expanded={inputExpanded}
        >
          <p
            className={cn(
              'font-mono text-[11px] text-muted-foreground',
              !inputExpanded && 'line-clamp-2',
            )}
          >
            {trimmedInput}
          </p>
        </button>
      )}

      {/* ── Output section ──────────────────────────────────────────────── */}
      {hasOutput && (
        <div className="border-t border-border/50">
          <button
            type="button"
            onClick={() => setOutputOpen((v) => !v)}
            className="flex w-full cursor-pointer items-center gap-1 px-3 py-1.5 text-[11px] text-muted-foreground select-none hover:text-foreground"
            aria-expanded={outputOpen}
          >
            <ChevronRight
              className={cn(
                'h-3 w-3 shrink-0 transition-transform duration-150',
                outputOpen && 'rotate-90',
              )}
            />
            Output
          </button>
          <Collapse open={outputOpen}>
            <div className="px-3 pb-2 pt-1">
              {outputUnavailable && (
                <p className="text-[11px] italic text-muted-foreground">
                  Output not available (replayed session)
                </p>
              )}
              {diff && <DiffViewer diff={diff} />}
              {!diff && output && (
                <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[11px] text-foreground">
                  {output}
                </pre>
              )}
            </div>
          </Collapse>
        </div>
      )}
    </div>
  );
}
