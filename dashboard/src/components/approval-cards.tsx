import { useState, useRef } from 'react';
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
  const submitting = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const answer = async (action: 'accept' | 'decline', content?: Record<string, unknown>) => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      await answerApproval({ requestId: id, response: { action, content } });
      // Invariant: return focus only after the approval write succeeds.
      onAnswered();
      document.querySelector<HTMLTextAreaElement>('[data-testid="composer-textarea"]')?.focus();
    } catch {
      setError('Failed to submit — try again');
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  const type = request.type ?? 'confirm';

  return (
    <div
      role="dialog"
      aria-label={request.title || 'Approval required'}
      aria-busy={busy}
      tabIndex={0}
      onKeyDown={e => {
        if (type !== 'confirm' || busy || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.key.toLowerCase() === 'y' || e.key.toLowerCase() === 'n') {
          e.preventDefault();
          void answer(e.key.toLowerCase() === 'y' ? 'accept' : 'decline');
        }
      }}
      className={cn(
        'rounded-lg border-2 border-yellow-500/60 bg-yellow-500/5 p-3 text-sm',
        'flex flex-col gap-2 focus-visible:outline-2 focus-visible:outline-ring [&_button:focus-visible]:outline-2 [&_button:focus-visible]:outline-ring',
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
            <p className="text-muted-foreground text-xs mt-0.5">
              {request.description}
            </p>
          )}
        </div>
        <button
          onClick={() => void answer('decline')}
          disabled={busy}
          className="shrink-0 text-muted-foreground hover:text-foreground"
          title="Dismiss"
          aria-label="Dismiss approval"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {type === 'number' && (
        <div className="flex gap-2">
          <input
            type="number"
            aria-label={request.title || 'Approval response'}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            disabled={busy}
            {...(request.questionMin !== undefined ? { min: request.questionMin } : {})}
            {...(request.questionMax !== undefined ? { max: request.questionMax } : {})}
            className={cn(
              'flex-1 rounded border border-input bg-background px-2 py-1 text-sm',
              'focus:outline-none focus:ring-1 focus:ring-ring',
            )}
          />
          <ActionButton
            onClick={() => {
              const n = Number(inputValue);
              if (isNaN(n)) return;
              if (request.questionMin !== undefined && n < request.questionMin) return;
              if (request.questionMax !== undefined && n > request.questionMax) return;
              void answer('accept', { number: n });
            }}
            disabled={
              busy ||
              inputValue === '' ||
              isNaN(Number(inputValue)) ||
              (request.questionMin !== undefined && Number(inputValue) < request.questionMin) ||
              (request.questionMax !== undefined && Number(inputValue) > request.questionMax)
            }
            label="Submit"
            variant="primary"
          />
        </div>
      )}

      {type === 'text' && (
        <div className="flex gap-2">
          <input
            type="text"
            aria-label={request.title || 'Approval response'}
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
        <p role="alert" className="text-xs text-foreground">{error}</p>
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


  const dismiss = (id: string) => {
    setDismissed((prev) => new Set([...prev, id]));
    onDismiss?.();
  };

  return (
    <div className="flex flex-col gap-2">
      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">{visible.length ? `Approval required: ${visible.map(a => a.request.title || a.request.message || 'Please respond').join('; ')}` : ''}</p>
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
