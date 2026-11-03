import { useEffect, useRef, useState, useCallback } from 'react';
import { ArrowDown, SquarePen } from 'lucide-react';
import { Sidebar } from './components/sidebar';
import { getNavItem } from './lib/nav-registry';
import { CommandPalette } from './components/command-palette';
import { KeyboardShortcuts } from './components/keyboard-shortcuts';
import { SessionMeter } from './components/session-meter';
import { MemoryView } from './components/memory-view';
import { SchedulesView } from './components/schedules-view';
import { BgJobsView } from './components/bg-jobs-view';
import { HandoffsView } from './components/handoffs-view';
import { SettingsView } from './components/settings-view';
import { Composer } from './components/composer';
import { ApprovalCards } from './components/approval-cards';
import { MobileSidebar, HamburgerButton } from './components/mobile-sidebar';
import { ToastProvider, useToast } from './components/toast';
import { useSessions } from './hooks/use-sessions';
import { usePendingApprovals } from './hooks/use-pending-approvals';
import { useTranscript } from './hooks/use-transcript';
import { useScrollPin } from './hooks/use-scroll-pin';
import { useQueue } from './hooks/use-queue';
import { useCommandOutputs } from './hooks/use-command-outputs';
import { useSessionUrl } from './hooks/use-session-url';
import { SessionContent } from './components/session-content';
import { ChoiceDialog } from './components/choice-dialog';
import { CommandProgress } from './components/command-progress';
import { apiFetch, ApiError } from './lib/api';
import type { CommandResponse, ThinkingUiMode } from './types/command-wire';
import { useRewind } from './hooks/use-rewind';
import { useTabNotification } from './hooks/use-tab-notification';
import { sessionDisplayTitle } from './lib/session-title';


export function App() {
  return (
    <ToastProvider>
      <Dashboard />
    </ToastProvider>
  );
}

