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
import { SlashAutocomplete, handleAutocompleteKey, recordRecentCommand } from './slash-autocomplete';
import { AtFilePopover } from './at-file-popover';
import { ModelSelector } from './model-selector';
import { QueuePanel } from './queue-panel';
import type { UseQueueResult } from '@/hooks/use-queue';
import { useCommandControl } from '@/hooks/use-command-control';
import { useComposerHistory } from '@/hooks/use-composer-history';
import { useComposerDraft } from '@/hooks/use-composer-draft';
import { useComposerFocusRequest } from '@/lib/composer-focus';

interface ComposerProps {
  sessionId: string;
  sessionMode: 'live' | 'readonly';
  isBusy: boolean;
  /** Queue for mid-run message management. */
  queue?: UseQueueResult;
  /** Called with the authoritative model after a successful /model response. */
  onModelSelect?: (modelId: string) => void;
  /** Currently selected model id (shown in the selector). */
  currentModel?: string;
  /** Called with command output to insert a client-local transcript item. */
  onCommandOutput?: (input: string, response: CommandResponse) => void;
  onCommandStart?: (input: string) => void;
  /** Called just before this tab sends a prompt (the view re-pins to the bottom). */
  onPromptSent?: () => void;
  /** Called with a toast message (e.g. gated command reason). */
  onToast?: (message: string) => void;
  /** Called when a /fork or /resume produces a navigate control. */
  onNavigate?: (targetSessionId: string) => void;
  /** Called when /exit marks the session as ended. */
  onSessionEnded?: () => void;
  /** Optional suggestion chips injected by the layout lane. */
  suggestions?: string[];
  /** Welcome-screen suggestion: replaces the draft and focuses (new nonce = re-apply). */
  prefill?: { text: string; nonce: number };
}

/** Cached slash commands — cleared on page focus to pick up new skills. */
let commandsCache: SlashCommand[] | null = null;

/** Clear the cached command list so the next '/' keystroke re-fetches. */
export function clearCommandsCache(): void {
  commandsCache = null;
}

