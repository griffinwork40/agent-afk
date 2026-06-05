/**
 * Todo-panel — durable checklist per session.
 *
 * Persists a small JSON array of items to `~/.afk/state/todos/<sessionId>.json`.
 * The REPL optionally renders the panel above the prompt each turn when
 * non-empty; empty panels stay hidden.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { ensureTodosMigrated, getTodosDir } from '../paths.js';
import { displayWidth } from './display.js';
import { renderCardLine } from './formatter.js';
import { palette } from './palette.js';
import { getTerminalWidth } from './terminal-size.js';
import { wrapToWidth } from './wrap.js';

export interface TodoItem {
  id: number;
  text: string;
  done: boolean;
  createdAt: number;
}

export interface TodoStore {
  sessionId: string;
  items: TodoItem[];
}

function rootDir(): string {
  ensureTodosMigrated();
  return getTodosDir();
}

function pathFor(sessionId: string): string {
  return join(rootDir(), `${sessionId}.json`);
}

export function loadTodos(sessionId: string): TodoStore {
  const p = pathFor(sessionId);
  if (!existsSync(p)) return { sessionId, items: [] };
  try {
    const raw = readFileSync(p, 'utf-8');
    const parsed = JSON.parse(raw) as TodoStore;
    if (!Array.isArray(parsed.items)) return { sessionId, items: [] };
    return parsed;
  } catch {
    return { sessionId, items: [] };
  }
}

export function saveTodos(store: TodoStore): void {
  const root = rootDir();
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  writeFileSync(pathFor(store.sessionId), JSON.stringify(store, null, 2));
}

export function addTodo(store: TodoStore, text: string): TodoItem {
  const nextId = store.items.reduce((m, i) => Math.max(m, i.id), 0) + 1;
  const item: TodoItem = { id: nextId, text, done: false, createdAt: Date.now() };
  store.items.push(item);
  return item;
}

export function markDone(store: TodoStore, id: number): TodoItem | undefined {
  const item = store.items.find((i) => i.id === id);
  if (item) item.done = true;
  return item;
}

export function removeTodo(store: TodoStore, id: number): boolean {
  const idx = store.items.findIndex((i) => i.id === id);
  if (idx === -1) return false;
  store.items.splice(idx, 1);
  return true;
}

export function clearTodos(store: TodoStore): void {
  store.items.length = 0;
}

/** Render the panel as a list of lines; returns empty array when panel is empty. */
export function renderTodoPanel(store: TodoStore): string[] {
  if (store.items.length === 0) return [];
  const lines: string[] = [];
  const terminalWidth = Math.max(20, getTerminalWidth());
  {
    const prefix = palette.dim('┌─ todos ');
    const fill = Math.max(0, Math.min(terminalWidth - 10, 120));
    lines.push(prefix + palette.dim('─'.repeat(fill)));
  }
  for (const item of store.items) {
    const box = item.done ? palette.success('[x]') : palette.dim('[ ]');
    const styled = item.done ? palette.dim(item.text) : renderCardLine(item.text);
    const id = palette.meta(`#${item.id}`);
    const prefix = `  ${id}  ${box}  `;
    const textWidth = Math.max(8, terminalWidth - displayWidth(prefix));
    const wrapped = wrapToWidth(styled, textWidth).split('\n');
    lines.push(prefix + (wrapped[0] ?? ''));
    const continuation = ' '.repeat(displayWidth(prefix));
    for (const extraLine of wrapped.slice(1)) {
      lines.push(continuation + extraLine);
    }
  }
  {
    const fill = Math.max(0, Math.min(terminalWidth - 1, 120));
    lines.push(palette.dim('└' + '─'.repeat(fill)));
  }
  return lines;
}

/**
 * Structural fingerprint of a todo store — only the pieces that change the
 * visible panel (id + done + text). Terminal width is intentionally excluded
 * so resize alone does not force a re-render; callers that care about resize
 * should clear their own fingerprint cache on the resize event.
 */
export function todoFingerprint(store: TodoStore): string {
  if (store.items.length === 0) return '';
  return store.items.map((i) => `${i.id}:${i.done ? 1 : 0}:${i.text}`).join('\n');
}
