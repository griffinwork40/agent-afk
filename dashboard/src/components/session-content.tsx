/**
 * Main pane for the Sessions view: loading and empty states, and the
 * transcript with client-local command outputs interleaved at their anchors.
 */

import { TranscriptView, newestRewindIds } from './transcript-view';
import { CommandOutput } from './command-output';
import { interleaveCommands } from '@/lib/interleave-commands';
import type { CommandOutputItem } from '@/hooks/use-command-outputs';
import type { SessionSummary } from '@/types/api';
import type { TranscriptItem } from '@/lib/ledger-adapter';
import type { SessionTotals } from './session-meter';
import type { ThinkingUiMode } from '@/types/command-wire';

export function SessionContent({
  loading,
  sessions,
  selectedSession,
  items,
  cmdItems,
  totals,
  status,
  turnActive,
  thinkingUi,
  onNewSession,
  starting,
  onSuggest,
  onRetry,
  onEdit,
  isBusy,
  currentModel,
  serverCwd,
}: {
  onNewSession?: () => void;
  starting?: boolean;
  onSuggest?: (text: string) => void;
  loading: boolean;
  sessions: SessionSummary[];
  selectedSession: SessionSummary | undefined;
  items: TranscriptItem[];
  cmdItems: CommandOutputItem[];
  totals: SessionTotals;
  status: string;
  turnActive: boolean;
  thinkingUi?: ThinkingUiMode;
  onRetry?: () => void;
  onEdit?: (text: string) => void;
  isBusy?: boolean;
  /** Model alias/name for the welcome screen (from server default or user selection). */
  currentModel?: string;
  /**
   * Server cwd from the session create response or the selected session.
   * Passed explicitly so the folder chip on the welcome screen is visible
   * immediately after a new session is created, before the first turn writes
   * the ledger meta record that populates session.cwd via listWebSessions.
   */
  serverCwd?: string;
}) {
  if (loading && !sessions.length) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex flex-col items-center gap-2 text-muted-foreground">
          <div className="size-6 animate-spin rounded-full border-2 border-current border-t-transparent" />
          <span className="text-sm">Loading sessions...</span>
        </div>
      </div>
    );
  }

  if (selectedSession && (items.length > 0 || cmdItems.length > 0)) {
    return (
      <TranscriptWithCommands
        sessionId={selectedSession.id}
        items={items}
        cmdItems={cmdItems}
        totals={totals}
        turnActive={turnActive}
        thinkingUi={thinkingUi}
        onRetry={onRetry}
        onEdit={onEdit}
        isBusy={isBusy}
      />
    );
  }
  if (selectedSession) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <div className="flex flex-col items-center gap-2">
          {status === 'connecting' || status === 'reconnecting' ? (
            <>
              <div className="size-5 animate-spin rounded-full border-2 border-current border-t-transparent" />
              <span className="text-sm">Connecting to session...</span>
            </>
          ) : selectedSession.mode === 'live' ? (
            <div className="mx-auto w-full max-w-xl px-5 py-10 text-center">
              <h2 className="text-2xl font-semibold tracking-tight text-foreground">What can we work on?</h2>
              <WorkspaceChips cwd={selectedSession.cwd ?? serverCwd} model={currentModel} />
              <p className="mt-3 text-sm leading-relaxed">Ask a question, explore your project, or turn an idea into working code.</p>
              <div className="mt-6 grid gap-3 sm:grid-cols-2">
                {[
                  ['Explore this project', 'Give me a concise overview of this project and its architecture.'],
                  ['Find a bug', 'Help me investigate a bug. Ask me what is going wrong first.'],
                  ['Plan a feature', 'Help me plan a new feature. Ask me what I want to build.'],
                  ['Review my changes', 'Review my current changes for correctness and potential risks.'],
                ].map(([label, text]) => (
                  <button key={label} onClick={() => onSuggest?.(text!)}
                    className="rounded-xl border bg-card p-4 text-left text-sm font-medium text-foreground transition-colors hover:border-brand/60 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
                    {label}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <span className="text-sm">No transcript data</span>
          )}
        </div>
      </div>
    );
  }
  // Derive working folder from any available session cwd.
  // Prefer serverCwd (from the create response or selected session) so the
  // folder chip shows immediately on the welcome screen without waiting for
  // the ledger meta record to propagate through listWebSessions.
  const anyCwd = serverCwd ?? sessions.find((s) => s.cwd)?.cwd;
  const folderName = folderNameOf(anyCwd);

  return (
    <div className="flex h-full items-center justify-center text-muted-foreground">
      <div className="max-w-lg px-6 py-12 text-center">
        <img src="/brand-mark.svg" alt="" className="mx-auto mb-6 size-12" />
        <h2 className="text-3xl font-semibold tracking-tight text-foreground">Your next idea starts here</h2>
        {(folderName ?? currentModel) && (
          <p className="mt-2 flex items-center justify-center gap-2 text-xs text-muted-foreground">
            {folderName && (
              <span className="rounded bg-secondary px-1.5 py-0.5 font-mono text-foreground/70">{folderName}</span>
            )}
            {currentModel && (
              <span className="rounded bg-secondary px-1.5 py-0.5 font-mono text-foreground/70">{currentModel}</span>
            )}
          </p>
        )}
        <p className="mt-4 text-sm leading-relaxed">Chat with an agent that can explore your project, explain code, and help you get things done. You stay in control.</p>
        <button onClick={onNewSession} disabled={starting}
          className="mt-7 min-h-11 rounded-xl bg-brand px-6 text-sm font-semibold text-primary-foreground transition-colors hover:bg-brand/90 disabled:opacity-60">
          {starting ? 'Starting…' : 'New chat'}
        </button>
        {sessions.length > 0 && <p className="mt-4 text-xs">Or continue a conversation from the sidebar.</p>}
      </div>
    </div>
  );
}