export async function fetchCommands(): Promise<SlashCommand[]> {
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
  onCommandStart,
  onPromptSent,
  onToast,
  onNavigate,
  onSessionEnded,
  suggestions,
  prefill,
}: ComposerProps) {
  const draft = useComposerDraft(sessionId);
  const [text, setText] = useState(() => draft.load());
  const [submitting, setSubmitting] = useState(false);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [acActiveIdx, setAcActiveIdx] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lifetimeRef = useRef({ active: true });
  const history = useComposerHistory(sessionId);

  useEffect(() => {
    const lifetime = { active: true };
    lifetimeRef.current = lifetime;
    // Restore draft for the new session.
    setText(draft.load());
    return () => { lifetime.active = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Welcome-screen suggestion chip → composer text. Declared after the
  // session-restore effect so a prefill for a just-selected session wins over
  // the (empty) restored draft; the draft-save effect below then persists it.
  useEffect(() => {
    if (prefill) { setText(prefill.text); textareaRef.current?.focus(); }
  }, [prefill]);

  // Persist draft on every text change.
  useEffect(() => {
    draft.save(text);
  }, [text, draft]);

  const disabled = sessionMode === 'readonly';
  // A closed modal (e.g. the /model picker) hands focus back once enabled.
  useComposerFocusRequest(textareaRef, !disabled && !submitting);
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
    onPromptSent?.();
    await apiFetch(`/api/sessions/${sessionId}/prompt`, {
      method: 'POST',
      body: JSON.stringify({ text: trimmed }),
    });
  }, [sessionId, onPromptSent]);

  const { handleControl } = useCommandControl({
    sessionId,
    setText,
    onNavigate,
    onSessionEnded,
    onToast,
  });

  /**
   * POST to /commands and handle the CommandControl result via useCommandControl.
   * Returns true if the caller should clear the composer text (normal case),
   * false when the control itself manages the text (e.g. prefill).
   */
  const submitCommand = useCallback(async (input: string, depth = 0): Promise<boolean> => {
    const lifetime = lifetimeRef.current;
    onCommandStart?.(input);
    const response = await apiFetch<CommandResponse>(
      `/api/sessions/${sessionId}/commands`,
      { method: 'POST', body: JSON.stringify({ input }) },
    );
    // Navigating away must not clear the newly selected session/queue when a
    // delayed response from the old composer eventually arrives.
    if (!lifetime.active) return false;
    onCommandOutput?.(input, response);
    if (response.session?.model) onModelSelect?.(response.session.model);
    return handleControl(response.control, input, depth);
  }, [sessionId, onCommandStart, onCommandOutput, onModelSelect, handleControl]);

  const selectModel = useCallback(async (modelId: string) => {
    if (disabled || submitting || isBusy || modelId === currentModel) return;
    setSubmitting(true);
    try {
      await submitCommand(`/model ${modelId}`);
    } catch (err) {
      onToast?.(commandErrorMessage(err, '/model'));
    } finally {
      setSubmitting(false);
    }
  }, [disabled, submitting, isBusy, currentModel, submitCommand, onToast]);

  const submit = useCallback(async (overrideText?: string) => {
    const trimmed = (overrideText ?? text).trim();
    if (!trimmed || submitting || disabled) return;
    setSubmitting(true);
    try {
      if (trimmed.startsWith('/')) {
        const cmds = await fetchCommands();
        const token = trimmed.split(/\s+/)[0]!;
        recordRecentCommand(token);
        const cmd = findCommand(cmds, token);

        if (cmd?.kind === 'skill') {
          // Skill commands go to /prompt; when a turn is in flight, enqueue
          // instead of submitting immediately (mirrors the Enter handler).
          if (isBusy && queue) {
            queue.enqueue(trimmed);
          } else {
            await submitPrompt(trimmed);
          }
          history.push(trimmed);
          setText('');
          draft.clear();
          return;
        }

        if (cmd?.kind === 'native' && cmd.web === 'gated') {
          // Show gate reason locally — no network call.
          const reason = cmd.gateReason ?? `${normaliseName(cmd.name)} is not available on the web surface`;
          if (onToast) {
            onToast(reason);
          } else {
            console.warn('[composer] gated command dismissed:', reason);
          }
          return;
        }

        try {
          const shouldClear = await submitCommand(trimmed);
          if (shouldClear) {
            history.push(trimmed);
            setText('');
            draft.clear();
          }
        } catch (err) {
          onToast?.(commandErrorMessage(err, token));
        }
        return;
      }

      await submitPrompt(trimmed);
      history.push(trimmed);
      setText('');
      draft.clear();
    } catch {
      // Leave text intact so user can retry
    } finally {
      setSubmitting(false);
    }
  }, [text, submitting, disabled, submitPrompt, submitCommand, onToast, history, draft, isBusy, queue]);

  const interrupt = useCallback(async () => {
    try {
      await apiFetch(`/api/sessions/${sessionId}/interrupt`, { method: 'POST' });
    } catch {
      // Best-effort
    }
  }, [sessionId]);

  const selectCommand = useCallback((name: string) => {
    recordRecentCommand(name);
    setText(`${formatSlashCommandName(name)} `);
    setAcActiveIdx(0);
    textareaRef.current?.focus();
  }, []);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // Escape while busy → interrupt.
      if (e.key === 'Escape' && isBusy) {
        e.preventDefault();
        void interrupt();
        return;
      }

      // Cmd/Ctrl+. → interrupt.
      if (e.key === '.' && (e.metaKey || e.ctrlKey) && isBusy) {
        e.preventDefault();
        void interrupt();
        return;
      }

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
        () => setText((t) => t),
        isActiveSuggestionExact(text, acFiltered[acActiveIdx]?.name),
      );
      if (consumed) { e.preventDefault(); return; }

      // Up/down arrow — history navigation (when autocomplete is not visible).
      if (!acVisible && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        const ta = textareaRef.current;
        const selStart = ta?.selectionStart ?? 0;
        const next = history.navigate(e.key, text, selStart);
        if (next !== null) {
          e.preventDefault();
          setText(next);
          // Place caret at end after render.
          requestAnimationFrame(() => {
            const t = textareaRef.current;
            if (t) t.setSelectionRange(t.value.length, t.value.length);
          });
          return;
        }
      }

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (isBusy && queue) {
          const trimmed = text.trim();
          if (trimmed) {
            queue.enqueue(trimmed);
            setText('');
            draft.clear();
          }
        } else {
          void submit();
        }
      }
    },
    [acVisible, acFiltered, acActiveIdx, selectCommand, submit, isBusy, text, queue,
     interrupt, history, draft],
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
        {/* Suggestion chips from layout lane (additive prop). */}
        {suggestions && suggestions.length > 0 && !text && !isBusy && (
          <div className="flex flex-wrap gap-1.5">
            {suggestions.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => void submit(s)}
                className={cn(
                  'rounded-full border border-border px-2.5 py-0.5 text-xs',
                  'text-muted-foreground hover:text-foreground hover:bg-secondary',
                  'transition-colors',
                )}
              >
                {s}
              </button>
            ))}
          </div>
        )}
        <SlashAutocomplete
          query={slashQuery ?? ''}
          commands={commands}
          onSelect={selectCommand}
          visible={acVisible}
        />
        {/*
         * Invariant: exactly ONE textarea exists in the DOM at all times —
         * one source of truth for value, focus, history, and draft state.
         *
         * Layout strategy (CSS only, no JS breakpoint detection):
         *   Mobile (<sm / 640 px): two-row grid.
         *     Row 1: [textarea] [send/stop]   — textarea fills available width.
         *     Row 2: [toolbar (@ + model)]    — spans full width below.
         *   Desktop (sm+): single row.
         *     [toolbar] [textarea] [send/stop] — toolbar shrinks, textarea fills.
         *
         * grid-template-areas drives the reorder so the textarea DOM node is
         * declared once and CSS places it in the right cell per breakpoint.
         * On 390 px: total width 390 − (2×16 px padding) − (2 px border) − 8 px gap
         *            − 36 px button = ~312 px for textarea → well above 200 px floor.
         */}
        <div
          className={cn(
            // Mobile: 2-row grid. "ta" area top-left, "btn" top-right, "bar" bottom span-2.
            'grid gap-x-2 gap-y-1.5',
            '[grid-template-areas:"ta_btn"_"bar_bar"]',
            '[grid-template-columns:1fr_auto]',
            // sm+: single row. "bar" left, "ta" middle, "btn" right.
            'sm:[grid-template-areas:"bar_ta_btn"]',
            'sm:[grid-template-columns:auto_1fr_auto]',
          )}
        >
          {/* Textarea — grid area "ta" */}
          <textarea
            ref={textareaRef}
            rows={1}
            data-testid="composer-textarea"
            value={text}
            disabled={disabled || submitting}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              disabled
                ? 'Read-only session'
                : isBusy
                  ? 'Running… (Esc or ⌘. to stop, Enter to queue)'
                  : 'Send a message… (/ for commands)'
            }
            className={cn(
              '[grid-area:ta] self-end',
              'w-full resize-none rounded-xl border border-input bg-background',
              'px-3 py-2 text-sm leading-5 shadow-sm',
              'placeholder:text-muted-foreground',
              'focus:outline-none focus:ring-2 focus:ring-ring',
              'disabled:cursor-not-allowed',
            )}
          />

          {/* Send / Stop button — grid area "btn" */}
          {isBusy ? (
            <button
              onClick={() => void interrupt()}
              title="Stop (Esc or ⌘.)"
              className="[grid-area:btn] self-end shrink-0 flex items-center justify-center h-9 w-9 rounded-lg bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors"
            >
              <Square className="h-4 w-4 fill-current" />
            </button>
          ) : (
            <button
              onClick={() => void submit()}
              disabled={!text.trim() || submitting || disabled}
              title="Send"
              className={cn(
                '[grid-area:btn] self-end shrink-0 flex items-center justify-center h-9 w-9 rounded-lg',
                'bg-primary text-primary-foreground hover:bg-primary/90 transition-colors',
                'disabled:opacity-40 disabled:cursor-not-allowed',
              )}
            >
              <Send className="h-4 w-4" />
            </button>
          )}

          {/* Toolbar (@-file + model selector) — grid area "bar" */}
          <div className="[grid-area:bar] flex shrink-0 items-center gap-1 self-end">
            <AtFilePopover onInsert={insertAtCursor} />
            {onModelSelect && (
              <ModelSelector
                onSelect={(model) => void selectModel(model)}
                current={currentModel}
                disabled={disabled || submitting || isBusy}
              />
            )}
          </div>
        </div>
      </div>
    </>
  );
}
