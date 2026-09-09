import { useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { apiFetch } from '@/lib/api';
import type { PendingApproval } from '@/types/api';

interface ApprovalCardsProps {
  approvals: PendingApproval[];
  onDismiss?: () => void;
}

interface ApproveBody {
  requestId: string;
  response: { action: 'accept' | 'decline'; content?: Record<string, unknown> };
}

async function answerApproval(body: ApproveBody): Promise<void> {
  await apiFetch('/api/approve', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** Renders a single approval card based on its type. */
function ApprovalCard({
  approval,
  onAnswered,
}: {
  approval: PendingApproval;
  onAnswered: () => void;
}) {
  const { id, request } = approval;
  const [inputValue, setInputValue] = useState(
    typeof request.questionDefault === 'string' ? request.questionDefault : '',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const answer = async (action: 'accept' | 'decline', content?: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await answerApproval({ requestId: id, response: { action, content } });
      onAnswered();
    } catch {
      setError('Failed to submit — try again');
    } finally {
      setBusy(false);
    }
  };

  const type = request.type ?? 'confirm';

  return (
    <div
      className={cn(
        'rounded-lg border-2 border-yellow-500/60 bg-yellow-500/5 p-3 text-sm',
        'flex flex-col gap-2',
      )}
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="h-4 w-4 text-yellow-500 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          {request.title && (
            <p className="font-semibold text-foreground">{request.title}</p>
          )}
          {request.message && (
            <p className="text-muted-foreground">{request.message}</p>
          )}
          {request.description && (
            <p className="text-muted-foreground/80 text-xs mt-0.5">
              {request.description}
            </p>
          )}
        </div>
        <button
          onClick={() => void answer('decline')}
          disabled={busy}
          className="shrink-0 text-muted-foreground hover:text-foreground"
          title="Dismiss"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {type === 'text' && (
        <div className="flex gap-2">
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            disabled={busy}
            className={cn(
              'flex-1 rounded border border-input bg-background px-2 py-1 text-sm',
              'focus:outline-none focus:ring-1 focus:ring-ring',
            )}
          />
          <ActionButton
            onClick={() => void answer('accept', { text: inputValue })}
            disabled={busy}
            label="Submit"
            variant="primary"
          />
        </div>
      )}

      {type === 'confirm' && (
        <div className="flex gap-2 justify-end">
          <ActionButton onClick={() => void answer('decline')} disabled={busy} label="No" variant="ghost" />
          <ActionButton onClick={() => void answer('accept')} disabled={busy} label="Yes" variant="primary" />
        </div>
      )}

      {(type === 'choice' || type === 'multi_choice') && (
        <div className="flex flex-wrap gap-1.5">
          {(request.choices ?? []).map((choice) => (
            <ActionButton
              key={choice}
              onClick={() => void answer('accept', { choice })}
              disabled={busy}
              label={choice}
              variant="outline"
            />
          ))}
        </div>
      )}

      {error && (
        <p className="text-xs text-red-400">{error}</p>
      )}
    </div>
  );
}

function ActionButton({
  onClick,
  disabled,
  label,
  variant,
}: {
  onClick: () => void;
  disabled: boolean;
  label: string;
  variant: 'primary' | 'ghost' | 'outline';
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'rounded px-3 py-1 text-xs font-medium transition-colors disabled:opacity-50',
        variant === 'primary' && 'bg-primary text-primary-foreground hover:bg-primary/90',
        variant === 'ghost' && 'text-muted-foreground hover:text-foreground hover:bg-accent',
        variant === 'outline' && 'border border-border hover:bg-accent',
      )}
    >
      {label}
    </button>
  );
}

/** Stack of pending approval/elicitation cards, sticky above the composer. */
export function ApprovalCards({ approvals, onDismiss }: ApprovalCardsProps) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const visible = approvals.filter((a) => !dismissed.has(a.id));
  if (visible.length === 0) return null;

  const dismiss = (id: string) => {
    setDismissed((prev) => new Set([...prev, id]));
    onDismiss?.();
  };

  return (
    <div className="flex flex-col gap-2">
      {visible.map((approval) => (
        <ApprovalCard
          key={approval.id}
          approval={approval}
          onAnswered={() => dismiss(approval.id)}
        />
      ))}
    </div>
  );
}
