/**
 * Thin-facade API methods extracted from terminal-compositor.ts.
 * Follows the free-functions-on-host pattern used by sibling satellites
 * (input-mode.ts, autocomplete.ts, ghost.ts, render.ts, etc.):
 * TerminalCompositor owns all state; these functions read/mutate the
 * narrow {@link ApiHost} slice it passes as `self`. No behaviour change —
 * bodies are byte-for-byte moves with `this.` rewritten to `self.`.
 */

import type { InputCoreState } from './input-core.js';
import { InputCore } from './input-core.js';
import type { ImageAttachment } from './input/attachments.js';
import type { SubmissionPayload, CompositorInputMode, PickerController } from './terminal-compositor.types.js';
import type { InputModeHost } from './terminal-compositor.input-mode.js';
import * as InputMode from './terminal-compositor.input-mode.js';
import * as Paste from './terminal-compositor.paste.js';
import * as QueuedAccess from './terminal-compositor.queued-access.js';
import type { QueuedSnapshot } from './terminal-compositor.queued-access.js';
import * as Render from './terminal-compositor.render.js';
import type { RenderHost } from './terminal-compositor.render.js';
import * as Autocomplete from './terminal-compositor.autocomplete.js';
import type { AutocompleteHost } from './terminal-compositor.autocomplete.js';
import * as Ghost from './terminal-compositor.ghost.js';
import * as InputDispatch from './terminal-compositor.input-dispatch.js';
import type { KeyDispatchHost } from './terminal-compositor.input-dispatch.js';

/**
 * Narrowest TerminalCompositor state slice the api free functions touch.
 *
 * Defined as a type alias intersection so the overlapping mutable/readonly
 * field variants from the four sub-host interfaces (InputModeHost, RenderHost,
 * AutocompleteHost, KeyDispatchHost) merge correctly. TypeScript `interface
 * extends` rejects conflicting readonly modifiers on the same field; a `type &`
 * intersection silently widens to mutable (the least-constrained form).
 *
 * TerminalCompositor satisfies this type structurally because it has all the
 * required fields/methods. Each free function below narrows `self` to the
 * specific sub-host the delegate it calls expects.
 */
export type ApiHost = InputModeHost & RenderHost & AutocompleteHost & KeyDispatchHost & {
  // Handler setters/getters (not covered by any sub-host)
  onSubmit?: (payload: SubmissionPayload) => void;
  onCancel?: () => void;
  onRewindRequest?: () => void;
  onIdleEscape?: () => void;
  onOpenEditor?: () => void;

  // setInputMode — needs to flush before delegating to InputMode.*
  flushPendingRepaint(): void;
};

// ── Group 1: Handler setters/getters ────────────────────────────────────────

export function setOnSubmit(
  self: ApiHost,
  handler: ((payload: SubmissionPayload) => void) | null,
): void {
  self.onSubmit = handler ?? undefined;
}

export function setOnCancel(self: ApiHost, handler: (() => void) | null): void {
  self.onCancel = handler ?? undefined;
}

export function getOnCancel(self: ApiHost): (() => void) | undefined {
  return self.onCancel;
}

export function setOnRewindRequest(self: ApiHost, handler: (() => void) | null): void {
  self.onRewindRequest = handler ?? undefined;
}

export function setOnIdleEscape(self: ApiHost, handler: (() => void) | null): void {
  self.onIdleEscape = handler ?? undefined;
}

export function setOnOpenEditor(self: ApiHost, handler: (() => void) | null): void {
  self.onOpenEditor = handler ?? undefined;
}

// ── Group 2: Picker mode delegates ──────────────────────────────────────────

export function enterPickerMode(self: ApiHost, controller: PickerController): void {
  InputMode.enterPickerMode(self, controller);
}

export function exitPickerMode(self: ApiHost): void {
  InputMode.exitPickerMode(self);
}

export function repaintPicker(self: ApiHost): void {
  InputMode.repaintPicker(self);
}

// ── Group 3: Terminal info ───────────────────────────────────────────────────

export function terminalRows(self: ApiHost): number {
  return Math.max(1, self.stdout.rows ?? 24);
}

// ── Group 4: Mode accessors ──────────────────────────────────────────────────

export function setInputMode(self: ApiHost, mode: CompositorInputMode): void {
  self.flushPendingRepaint();
  InputMode.setInputMode(self, mode);
}

export function getInputMode(self: ApiHost): CompositorInputMode {
  return InputMode.getInputMode(self);
}

// ── Group 5: Buffer/queue accessors ─────────────────────────────────────────

export function getBuffer(self: ApiHost): { text: string; queued: boolean } {
  return Paste.getBuffer(self);
}

export function getPendingCount(self: ApiHost): number {
  return self.pendingSubmissions.length;
}

export function peekQueuedText(self: ApiHost): QueuedSnapshot | undefined {
  return QueuedAccess.peekQueuedText(self);
}

export function reserveQueued(self: ApiHost, snapshot: QueuedSnapshot): void {
  QueuedAccess.reserveQueued(self, snapshot);
}

export function releaseQueued(self: ApiHost, snapshot: QueuedSnapshot): void {
  QueuedAccess.releaseQueued(self, snapshot);
}

export function dropQueued(self: ApiHost, snapshot: QueuedSnapshot): number {
  return QueuedAccess.dropQueued(self, snapshot);
}

export function getAttachments(self: ApiHost): ImageAttachment[] {
  return [...self.attachments];
}

// ── Group 6: Render delegates ────────────────────────────────────────────────

export function renderInputLine(self: ApiHost): string {
  return Render.renderInputLine(self);
}

export function updateAutocomplete(self: ApiHost): void {
  Autocomplete.updateAutocomplete(self);
}

export function updateGhost(self: ApiHost): void {
  Ghost.updateGhost(self);
}

export function primePromptGhost(self: ApiHost): void {
  Ghost.primePromptGhost(self);
}

export function dismissPromptGhost(self: ApiHost): boolean {
  return Ghost.dismissPromptGhost(self);
}

export function renderDropdownRows(self: ApiHost): string[] {
  return Render.renderDropdownRows(self);
}

export function renderHintRow(self: ApiHost): string | null {
  return Render.renderHintRow(self);
}

// ── Group 7: Input/edit delegates ───────────────────────────────────────────

export function applyEdit(self: ApiHost, next: InputCoreState): boolean {
  return InputDispatch.applyEdit(self, next);
}

export function prefillInput(self: ApiHost, text: string): void {
  InputDispatch.applyEdit(self, InputCore.seed(text));
}

export function applyDropdownSelection(self: ApiHost): boolean {
  return Autocomplete.applyDropdownSelection(self);
}

export function applyGhostAccept(self: ApiHost): boolean {
  return Ghost.applyGhostAccept(self);
}

export function applyGhostWordAccept(self: ApiHost): boolean {
  return Ghost.applyGhostWordAccept(self);
}
