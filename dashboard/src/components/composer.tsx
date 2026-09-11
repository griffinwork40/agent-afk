import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { Send, Square } from 'lucide-react';
import { cn } from '@/lib/utils';
import { apiFetch } from '@/lib/api';
import type { SlashCommand } from '@/types/api';
import { SlashAutocomplete, handleAutocompleteKey } from './slash-autocomplete';
import { AtFilePopover } from './at-file-popover';
import { ModelSelector } from './model-selector';
import { QueuePanel } from './queue-panel';
import type { UseQueueResult } from '@/hooks/use-queue';

interface ComposerProps {
  sessionId: string;
  sessionMode: 'live' | 'readonly';
  isBusy: boolean;
  /** Queue for mid-run message management. */
  queue?: UseQueueResult;
  /** Called when the operator picks a model from the selector. */
  onModelSelect?: (modelId: string) => void;
  /** Currently selected model id (shown in the selector). */
  currentModel?: string;
}

/** Cached slash commands — cleared on page focus to pick up new skills. */
let commandsCache: SlashCommand[] | null = null;

/** Clear the cached command list so the next '/' keystroke re-fetches. */
export function clearCommandsCache(): void {
  commandsCache = null;
}

async function fetchCommands(): Promise<SlashCommand[]> {
  if (commandsCache) return commandsCache;
  const data = await apiFetch<{ commands: SlashCommand[] }>('/api/commands');
  commandsCache = data.commands;
  return commandsCache;
}

function getSlashQuery(text: string): string | null {
  if (!text.startsWith('/')) return null;
  const space = text.indexOf(' ');
  return space === -1 ? text.slice(1) : null; // only before first space
}

/** Main prompt composer — textarea + send/stop controls. */
export function Composer({
  sessionId,
  sessionMode,
  isBusy,
  queue,
  onModelSelect,
  currentModel,
}: ComposerProps) {
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [acActiveIdx, setAcActiveIdx] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const disabled = sessionMode === 'readonly';
  const slashQuery = getSlashQuery(text);
  const acVisible = slashQuery !== null && commands.length > 0;
  const acFiltered = acVisible
    ? commands.filter((c) => c.name.startsWith(slashQuery)).slice(0, 8)
    : [];

  // Clear the command cache when the tab regains focus so new skills are visible.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') clearCommandsCache();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  // Auto-resize textarea (1–5 rows)
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    const lineH = parseInt(getComputedStyle(ta).lineHeight) || 20;
    const maxH = lineH * 5;
    ta.style.height = `${Math.min(ta.scrollHeight, maxH)}px`;
  }, [text]);

  // Fetch commands when user first types '/'
  useEffect(() => {
    if (slashQuery !== null) {
      fetchCommands().then(setCommands).catch(() => undefined);
    }
  }, [slashQuery]);

  const submit = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || submitting || disabled) return;
    setSubmitting(true);
    try {
      await apiFetch(`/api/sessions/${sessionId}/prompt`, {
        method: 'POST',
        body: JSON.stringify({ text: trimmed }),
      });
      setText('');
    } catch {
      // Leave text intact so user can retry
    } finally {
      setSubmitting(false);
    }
  }, [text, submitting, disabled, sessionId]);

  const interrupt = useCallback(async () => {
    try {
      await apiFetch(`/api/sessions/${sessionId}/interrupt`, { method: 'POST' });
    } catch {
      // Best-effort
    }
  }, [sessionId]);

  const selectCommand = useCallback((name: string) => {
    setText(`/${name} `);
    setAcActiveIdx(0);
    textareaRef.current?.focus();
  }, []);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      const consumed = handleAutocompleteKey(
        e,
        acVisible,
        acFiltered.length,
        acActiveIdx,
        setAcActiveIdx,
        (idx) => {
          const cmd = acFiltered[idx];
          if (cmd) selectCommand(cmd.name);
        },
        () => setText((t) => t), // keep text, just close (slashQuery will become null)
      );
      if (consumed) { e.preventDefault(); return; }

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (isBusy && queue) {
          // When a turn is running, Enter queues instead of sending.
          const trimmed = text.trim();
          if (trimmed) {
            queue.enqueue(trimmed);
            setText('');
          }
        } else {
          void submit();
        }
      }
    },
    [acVisible, acFiltered, acActiveIdx, selectCommand, submit, isBusy, text, queue],
  );

  /** Insert text at the current cursor position. */
  const insertAtCursor = useCallback((token: string) => {
    const ta = textareaRef.current;
    if (!ta) { setText((t) => t + ' ' + token + ' '); return; }
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? start;
    const before = ta.value.slice(0, start);
    const after = ta.value.slice(end);
    const prefix = before.length > 0 && !/\s$/.test(before) ? ' ' : '';
    const next = before + prefix + token + ' ' + after;
    setText(next);
    // Defer cursor placement to after React re-renders.
    requestAnimationFrame(() => {
      const pos = start + prefix.length + token.length + 1;
      ta.setSelectionRange(pos, pos);
      ta.focus();
    });
  }, []);

  return (
    <>
      {/* Gradient fade — blends scroll content into the frosted composer */}
      <div className="pointer-events-none h-8 bg-gradient-to-t from-background/80 to-transparent" />
      <div
        className={cn(
          'relative flex flex-col gap-2',
          'border-t border-border/50 px-4 py-3',
          'backdrop-blur-xl bg-background/80',
          'shadow-[0_-4px_16px_-4px_rgba(0,0,0,0.1)]',
          disabled && 'opacity-50',
        )}
      >
        {queue && <QueuePanel queue={queue} />}
        <SlashAutocomplete
          query={slashQuery ?? ''}
          commands={commands}
          onSelect={selectCommand}
          visible={acVisible}
        />
        <div className="flex items-end gap-2">
          {/* Toolbar: @-file + model selector */}
          <div className="flex shrink-0 items-center gap-1">
            <AtFilePopover onInsert={insertAtCursor} />
            {onModelSelect && (
              <ModelSelector
                onSelect={onModelSelect}
                current={currentModel}
              />
            )}
          </div>
          <textarea
            ref={textareaRef}
            rows={1}
            value={text}
            disabled={disabled || submitting}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={disabled ? 'Read-only session' : 'Send a message… (/ for commands)'}
            className={cn(
              'flex-1 resize-none rounded-xl border border-input bg-background',
              'px-3 py-2 text-sm leading-5 shadow-sm',
              'placeholder:text-muted-foreground',
              'focus:outline-none focus:ring-2 focus:ring-ring',
              'disabled:cursor-not-allowed',
            )}
          />
          {isBusy ? (
            <button
              onClick={() => void interrupt()}
              title="Stop"
              className="shrink-0 flex items-center justify-center h-9 w-9 rounded-lg bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors"
            >
              <Square className="h-4 w-4 fill-current" />
            </button>
          ) : (
            <button
              onClick={() => void submit()}
              disabled={!text.trim() || submitting || disabled}
              title="Send"
              className={cn(
                'shrink-0 flex items-center justify-center h-9 w-9 rounded-lg',
                'bg-primary text-primary-foreground hover:bg-primary/90 transition-colors',
                'disabled:opacity-40 disabled:cursor-not-allowed',
              )}
            >
              <Send className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </>
  );
}
