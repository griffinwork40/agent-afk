/**
 * The one display rule for a session title, shared by the sidebar card and
 * the chat header.
 *
 * Contract: an explicit `/name` (`titleExplicit`) is shown EXACTLY as the
 * user typed it (after the server's slugify). Only a derived title is
 * humanized: a kebab/snake slug auto-generated from the first prompt
 * ("do-not-use-any-tools-write") reads as "Do not use any tools write".
 * Titles that already contain spaces (a first-message fallback) pass through.
 */
import type { SessionSummary } from '@/types/api';

export function humanizeTitle(title: string): string {
  if (/\s/.test(title)) return title;
  const words = title.replace(/[-_]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Display title for a session, or `fallback` when it has none yet. */
export function sessionDisplayTitle(
  session: Pick<SessionSummary, 'title' | 'titleExplicit'>,
  fallback: string,
): string {
  if (!session.title) return fallback;
  return session.titleExplicit ? session.title : humanizeTitle(session.title);
}
