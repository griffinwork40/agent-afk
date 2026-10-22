import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { Send, Square } from 'lucide-react';
import { cn } from '@/lib/utils';
import { apiFetch, ApiError } from '@/lib/api';
import {
  formatSlashCommandName,
  slashCommandMatchesQuery,
} from '@/lib/slash-command';
import type { SlashCommand } from '@/types/api';
import type { CommandResponse } from '@/types/command-wire';
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
  /** Called with command output to insert a client-local transcript item. */
  onCommandOutput?: (input: string, response: CommandResponse) => void;
  /** Called with a toast message (e.g. gated command reason). */
  onToast?: (message: string) => void;
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

/**
 * Normalise a command name to always include the leading slash.
 * Server data already has it; test fixtures may or may not.
 */
/** True when the typed first token already names the active suggestion. */
function isActiveSuggestionExact(text: string, activeName: string | undefined): boolean {
  if (activeName === undefined) return false;
  const token = text.trimStart().split(/\s+/)[0] ?? '';
  return normaliseName(token) === normaliseName(activeName);
}

function normaliseName(name: string): string {
  return name.startsWith('/') ? name : `/${name}`;
}

/** Look up a slash token (e.g. "/cost") against the command list. */
function findCommand(cmds: SlashCommand[], token: string): SlashCommand | undefined {
  const needle = normaliseName(token);
  return cmds.find((c) => normaliseName(c.name) === needle);
}

function getSlashQuery(text: string): string | null {
  if (!text.startsWith('/')) return null;
  const space = text.indexOf(' ');
  return space === -1 ? text.slice(1) : null; // only before first space
}

/** Human-readable error message from a failed /commands POST. */
function commandErrorMessage(err: unknown, token: string): string {
  if (!(err instanceof ApiError)) return String(err);
  const body = err.body;
  const errorCode = typeof body?.error === 'string' ? body.error : '';
  if (errorCode === 'command_gated') {
    const reason = typeof body?.reason === 'string' ? body.reason : '';
    return reason || (typeof body?.message === 'string' ? body.message : err.message);
  }
  if (errorCode === 'unknown_command') {
    const suggestion = typeof body?.suggestion === 'string' ? body.suggestion : '';
    return suggestion
      ? `Unknown command ${token}. Did you mean ${suggestion}?`
      : `Unknown command ${token}.`;
  }
  if (errorCode === 'session_busy') {
    return 'Session is busy — try again when the turn finishes.';
  }
  return typeof body?.message === 'string' ? body.message : err.message;
}

/** Main prompt composer — textarea + send/stop controls. */
export function Composer({
  sessionId,
  sessionMode,
  isBusy,
  queue,
  onModelSelect,
  currentModel,
  onCommandOutput,
  onToast,
}: ComposerProps) {
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [acActiveIdx, setAcActiveIdx] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const disabled = sessionMode === 'readonly';
  const slashQuery = getSlashQuery(text);
  const acVisible = slashQuery !== null && (commands?.length ?? 0) > 0;
  const acFiltered = acVisible
    ? commands
        .filter((c) => slashCommandMatchesQuery(c.name, slashQuery))
        .slice(0, 8)
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
      let cancelled = false;
      fetchCommands()
        .then((cmds) => { if (!cancelled) setCommands(cmds ?? []); })
        .catch(() => undefined);
      return () => { cancelled = true; };
    }
  }, [slashQuery]);

  const submitPrompt = useCallback(async (trimmed: string) => {
    await apiFetch(`/api/sessions/${sessionId}/prompt`, {
      method: 'POST',
      body: JSON.stringify({ text: trimmed }),
    });
  }, [sessionId]);

  /**
   * POST to /commands and handle the A6 control result.
   * Returns true if the caller should clear the composer text (normal case),
   * false when the control itself manages the text (e.g. prefill).
   */
  const submitCommand = useCallback(async (input: string, depth = 0): Promise<boolean> => {
    const response = await apiFetch<CommandResponse>(
      `/api/sessions/${sessionId}/commands`,
      { method: 'POST', body: JSON.stringify({ input }) },
    );
    onCommandOutput?.(input, response);

    // A6 control handling
    const { control } = response;
    if (control.kind === 'continue') {
      // no-op
    } else if (control.kind === 'prefill') {
      setText(control.message);
      return false; // caller must NOT clear — we just set the text
    } else if (control.kind === 'submit') {
      await submitPrompt(control.message);
    } else if (control.kind === 'rerun') {
      // Re-POST to /commands with the rerun string — depth-guarded to prevent
      // infinite recursion if a command keeps returning rerun controls.
      if (depth >= 3) {
        onToast?.('Command rerun limit reached');
        return true;
      }
      await submitCommand(control.input, depth + 1);
    } else if (control.kind === 'forward') {
      await submitPrompt(input);
    } else if (control.kind === 'exit') {
      onToast?.('Session ended in REPL terms — no effect on web (Stage 4)');
    }
    return true;
  }, [sessionId, onCommandOutput, onToast, submitPrompt]);

  const submit = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || submitting || disabled) return;
    setSubmitting(true);
    try {
      if (trimmed.startsWith('/')) {
        const cmds = await fetchCommands();
        const token = trimmed.split(/\s+/)[0]!;
        const cmd = findCommand(cmds, token);

        if (cmd?.kind === 'skill') {
          // Skill commands go to /prompt; when a turn is in flight, enqueue
          // instead of submitting immediately (mirrors the Enter handler).
          if (isBusy && queue) {
            queue.enqueue(trimmed);
          } else {
            await submitPrompt(trimmed);
          }
          setText('');
          return;
        }

        if (cmd?.kind === 'native' && cmd.web === 'gated') {
          // Show gate reason locally — no network call
          const reason = cmd.gateReason ?? `${normaliseName(cmd.name)} is not available on the web surface`;
          if (onToast) {
            onToast(reason);
          } else {
            console.warn('[composer] gated command dismissed:', reason);
          }
          return;
        }

        // Known native ok, alias, or unknown — let the server resolve it
        try {
          const shouldClear = await submitCommand(trimmed);
          if (shouldClear) setText('');
        } catch (err) {
          onToast?.(commandErrorMessage(err, token));
          // Leave text intact so user can retry
        }
        return;
      }

      // Plain text — send to /prompt
      await submitPrompt(trimmed);
      setText('');
    } catch {
      // Leave text intact so user can retry
    } finally {
      setSubmitting(false);
    }
  }, [text, submitting, disabled, submitPrompt, submitCommand, onToast]);

  const interrupt = useCallback(async () => {
    try {
      await apiFetch(`/api/sessions/${sessionId}/interrupt`, { method: 'POST' });
    } catch {
      // Best-effort
    }
  }, [sessionId]);

  const selectCommand = useCallback((name: string) => {
    setText(`${formatSlashCommandName(name)} `);
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
        isActiveSuggestionExact(text, acFiltered[acActiveIdx]?.name),
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