/**
 * Renders SSE transcript items interleaved with client-local command output
 * items in insertion order. Command outputs appear after the transcript items
 * that were visible when the command ran (they are appended in real time).
 */
function TranscriptWithCommands({
  sessionId,
  items,
  cmdItems,
  totals,
  turnActive,
  thinkingUi,
  onRetry,
  onEdit,
  isBusy,
}: {
  sessionId: string;
  items: TranscriptItem[];
  cmdItems: CommandOutputItem[];
  totals: SessionTotals;
  turnActive: boolean;
  thinkingUi?: ThinkingUiMode;
  onRetry?: () => void;
  onEdit?: (text: string) => void;
  isBusy?: boolean;
}) {
  // Contract: outputs render at their anchor (see interleave-commands), and
  // only the first transcript segment carries the session meter.
  const segments = interleaveCommands(items, cmdItems);
  // Rewind targets span segments: only the newest prompt/answer overall.
  const rewindIds = newestRewindIds(items);
  const leadsWithCommand = segments[0]?.kind !== 'transcript';
  return (
    <div className="flex flex-col gap-0 max-w-4xl mx-auto w-full px-1">
      {leadsWithCommand && (
        <TranscriptView sessionId={sessionId} items={[]} totals={totals} hideEmptyState />
      )}
      {segments.map((seg, i) =>
        seg.kind === 'transcript' ? (
          <TranscriptView
            key={`t-${i}`}
            sessionId={sessionId}
            items={seg.items}
            {...(i === 0 ? { totals } : {})}
            turnActive={turnActive && i === segments.length - 1}
            hideEmptyState
            thinkingUi={thinkingUi}
            onRetry={onRetry}
            onEdit={onEdit}
            isBusy={isBusy}
            rewindIds={rewindIds}
          />
        ) : (
          <div key={`c-${seg.item.key}`} className="px-2 py-3">
            <CommandOutput input={seg.item.input} blocks={seg.item.response.blocks} />
          </div>
        ),
      )}
    </div>
  );
}

/** Repo/folder name of a cwd (last path segment), or undefined. */
function folderNameOf(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  const trimmed = cwd.replace(/[/\\]+$/, '');
  return trimmed.split(/[/\\]/).pop() || cwd;
}

/** Folder (repo name) + model chips for an empty session's welcome screen. */
export function WorkspaceChips({ cwd, model }: { cwd?: string; model?: string }) {
  const folder = folderNameOf(cwd);
  if (!folder && !model) return null;
  return (
    <p className="mt-2 flex items-center justify-center gap-2 text-xs text-muted-foreground" data-testid="workspace-chips">
      {folder && <span className="rounded bg-secondary px-1.5 py-0.5 font-mono text-foreground/70" title={cwd} data-testid="folder-chip">{folder}</span>}
      {model && <span className="rounded bg-secondary px-1.5 py-0.5 font-mono text-foreground/70" data-testid="model-chip">{model}</span>}
    </p>
  );
}
