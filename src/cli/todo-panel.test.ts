/**
 * Tests for src/cli/todo-panel.ts
 *
 * Uses a tmp HOME so the on-disk JSON doesn't collide with real usage.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  loadTodos,
  saveTodos,
  addTodo,
  markDone,
  removeTodo,
  clearTodos,
  renderTodoPanel,
} from './todo-panel.js';

let originalHome: string | undefined;
let tmpHome: string;

beforeEach(() => {
  originalHome = process.env['HOME'];
  tmpHome = join(tmpdir(), `afk-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  process.env['HOME'] = tmpHome;
});

afterEach(() => {
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
  if (originalHome !== undefined) process.env['HOME'] = originalHome;
});

describe('todo-panel', () => {
  it('loadTodos returns empty store for unknown session', () => {
    const s = loadTodos('brand-new-session');
    expect(s.items).toEqual([]);
    expect(s.sessionId).toBe('brand-new-session');
  });

  it('addTodo assigns unique sequential ids and marks not-done', () => {
    const s = loadTodos('s1');
    const a = addTodo(s, 'first');
    const b = addTodo(s, 'second');
    expect(a.id).toBe(1);
    expect(b.id).toBe(2);
    expect(a.done).toBe(false);
    expect(s.items).toHaveLength(2);
  });

  it('saveTodos + loadTodos round-trips', () => {
    const s = loadTodos('roundtrip');
    addTodo(s, 'one');
    addTodo(s, 'two');
    saveTodos(s);
    const loaded = loadTodos('roundtrip');
    expect(loaded.items).toHaveLength(2);
    expect(loaded.items[0]!.text).toBe('one');
    expect(loaded.items[1]!.text).toBe('two');
  });

  it('markDone flips the done flag', () => {
    const s = loadTodos('mark');
    const a = addTodo(s, 'task');
    markDone(s, a.id);
    expect(s.items[0]!.done).toBe(true);
  });

  it('removeTodo drops the item', () => {
    const s = loadTodos('rm');
    const a = addTodo(s, 'task');
    addTodo(s, 'keeper');
    const ok = removeTodo(s, a.id);
    expect(ok).toBe(true);
    expect(s.items.map((i) => i.text)).toEqual(['keeper']);
  });

  it('clearTodos empties the list', () => {
    const s = loadTodos('clear');
    addTodo(s, 'one');
    addTodo(s, 'two');
    clearTodos(s);
    expect(s.items).toHaveLength(0);
  });

  it('renderTodoPanel returns [] when empty', () => {
    const s = loadTodos('empty');
    expect(renderTodoPanel(s)).toEqual([]);
  });

  it('renderTodoPanel contains the item text and an id marker', () => {
    const s = loadTodos('render');
    addTodo(s, 'buy milk');
    const lines = renderTodoPanel(s);
    const joined = lines.join('\n');
    expect(joined).toContain('buy milk');
    expect(joined).toContain('#1');
  });

  it('renderTodoPanel top border scales with terminal width (capped)', () => {
    const prev = process.stdout.columns;
    Object.defineProperty(process.stdout, 'columns', { value: 50, configurable: true });
    const s = loadTodos('wide-panel');
    addTodo(s, 't');
    const top = renderTodoPanel(s)[0] ?? '';
    const stripped = top.replace(/\x1B\[[0-9;]*m/g, '');
    expect(stripped.length).toBeLessThanOrEqual(50);
    Object.defineProperty(process.stdout, 'columns', { value: prev, configurable: true });
  });
});
