/**
 * Browser-safe mirror of src/web-server/shared/command-wire.ts.
 *
 * No Node.js imports. Used by dashboard components to type the command API
 * response without importing server-side code.
 */

/** Every block carries a plain-text fallback for old clients and clipboard copy. */
interface CommandOutputBase {
  text: string;
  ansi: string;
}

export type CommandOutputBlock = CommandOutputBase & (
  | { kind?: 'text' }
  | { kind: 'table'; title?: string; columns: string[]; rows: string[][] }
  | { kind: 'keyValue'; title?: string; entries: Array<{ key: string; value: string }> }
  | { kind: 'diff'; diff: string; fileName?: string }
  | { kind: 'list'; title?: string; items: Array<{ text: string; description?: string }> }
  | { kind: 'link'; url: string; label: string }
);

/**
 * Wire response for `POST /api/sessions/:id/commands`.
 */
export interface CommandResponse {
  blocks: CommandOutputBlock[];
  control: CommandControl;
  /** Authoritative session metadata after a successful control operation. */
  session?: { model?: string; name?: string; thinkingUi?: ThinkingUiMode };
}

/** Display-only preference; hiding thinking never removes transcript data. */
export type ThinkingUiMode = 'summary' | 'live' | 'digest' | 'off';

/** Normalised SlashResult plus explicit successful conversation reset. */
export type CommandControl =
  | { kind: 'continue' }
  | { kind: 'clear' }
  | { kind: 'exit' }
  | { kind: 'navigate'; sessionId: string }
  | { kind: 'forward' }
  | { kind: 'rerun'; input: string }
  | { kind: 'submit'; message: string }
  | { kind: 'prefill'; message: string };
