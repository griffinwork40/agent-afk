/**
 * /todo — durable checklist per session.
 *
 * Usage:
 *   /todo add <text>       add a new item
 *   /todo done <id>        mark item done
 *   /todo rm <id>          remove item
 *   /todo clear            remove all items
 *   /todo list             show current items
 *   /todo                  (no args) — show current items
 */

import { palette } from '../../palette.js';
import {
  loadTodos,
  saveTodos,
  addTodo,
  markDone,
  removeTodo,
  clearTodos,
  renderTodoPanel,
} from '../../todo-panel.js';
import type { SlashCommand, SlashContext } from '../types.js';

function storeFor(ctx: SlashContext) {
  const id = ctx.stats.sessionId ?? 'unbound';
  return loadTodos(id);
}

function printList(ctx: SlashContext): void {
  const store = storeFor(ctx);
  const lines = renderTodoPanel(store);
  if (lines.length === 0) {
    ctx.out.info('No todos yet.  Try  /todo add buy milk');
    return;
  }
  for (const line of lines) ctx.out.line(line);
}

export const todoCmd: SlashCommand = {
  name: '/todo',
  usage: '/todo [add|done|rm|clear|list] ...',
  summary: 'Manage this session\'s todo list',
  hint: 'When you want a durable checklist the model and you both see — survives across turns and shows above each prompt.',
  async handler(ctx, args) {
    const trimmed = args.trim();
    if (!trimmed || trimmed === 'list') {
      printList(ctx);
      return 'continue';
    }

    const [verb, ...rest] = trimmed.split(/\s+/);
    const rem = rest.join(' ');
    const store = storeFor(ctx);

    switch (verb) {
      case 'add': {
        if (!rem) {
          ctx.out.warn('Usage:  /todo add <text>');
          return 'continue';
        }
        const item = addTodo(store, rem);
        saveTodos(store);
        ctx.out.success(`Added ${palette.meta(`#${item.id}`)}  ${item.text}`);
        return 'continue';
      }
      case 'done': {
        const id = parseInt(rem, 10);
        if (!Number.isFinite(id)) {
          ctx.out.warn('Usage:  /todo done <id>');
          return 'continue';
        }
        const item = markDone(store, id);
        if (!item) {
          ctx.out.warn(`No todo with id ${id}`);
        } else {
          saveTodos(store);
          ctx.out.success(`Marked done ${palette.meta(`#${id}`)}  ${item.text}`);
        }
        return 'continue';
      }
      case 'rm':
      case 'remove': {
        const id = parseInt(rem, 10);
        if (!Number.isFinite(id)) {
          ctx.out.warn('Usage:  /todo rm <id>');
          return 'continue';
        }
        if (!removeTodo(store, id)) {
          ctx.out.warn(`No todo with id ${id}`);
        } else {
          saveTodos(store);
          ctx.out.success(`Removed ${palette.meta(`#${id}`)}`);
        }
        return 'continue';
      }
      case 'clear': {
        clearTodos(store);
        saveTodos(store);
        ctx.out.success('All todos cleared.');
        return 'continue';
      }
      default: {
        ctx.out.warn(`Unknown subcommand: ${verb}.  Try /todo add, done, rm, clear, list.`);
        return 'continue';
      }
    }
  },
};
