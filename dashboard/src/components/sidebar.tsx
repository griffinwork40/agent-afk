import { cn } from '@/lib/utils';
import type { SessionSummary } from '@/types/api';
import { SessionCard } from './session-card';
import { Plus, PanelLeftClose, PanelLeft } from 'lucide-react';
import { listNavItems } from '@/lib/nav-registry';

export function Sidebar({
  sessions,
  pendingSessionIds,
  busySessionIds,
  selectedSessionId,
  onSelectSession,
  onResumeSession,
  activeNav,
  onNavChange,
  collapsed,
  onToggleCollapse,
  onNewSession,
  starting = false,
  runningSessionId,
}: {
  onNewSession?: () => void;
  starting?: boolean;
  runningSessionId?: string | null;
  sessions: SessionSummary[];
  pendingSessionIds: Set<string>;
  busySessionIds?: Set<string>;
  selectedSessionId: string | null;
  onSelectSession: (id: string) => void;
  /** Called when user clicks Resume on a readonly session card. */
  onResumeSession?: (sessionId: string) => void;
  activeNav: string;
  onNavChange: (nav: string) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
}) {
  return (
    <aside
      className={cn(
        'flex h-full shrink-0 flex-col border-r bg-card transition-[width] duration-200',
        collapsed ? 'w-72 md:w-14' : 'w-72',
        'max-w-[85vw]',
      )}
    >
      {/* Header */}
      <div className="flex h-12 items-center justify-between border-b px-3">
        {!collapsed && (
          <div className="flex items-center gap-2">
            <img src="/brand-mark.svg" alt="AFK" width={24} height={24} />
            <span className="text-sm font-semibold tracking-tight">AFK</span>
          </div>
        )}
        <button
          onClick={onToggleCollapse}
          className="hidden rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:block"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? (
            <PanelLeft className="size-4" />
          ) : (
            <PanelLeftClose className="size-4" />
          )}
        </button>
      </div>

      {onNewSession && (
        <button onClick={onNewSession} disabled={starting} title="Start a new chat"
          className="mx-2 mt-3 flex min-h-10 items-center justify-center gap-2 rounded-lg bg-brand px-2 text-sm font-medium text-primary-foreground disabled:opacity-60">
          <Plus className="size-4 shrink-0" />
          {!collapsed && (starting ? 'Starting…' : 'New chat')}
        </button>
      )}

      {/* Navigation */}
      <nav className="flex flex-col gap-0.5 p-2">
        {listNavItems().map((item) => (
          <button
            key={item.id}
            onClick={() => onNavChange(item.id)}
            className={cn(
              'flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors',
              activeNav === item.id
                ? 'bg-accent text-accent-foreground font-medium'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
            )}
            title={collapsed ? item.label : undefined}
            aria-label={item.label}
            aria-current={activeNav === item.id ? 'page' : undefined}
          >
            <item.icon className="size-4" aria-hidden="true" />
            {!collapsed && <span>{item.label}</span>}
          </button>
        ))}
      </nav>

      {/* Session list (visible only on Sessions nav + not collapsed) */}
      {activeNav === 'sessions' && !collapsed && (
        <div className="flex-1 overflow-y-auto border-t px-2 py-2">
          {sessions.length === 0 ? (
            <p className="px-2 py-4 text-center text-xs text-muted-foreground">
              No sessions found
            </p>
          ) : (
            <div className="flex flex-col gap-0.5">
              {sessions.map((s) => (
                <SessionCard
                  key={s.id}
                  session={s}
                  pendingSessionIds={pendingSessionIds}
                  busySessionIds={busySessionIds}
                  selected={selectedSessionId === s.id}
                  running={runningSessionId === s.id}
                  onSelect={onSelectSession}
                  onResume={onResumeSession}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
