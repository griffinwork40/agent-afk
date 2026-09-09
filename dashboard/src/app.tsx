import { useState } from 'react';
import { Sidebar } from './components/sidebar';
import { SessionDetailPlaceholder } from './components/session-detail-placeholder';
import { useSessions } from './hooks/use-sessions';
import { usePendingApprovals } from './hooks/use-pending-approvals';

type NavItem = 'sessions' | 'memory' | 'schedules' | 'jobs' | 'settings';

export function App() {
  const { sessions, loading } = useSessions();
  const { pendingSessionIds } = usePendingApprovals();

  const [activeNav, setActiveNav] = useState<NavItem>('sessions');
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const selectedSession = sessions.find((s) => s.id === selectedSessionId);

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar
        sessions={sessions}
        pendingSessionIds={pendingSessionIds}
        selectedSessionId={selectedSessionId}
        onSelectSession={setSelectedSessionId}
        activeNav={activeNav}
        onNavChange={setActiveNav}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed((c) => !c)}
      />

      <main className="flex flex-1 flex-col overflow-hidden">
        {/* Top bar */}
        <header className="flex h-12 shrink-0 items-center justify-between border-b px-4">
          <h1 className="text-sm font-medium text-muted-foreground">
            {activeNav === 'sessions' && 'Sessions'}
            {activeNav === 'memory' && 'Memory'}
            {activeNav === 'schedules' && 'Schedules'}
            {activeNav === 'jobs' && 'Background Jobs'}
            {activeNav === 'settings' && 'Settings'}
          </h1>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <kbd className="rounded border bg-secondary px-1.5 py-0.5 font-mono text-[10px]">
              ⌘K
            </kbd>
          </div>
        </header>

        {/* Content area */}
        <div className="flex-1 overflow-y-auto">
          {activeNav === 'sessions' && (
            <>
              {loading && !sessions.length && (
                <div className="flex h-full items-center justify-center">
                  <div className="flex flex-col items-center gap-2 text-muted-foreground">
                    <div className="size-6 animate-spin rounded-full border-2 border-current border-t-transparent" />
                    <span className="text-sm">Loading sessions...</span>
                  </div>
                </div>
              )}
              {!loading && sessions.length === 0 && (
                <div className="flex h-full items-center justify-center text-muted-foreground">
                  <p className="text-sm">No sessions found. Start one with <code className="rounded bg-secondary px-1 font-mono">afk web</code></p>
                </div>
              )}
              {selectedSession ? (
                <SessionDetailPlaceholder session={selectedSession} />
              ) : (
                sessions.length > 0 && (
                  <div className="flex h-full items-center justify-center text-muted-foreground">
                    <p className="text-sm">Select a session from the sidebar</p>
                  </div>
                )
              )}
            </>
          )}
          {activeNav === 'memory' && (
            <PlaceholderView title="Memory Browser" phase={3} />
          )}
          {activeNav === 'schedules' && (
            <PlaceholderView title="Schedules" phase={3} />
          )}
          {activeNav === 'jobs' && (
            <PlaceholderView title="Background Jobs" phase={3} />
          )}
          {activeNav === 'settings' && (
            <PlaceholderView title="Settings" phase={3} />
          )}
        </div>
      </main>
    </div>
  );
}

function PlaceholderView({ title, phase }: { title: string; phase: number }) {
  return (
    <div className="flex h-full items-center justify-center text-muted-foreground">
      <div className="text-center">
        <h2 className="text-lg font-medium">{title}</h2>
        <p className="mt-1 text-sm">Coming in Phase {phase}</p>
      </div>
    </div>
  );
}
