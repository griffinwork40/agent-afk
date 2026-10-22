/**
 * Main pane for the Sessions view: loading and empty states, and the
 * transcript with client-local command outputs interleaved at their anchors.
 */

import { TranscriptView } from './transcript-view';
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
}: {
  loading: boolean;
  sessions: SessionSummary[];
  selectedSession: SessionSummary | undefined;
  items: TranscriptItem[];
  cmdItems: CommandOutputItem[];
  totals: SessionTotals;
  status: string;
  turnActive: boolean;
  thinkingUi?: ThinkingUiMode;
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
  if (!loading && sessions.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <p className="text-sm">
          No sessions found. Start one with{' '}
          <code className="rounded bg-secondary px-1 font-mono">afk web</code>
        </p>
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
            <span className="text-sm">New session. Send a message to start.</span>
          ) : (
            <span className="text-sm">No transcript data</span>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="flex h-full items-center justify-center text-muted-foreground">
      <p className="text-sm">Select a session from the sidebar</p>
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
}: {
  sessionId: string;
  items: TranscriptItem[];
  cmdItems: CommandOutputItem[];
  totals: SessionTotals;
  turnActive: boolean;
  thinkingUi?: ThinkingUiMode;
}) {
  // Contract: outputs render at their anchor (see interleave-commands), and
  // only the first transcript segment carries the session meter.
  const segments = interleaveCommands(items, cmdItems);
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
