/**
 * Hand focus back to the composer after a modal (the /model picker, a choice
 * dialog) closes.
 *
 * Invariant: the composer textarea is `disabled` while the command that opened
 * the modal is still in flight, and a disabled element cannot take focus. The
 * old `setTimeout(0)` focus() in the dialog fired before React re-enabled the
 * textarea, so focus fell to BODY. Instead the dialog records a request here
 * and the mounted composer satisfies it from an effect that runs once it is
 * enabled again (see `useComposerFocusRequest`).
 */
import { useEffect, useState, type RefObject } from 'react';

type Listener = () => void;
const listeners = new Set<Listener>();

/** A request older than this is dropped rather than stealing focus later. */
export const COMPOSER_FOCUS_TTL_MS = 10_000;

/**
 * Ask the mounted composer to take focus as soon as it is enabled.
 * Returns false when no composer is mounted (caller may restore focus itself).
 */
export function requestComposerFocus(): boolean {
  if (listeners.size === 0) return false;
  for (const l of listeners) l();
  return true;
}

/** Composer side: focus `ref` once a pending request meets an enabled textarea. */
export function useComposerFocusRequest(ref: RefObject<HTMLTextAreaElement | null>, enabled: boolean): void {
  const [requestedAt, setRequestedAt] = useState<number | null>(null);
  useEffect(() => {
    const listener = () => setRequestedAt(Date.now());
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);
  useEffect(() => {
    if (requestedAt === null) return;
    if (Date.now() - requestedAt > COMPOSER_FOCUS_TTL_MS) { setRequestedAt(null); return; }
    const el = ref.current;
    if (!enabled || !el || el.disabled) return;
    el.focus();
    setRequestedAt(null);
  }, [requestedAt, enabled, ref]);
}
