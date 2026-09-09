import { useState } from 'react';
import { Sidebar } from './components/sidebar';
import { CommandPalette } from './components/command-palette';
import { TranscriptView } from './components/transcript-view';
import { SessionMeter } from './components/session-meter';
import { useSessions } from './hooks/use-sessions';
import { usePendingApprovals } from './hooks/use-pending-approvals';
import { useTranscript } from './hooks/use-transcript';
import { useScrollPin } from './hooks/use-scroll-pin';

type NavItem = 'sessions' | 'memory' | 'schedules' | 'jobs' | 'settings';

export function App() {
  const { sessions, loading } = useSessions();
  const { pendingSessionIds } = usePendingApprovals();

  const [activeNav, setActiveNav] = useState<NavItem>('sessions');
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const selectedSession = sessions.find((s) => s.id === selectedSessionId);
  const { items, totals, status } = useTranscript(selectedSessionId);
  const { containerRef } = useScrollPin();

  const handleNavigate = (nav: string) => {
    setActiveNav(nav as NavItem);
  };

  return (
    <div className="flex h-screen overflow-hidden">
      <CommandPalette onNavigate={handleNavigate} />

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
          <div className="flex items-center gap-3">
            <h1 className="text-sm font-medium text-muted-foreground">
              {activeNav === 'sessions' && 'Sessions'}
              {activeNav === 'memory' && 'Memory'}
              {activeNav === 'schedules' && 'Schedules'}
              {activeNav === 'jobs' && 'Background Jobs'}
              {activeNav === 'settings' && 'Settings'}
            </h1>
            {activeNav === 'sessions' && selectedSession && (
              <StreamStatusDot status={status} />
            )}
          </div>
          <div className="flex items-center gap-3">
            {activeNav === 'sessions' && selectedSession && (
              <SessionMeter totals={totals} />
            )}
            <kbd className="rounded border bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              ⌘K
            </kbd>
          </div>
        </header>

        {/* Content area */}
        <div ref={containerRef} className="flex-1 overflow-y-auto">
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
                  <p className="text-sm">
                    No sessions found. Start one with{' '}
                    <code className="rounded bg-secondary px-1 font-mono">afk web</code>
                  </p>
                </div>
              )}
              {selectedSession && items.length > 0 ? (
                <TranscriptView items={items} totals={totals} />
              ) : selectedSession ? (
                <div className="flex h-full items-center justify-center text-muted-foreground">
                  <div className="flex flex-col items-center gap-2">
                    {status === 'connecting' || status === 'reconnecting' ? (
                      <>
                        <div className="size-5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                        <span className="text-sm">Connecting to session...</span>
                      </>
                    ) : (
                      <span className="text-sm">No transcript data</span>
                    )}
                  </div>
                </div>
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

function StreamStatusDot({ status }: { status: string }) {
  if (status === 'open') {
    return <span className="size-2 rounded-full bg-status-running" title="Live" />;
  }
  if (status === 'connecting' || status === 'reconnecting') {
    return <span className="size-2 animate-pulse rounded-full bg-status-blocked" title={status} />;
  }
  if (status === 'ended') {
    return <span className="size-2 rounded-full bg-muted-foreground" title="Session ended" />;
  }
  return null;
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