function Dashboard() {
  const { sessions: serverSessions, loading, refresh: refreshSessions } = useSessions();
  const [sessionUpdates, setSessionUpdates] = useState<Record<string, { model?: string; title?: string; titleExplicit?: boolean; thinkingUi?: ThinkingUiMode }>>({});
  const sessions = serverSessions.map((session) => ({ ...session, ...sessionUpdates[session.id] }));
  const { approvals, pendingSessionIds } = usePendingApprovals();
  const { toast } = useToast();

  const [activeNav, setActiveNav] = useState('sessions');
  const [selectedSessionId, setSelectedSessionId] = useSessionUrl();
  const [prefill, setPrefill] = useState<{ text: string; nonce: number; sessionId: string }>();
  const [starting, setStarting] = useState(false);
  const startingRef = useRef(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  const selectedSession = sessions.find((s) => s.id === selectedSessionId);
  const resetEpochs = useRef<Record<string, number>>({});
  const clearStartedAt = useRef<Record<string, number>>({});
  const pendingClearReset = useRef<Record<string, boolean>>({});
  const { items, totals, status, turnActive, liveTurns, choices, progress } = useTranscript(selectedSessionId, () => {
    if (!selectedSessionId) return;
    resetEpochs.current[selectedSessionId] = (resetEpochs.current[selectedSessionId] ?? 0) + 1;
    clearCmdItems(selectedSessionId, pendingClearReset.current[selectedSessionId]);
    pendingClearReset.current[selectedSessionId] = false;
    queue.clear();
    prevTurnsRef.current = 0;
    abortRef.current?.abort();
  });
  const { containerRef, scrollToBottom, isPinned, showScrollButton, hasNewContent, notifyNewContent } = useScrollPin();

  // Per-tab command outputs survive reload without sending local UI state to the server.
  const { itemsFor: cmdItemsFor, addItem: addCmdItem, clearItems: clearCmdItems } = useCommandOutputs();
  const cmdItems = cmdItemsFor(selectedSessionId);
  const [answeredChoice, setAnsweredChoice] = useState<string | null>(null);
  const activeChoice = status === 'open' && selectedSession?.mode === 'live'
    ? choices.find((choice) => `${selectedSessionId}:${choice.corrId}` !== answeredChoice) : undefined;
  useEffect(() => { setAnsweredChoice(null); setPrefill(undefined); setNewSessionCwd(undefined); }, [selectedSessionId]);
  useEffect(() => {
    if (answeredChoice && !choices.some((choice) => `${selectedSessionId}:${choice.corrId}` === answeredChoice)) {
      setAnsweredChoice(null);
    }
  }, [choices, selectedSessionId, answeredChoice]);


  // Auto-scroll when new transcript items arrive and user is pinned to the bottom.
  // When not pinned, arm the "New messages" pill so the user knows content arrived.
  // Layout effect: scroll in the same commit that appends a live draft, so the
  // draft is never painted below the fold (content-visibility:auto skips it).
  useEffect(() => {
    if (isPinned) scrollToBottom();
    else notifyNewContent();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, cmdItems.length]);
  useEffect(() => { scrollToBottom(); }, [selectedSessionId, scrollToBottom]);
  useEffect(() => { if (selectedSessionId) setActiveNav('sessions'); }, [selectedSessionId]);

  const handleNavigate = (nav: string) => {
    if (!getNavItem(nav)) return;
    setActiveNav(nav);
    setMobileSidebarOpen(false);
  };

  const handleSelectSession = (id: string) => {
    setSelectedSessionId(id);
    setActiveNav('sessions');
    setMobileSidebarOpen(false);
  };

  const isBusy = turnActive;

  // Retry / edit-and-resend via POST /api/sessions/:id/rewind.
  const { retry, editAndResend } = useRewind(selectedSessionId ?? '', isBusy);

  // Tab title badge + Web Notification when a turn finishes in a hidden tab.
  useTabNotification({
    liveTurns,
    sessionTitle: selectedSession?.title,
    isSelected: true,
  });

  // A refused rewind (409) must surface, never fail silently.
  const rewindFailed = (err: unknown) => {
    const message = err instanceof ApiError && typeof err.body?.['message'] === 'string' ? err.body['message'] : err instanceof Error ? err.message : '';
    toast(message ? `Could not rewind: ${message}` : 'Could not rewind', 'info');
  };

  const [selectedModel, setSelectedModel] = useState<string>();
  const currentModel = selectedSession?.model ?? selectedModel;
  // Server cwd received from the session create response; used to show the
  // folder chip on the welcome screen before the first turn completes and the
  // session list is refreshed with the real cwd from the ledger meta record.
  const [newSessionCwd, setNewSessionCwd] = useState<string | undefined>();

  const handleCommandOutput = (input: string, response: CommandResponse) => {
    if (!selectedSessionId) return;
    if (response.control.kind === 'clear') {
      queue.clear();
      prevTurnsRef.current = 0;
      // Preserve this confirmation only if its SSE boundary is still pending.
      pendingClearReset.current[selectedSessionId] =
        clearStartedAt.current[selectedSessionId] === (resetEpochs.current[selectedSessionId] ?? 0);
    }
    addCmdItem(selectedSessionId, input, response, items.length);
    const metadata = response.session;
    if (metadata) {
      setSessionUpdates((prev) => ({
        ...prev,
        [selectedSessionId]: {
          ...prev[selectedSessionId],
          ...(metadata.model !== undefined ? { model: metadata.model } : {}),
          ...(metadata.name !== undefined ? { title: metadata.name, titleExplicit: metadata.nameExplicit === true } : {}),
          ...(metadata.thinkingUi !== undefined ? { thinkingUi: metadata.thinkingUi } : {}),
        },
      }));
    }
  };

  /** Navigate to a session returned by /fork or /resume. */
  const handleNavigateToSession = useCallback((targetSessionId: string) => {
    setSelectedSessionId(targetSessionId);
    setActiveNav('sessions');
    // The new session is not in the polled list yet; refresh now rather than
    // leaving it shown as unknown/read-only for up to one poll interval.
    refreshSessions();
  }, [refreshSessions, setSelectedSessionId]);

  /** Handle /exit: deselect and refresh so the session shows as ended now. */
  const handleSessionEnded = useCallback(() => {
    // Deselect so the user sees the sidebar and picks their next session.
    setSelectedSessionId(null);
    refreshSessions();
  }, [refreshSessions, setSelectedSessionId]);

  /**
   * Resume a past session from the sidebar Resume button through the
   * dedicated resume route, then select the new live session. Errors are
   * surfaced as a notice rather than swallowed.
   */
  const handleResumeFromSidebar = useCallback(async (pastSessionId: string) => {
    try {
      const result = await apiFetch<{ session: { id: string } }>(
        `/api/sessions/${encodeURIComponent(pastSessionId)}/resume`,
        { method: 'POST' },
      );
      setSelectedSessionId(result.session.id);
      refreshSessions();
    } catch (err) {
      toast(err instanceof Error ? `Could not resume: ${err.message}` : 'Could not resume this session', 'info');
    }
  }, [toast, refreshSessions, setSelectedSessionId]);

  const handleNewSession = useCallback(async () => {
    if (startingRef.current) return;
    startingRef.current = true;
    setStarting(true);
    try {
      const result = await apiFetch<{ session: { id: string } }>('/api/sessions', {
        method: 'POST', body: JSON.stringify(selectedModel ? { model: selectedModel } : {}),
      });
      // Invariant: navigate only after creation succeeds; failed starts keep the current chat.
      setSelectedSessionId(result.session.id);
      setActiveNav('sessions');
      setMobileSidebarOpen(false);
      // Capture server cwd immediately so the welcome screen folder chip shows
      // before the first turn completes and refreshSessions updates the list.
      setNewSessionCwd((result.session as { cwd?: string }).cwd);
      await refreshSessions(); // the composer needs the new row; do not wait for the 5 s poll
    } catch (err) {
      toast(err instanceof Error ? `Could not start chat: ${err.message}` : 'Could not start chat', 'info');
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  }, [selectedModel, setSelectedSessionId, refreshSessions, toast]);

  // Abort controller ref: abort in-flight POSTs when the session changes.
  const abortRef = useRef<AbortController | null>(null);

  const submitPrompt = useCallback(async (text: string) => {
    if (!selectedSessionId) throw new Error('no session');
    const controller = new AbortController();
    abortRef.current = controller;
    await apiFetch(`/api/sessions/${selectedSessionId}/prompt`, {
      method: 'POST',
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });
  }, [selectedSessionId]);

  const queue = useQueue({
    submit: submitPrompt,
    isLive: selectedSession?.mode === 'live',
  });

  // Track the previous liveTurns value to detect new turn completions.
  const prevTurnsRef = useRef(0);

  // Clear the queue and abort in-flight POST when session changes; retain local history.
  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    queue.clear();
    prevTurnsRef.current = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- queue identity stable; selectedSessionId is the real dep
  }, [selectedSessionId]);

  // Flush the queue when a live turn completes.
  useEffect(() => {
    if (liveTurns > prevTurnsRef.current) {
      void queue.flush();
    }
    prevTurnsRef.current = liveTurns;
  }, [liveTurns, queue.flush]);

  const sidebarContent = (
    <Sidebar
      sessions={sessions}
      pendingSessionIds={pendingSessionIds}
      busySessionIds={isBusy && selectedSessionId ? new Set([selectedSessionId]) : undefined}
      selectedSessionId={selectedSessionId}
      onSelectSession={handleSelectSession}
      onResumeSession={(id) => void handleResumeFromSidebar(id)}
      activeNav={activeNav}
      onNavChange={handleNavigate}
      collapsed={sidebarCollapsed}
      runningSessionId={turnActive ? selectedSessionId : null}
      onNewSession={() => void handleNewSession()}
      starting={starting}
      onToggleCollapse={() => setSidebarCollapsed((c) => !c)}
    />
  );

  return (
    <div className="flex h-dvh overflow-hidden">
      <CommandPalette
        onNavigate={handleNavigate}
        sessions={sessions}
        onSelectSession={handleSelectSession}
        {...(selectedSession?.mode === 'live' && selectedSessionId
          ? { onInsertCommand: (text: string) => { setActiveNav('sessions'); setPrefill({ text, nonce: Date.now(), sessionId: selectedSessionId }); } }
          : {})}
      />
      <KeyboardShortcuts onNavigate={handleNavigate} />

      {/* Desktop sidebar */}
      <div className="hidden md:block">{sidebarContent}</div>

      {/* Mobile sidebar */}
      <MobileSidebar
        open={mobileSidebarOpen}
        onClose={() => setMobileSidebarOpen(false)}
      >
        <Sidebar sessions={sessions} pendingSessionIds={pendingSessionIds}
          busySessionIds={isBusy && selectedSessionId ? new Set([selectedSessionId]) : undefined}
          selectedSessionId={selectedSessionId} onSelectSession={handleSelectSession}
          onResumeSession={(id) => void handleResumeFromSidebar(id)} activeNav={activeNav}
          onNavChange={handleNavigate} collapsed={false} onToggleCollapse={() => undefined}
          runningSessionId={turnActive ? selectedSessionId : null}
          onNewSession={() => void handleNewSession()} starting={starting} />
      </MobileSidebar>

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Top bar */}
        <header className="flex min-h-14 shrink-0 items-center justify-between gap-2 border-b px-3 md:px-4">
          <div className="flex min-w-0 items-center gap-2">
            <HamburgerButton
              className="md:hidden"
              onClick={() => setMobileSidebarOpen(true)}
            />
            {activeNav === 'sessions' && selectedSession ? (
              <>
                <StreamStatusDot status={status} />
                <h1 className="min-w-0 truncate text-sm font-medium text-foreground" title={selectedSession.title ?? undefined}>
                  {sessionDisplayTitle(selectedSession, 'New session')}
                </h1>
                {selectedSession.model && (
                  <span className="hidden shrink-0 rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-secondary-foreground sm:inline-block" title="Session model">
                    {selectedSession.model}
                  </span>
                )}
              </>
            ) : (
              <h1 className="text-sm font-medium text-muted-foreground">
                {getNavItem(activeNav)?.title}
              </h1>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-3">
            {/* Phones: one-tap new chat (the sidebar button lives in the closed drawer). */}
            <button type="button" onClick={() => void handleNewSession()} disabled={starting}
              title="New chat" aria-label="New chat"
              className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-50 md:hidden">
              <SquarePen className="h-4 w-4" />
            </button>
            {activeNav === 'sessions' && selectedSession && (
              <SessionMeter totals={totals} className="hidden lg:flex" />
            )}
            {/* P1-9 cross-lane: text-foreground/70 gives ≥4.5:1 on bg-secondary (was text-muted-foreground = 4.17). */}
            <kbd className="hidden rounded border bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-foreground/70 sm:inline-block">
              ⌘K
            </kbd>
          </div>
        </header>

        {/* Content area */}
        <div className="relative flex flex-1 flex-col overflow-hidden">
          <div ref={containerRef} data-testid="transcript-scroll" tabIndex={0} aria-label="Conversation transcript" className="relative flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
            <div className="flex-1">
              {activeNav === 'sessions' && (
                <SessionContent
                  loading={loading}
                  sessions={sessions}
                  selectedSession={selectedSession}
                  items={items}
                  cmdItems={cmdItems}
                  totals={totals}
                  status={status}
                  turnActive={turnActive}
                  thinkingUi={selectedSession?.thinkingUi}
                  onNewSession={() => void handleNewSession()}
                  starting={starting}
                  onSuggest={(text) => { if (selectedSessionId) setPrefill({ text, nonce: Date.now(), sessionId: selectedSessionId }); }}
                  onRetry={() => { scrollToBottom(); void retry(lastUserText(items)).catch(rewindFailed); }}
                  onEdit={(text) => { scrollToBottom(); void editAndResend(text).catch(rewindFailed); }}
                  isBusy={isBusy}
                  currentModel={currentModel}
                  serverCwd={selectedSession?.cwd ?? newSessionCwd}
                />
              )}
              {activeNav === 'sessions' && selectedSession && status === 'open' &&
                <CommandProgress progress={progress} />}

              {activeNav === 'memory' && <MemoryView />}
              {activeNav === 'schedules' && <SchedulesView />}
              {activeNav === 'jobs' && <BgJobsView />}
              {activeNav === 'handoffs' && <HandoffsView />}
              {activeNav === 'settings' && <SettingsView />}
            </div>

          </div>
            {/* Invariant: only the transcript scrolls; turn controls stay in the viewport. */}
            {activeNav === 'sessions' && selectedSession && selectedSession.mode === 'live' && (
              <div className="relative shrink-0 pb-[env(safe-area-inset-bottom)]" data-testid="composer-dock">
                {showScrollButton && (
                  <div className="pointer-events-none absolute inset-x-0 bottom-full flex justify-center pb-2">
                    <button
                      onClick={scrollToBottom}
                      aria-label={hasNewContent ? 'New messages' : 'Jump to latest'}
                      className="pointer-events-auto flex items-center gap-1.5 whitespace-nowrap rounded-full bg-brand px-3 py-2 text-xs font-medium text-primary-foreground shadow-lg"
                    >
                      <ArrowDown className="size-3" />
                      {hasNewContent ? 'New messages' : 'Jump to latest'}
                    </button>
                  </div>
                )}
                {approvals.length > 0 && (
                  <ApprovalCards approvals={approvals} />
                )}
                <Composer
                  key={selectedSession.id}
                  sessionId={selectedSession.id}
                  prefill={prefill?.sessionId === selectedSession.id ? prefill : undefined}
                  sessionMode={selectedSession.mode}
                  isBusy={isBusy}
                  queue={queue}
                  onModelSelect={setSelectedModel}
                  currentModel={currentModel}
                  onPromptSent={scrollToBottom}
                  onCommandStart={(input) => {
                    scrollToBottom();
                    if (/^\/clear(?:\s|$)/.test(input)) {
                      clearStartedAt.current[selectedSession.id] = resetEpochs.current[selectedSession.id] ?? 0;
                    }
                  }}
                  onCommandOutput={handleCommandOutput}
                  onToast={(msg) => toast(msg, 'info')}
                  onNavigate={handleNavigateToSession}
                  onSessionEnded={handleSessionEnded}

                />
              </div>
            )}
        </div>
      </main>
      {activeNav === 'sessions' && selectedSessionId && activeChoice &&
        <ChoiceDialog key={`${selectedSessionId}:${activeChoice.corrId}`} sessionId={selectedSessionId}
          request={activeChoice} onAnswered={() => setAnsweredChoice(`${selectedSessionId}:${activeChoice.corrId}`)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------


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

/** The newest user prompt as displayed (the ledger's typed `input`). */
function lastUserText(items: readonly { kind: string; text?: string }[]): string | undefined {
  for (let i = items.length - 1; i >= 0; i--) if (items[i]!.kind === 'user') return items[i]!.text;
  return undefined;
}

