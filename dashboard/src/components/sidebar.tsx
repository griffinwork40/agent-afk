import { cn } from '@/lib/utils';
import type { SessionSummary } from '@/types/api';
import { SessionCard } from './session-card';
import {
  MessageSquare,
  Brain,
  Calendar,
  Briefcase,
  Settings,
  PanelLeftClose,
  PanelLeft,
} from 'lucide-react';

type NavItem = 'sessions' | 'memory' | 'schedules' | 'jobs' | 'settings';

const navItems: { id: NavItem; label: string; icon: React.ReactNode }[] = [
  { id: 'sessions', label: 'Sessions', icon: <MessageSquare className="size-4" /> },
  { id: 'memory', label: 'Memory', icon: <Brain className="size-4" /> },
  { id: 'schedules', label: 'Schedules', icon: <Calendar className="size-4" /> },
  { id: 'jobs', label: 'Jobs', icon: <Briefcase className="size-4" /> },
  { id: 'settings', label: 'Settings', icon: <Settings className="size-4" /> },
];

export function Sidebar({
  sessions,
  pendingSessionIds,
  selectedSessionId,
  onSelectSession,
  activeNav,
  onNavChange,
  collapsed,
  onToggleCollapse,
}: {
  sessions: SessionSummary[];
  pendingSessionIds: Set<string>;
  selectedSessionId: string | null;
  onSelectSession: (id: string) => void;
  activeNav: NavItem;
  onNavChange: (nav: NavItem) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
}) {
  return (
    <aside
      className={cn(
        'flex h-full shrink-0 flex-col border-r bg-card transition-[width] duration-200',
        collapsed ? 'w-14' : 'w-72',
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
          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? (
            <PanelLeft className="size-4" />
          ) : (
            <PanelLeftClose className="size-4" />
          )}
        </button>
      </div>

      {/* Navigation */}
      <nav className="flex flex-col gap-0.5 p-2">
        {navItems.map((item) => (
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
          >
            {item.icon}
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
                  selected={selectedSessionId === s.id}
                  onSelect={onSelectSession}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
