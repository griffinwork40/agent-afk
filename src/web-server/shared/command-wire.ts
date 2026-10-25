/**
 * Server-side wire types for the command execution API.
 *
 * Kept in a sub-directory with NO imports from `cli/slash` so it can be
 * imported by both server routes and (via the dashboard mirror) the browser.
 */

/** Browser-safe mirror of OutputBlock; absent kind accepts legacy text responses. */
export type CommandOutputBlock = { text: string; ansi: string } & (
  | { kind?: 'text' }
  | { kind: 'table'; title?: string; columns: string[]; rows: string[][] }
  | { kind: 'keyValue'; title?: string; entries: Array<{ key: string; value: string }> }
  | { kind: 'diff'; diff: string; fileName?: string }
  | { kind: 'list'; title?: string; items: Array<{ text: string; description?: string }> }
  | { kind: 'link'; url: string; label: string }
);

/**
 * Wire response for `POST /api/sessions/:id/commands`.
 *
 * `control` encodes the `SlashResult` variant normalised to a plain object
 * so the browser can act on it without importing CLI types.
 */
export interface CommandResponse {
  blocks: CommandOutputBlock[];
  control: CommandControl;
  /** Authoritative owner metadata after successful session controls. */
  session?: { model?: string; name?: string; nameExplicit?: boolean; thinkingUi?: 'summary' | 'live' | 'digest' | 'off' };
}

/** Normalised `SlashResult` for the wire. All variants represented. */
export type CommandControl =
  | { kind: 'continue' }
  | { kind: 'clear' }
  | { kind: 'exit' }
  | { kind: 'navigate'; sessionId: string }
  | { kind: 'forward' }
  | { kind: 'rerun'; input: string }
  | { kind: 'submit'; message: string }
  | { kind: 'prefill'; message: string };
