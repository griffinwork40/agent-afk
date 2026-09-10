import { useEffect, useState } from 'react';
import { Cpu, Server, Keyboard, Info } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { ModelInfo, DaemonStatus } from '@/types/api';

// ---------------------------------------------------------------------------
// Section wrapper
// ---------------------------------------------------------------------------

function Section({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <Icon className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">{title}</h2>
      </div>
      <div className="rounded-xl border border-border bg-card">{children}</div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Key / value row
// ---------------------------------------------------------------------------

function Row({
  label,
  value,
  mono = false,
  last = false,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  last?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-4 px-4 py-2.5',
        !last && 'border-b border-border',
      )}
    >
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span
        className={cn(
          'min-w-0 truncate text-right text-xs',
          mono ? 'font-mono text-zinc-300' : 'text-zinc-200',
        )}
      >
        {value}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Model list
// ---------------------------------------------------------------------------

function ModelRow({
  model,
  last,
}: {
  model: ModelInfo;
  last: boolean;
}) {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-4 px-4 py-2.5',
        !last && 'border-b border-border',
      )}
    >
      <span className="text-xs text-zinc-200">{model.label}</span>
      <span className="font-mono text-xs text-muted-foreground">{model.id}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts reference
// ---------------------------------------------------------------------------

const SHORTCUTS: { keys: string; description: string }[] = [
  { keys: '⌘K', description: 'Open command palette' },
  { keys: '⌘1', description: 'Go to Sessions' },
  { keys: '⌘2', description: 'Go to Memory' },
  { keys: '⌘3', description: 'Go to Schedules' },
  { keys: '⌘4', description: 'Go to Background Jobs' },
];

function ShortcutRow({
  keys,
  description,
  last,
}: {
  keys: string;
  description: string;
  last: boolean;
}) {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-4 px-4 py-2.5',
        !last && 'border-b border-border',
      )}
    >
      <span className="text-xs text-zinc-200">{description}</span>
      <kbd className="rounded border border-border bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
        {keys}
      </kbd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Daemon status pill
// ---------------------------------------------------------------------------

function DaemonPill({ status }: { status: DaemonStatus | null }) {
  if (!status) {
    return <span className="text-xs text-muted-foreground">–</span>;
  }
  return (
    <span className="flex items-center gap-1.5">
      <span
        className={cn(
          'size-1.5 rounded-full',
          status.running ? 'animate-pulse bg-status-done' : 'bg-status-failed',
        )}
      />
      <span className={cn('text-xs', status.running ? 'text-zinc-200' : 'text-muted-foreground')}>
        {status.running
          ? `Running${status.tasks != null ? ` · ${status.tasks} task${status.tasks !== 1 ? 's' : ''}` : ''}`
          : 'Stopped'}
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

interface SettingsData {
  models: ModelInfo[] | null;
  daemon: DaemonStatus | null;
  modelsError: string | null;
  daemonError: string | null;
}

export function SettingsView() {
  const [data, setData] = useState<SettingsData>({
    models: null,
    daemon: null,
    modelsError: null,
    daemonError: null,
  });

  useEffect(() => {
    let cancelled = false;

    Promise.all([
      apiFetch<{ models: ModelInfo[] }>('/api/models').then(
        (r) => ({ ok: true as const, models: r.models }),
        (e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : 'Failed to load models' }),
      ),
      apiFetch<DaemonStatus>('/api/daemon/status').then(
        (r) => ({ ok: true as const, daemon: r }),
        (e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : 'Failed to load daemon status' }),
      ),
    ]).then(([modelsResult, daemonResult]) => {
      if (cancelled) return;
      setData({
        models: modelsResult.ok ? modelsResult.models : null,
        modelsError: modelsResult.ok ? null : modelsResult.error,
        daemon: daemonResult.ok ? daemonResult.daemon : null,
        daemonError: daemonResult.ok ? null : daemonResult.error,
      });
    }).catch(() => { /* individual branches already handle errors */ });

    return () => { cancelled = true; };
  }, []);

  return (
    <div className="flex flex-1 flex-col gap-6 overflow-y-auto p-4">

      {/* Server info */}
      <Section icon={Server} title="Server">
        <Row
          label="Daemon"
          value={<DaemonPill status={data.daemon} />}
        />
        {data.daemonError && (
          <Row
            label="Error"
            value={data.daemonError}
            last
          />
        )}
        {!data.daemonError && (
          <Row
            label="Tasks scheduled"
            value={data.daemon?.tasks != null ? String(data.daemon.tasks) : '–'}
            last
          />
        )}
      </Section>

      {/* Model configuration */}
      <Section icon={Cpu} title="Available Models">
        {data.modelsError ? (
          <div className="px-4 py-3 text-xs text-status-failed">{data.modelsError}</div>
        ) : data.models === null ? (
          <div className="px-4 py-3 text-xs text-muted-foreground">Loading…</div>
        ) : data.models.length === 0 ? (
          <div className="px-4 py-3 text-xs text-muted-foreground italic">No models listed.</div>
        ) : (
          data.models.map((m, i) => (
            <ModelRow
              key={m.id}
              model={m}
              last={i === data.models!.length - 1}
            />
          ))
        )}
      </Section>

      {/* Keyboard shortcuts */}
      <Section icon={Keyboard} title="Keyboard Shortcuts">
        {SHORTCUTS.map((s, i) => (
          <ShortcutRow
            key={s.keys}
            keys={s.keys}
            description={s.description}
            last={i === SHORTCUTS.length - 1}
          />
        ))}
      </Section>

      {/* About */}
      <Section icon={Info} title="About">
        <Row label="App" value="AFK Dashboard" />
        <Row label="API" value="/api/*" mono />
        <Row label="Model tiers" value="sonnet · haiku · opus" last />
      </Section>

    </div>
  );
}
