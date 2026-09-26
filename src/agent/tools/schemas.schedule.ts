/**
 * Schema definitions for schedule management tools.
 *
 * Extracted from `schemas.ts` to keep the registry file under the 350-code-line
 * ceiling. Re-exported from `schemas.ts` — consumers import from there, not here.
 *
 * @module agent/tools/schemas.schedule
 */

import type { AnthropicToolDef } from './types.js';

export const createScheduleTool: AnthropicToolDef = {
  name: 'create_schedule',
  category: 'schedule',
  concurrencySafe: false,
  description:
    'Create a new scheduled task that the daemon will run on a cron expression. ' +
    'The task is saved to ~/.afk/config/schedules.json and live-synced to the running daemon if available. ' +
    'Returns the new task ID (slug) on success, plus daemonSynced/syncDetail — when daemonSynced is false, ' +
    'no running daemon picked up the change and it applies on the next daemon (re)start.',
  input_schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Human-readable label, e.g. "Nightly cleanup".',
      },
      command: {
        type: 'string',
        description:
          'Command to run. For executor "agent" (default): a prompt or slash command, e.g. "/my-skill --auto". ' +
          'For executor "shell": a shell command, e.g. "pg_dump mydb > /backups/nightly.sql".',
      },
      cron: {
        type: 'string',
        description: '5-field cron expression, e.g. "0 2 * * *".',
      },
      executor: {
        type: 'string',
        enum: ['agent', 'shell'],
        description:
          'Execution strategy. "agent" (default) spawns an AgentSession and sends the command as a user message. ' +
          '"shell" runs the command as a raw shell command via /bin/sh, skipping the agent session entirely -- ' +
          'use for simple jobs like backups, health checks, or log rotation.',
      },
      trigger: {
        type: 'string',
        enum: ['cron', 'sessionstart', 'both'],
        description: 'Trigger mode. Default: cron.',
      },
      notifyOn: {
        type: 'string',
        enum: ['failure', 'always', 'never'],
        description: 'When to push Telegram notifications. Default: failure.',
      },
      notifyChat: {
        type: ['number', 'string'],
        description:
          'Optional. Route this task\'s completion notification to a SPECIFIC chat instead of ' +
          'the default primary target. A number (or numeric string) is a raw Telegram chat id; ' +
          'a non-numeric string is a chat alias name from afk.config.json `telegram.chatAliases`. ' +
          'The resolved chat must be allowlisted (AFK_TELEGRAM_ALLOWED_CHAT_IDS) — otherwise the ' +
          'daemon ignores the override and uses the default target. Omit for default routing.',
      },
      enabled: {
        type: 'boolean',
        description: 'Whether to activate immediately. Default: true.',
      },
      cwd: {
        type: 'string',
        description:
          'Optional per-task working directory (absolute path or ~/…). ' +
          'Pins this task\'s spawned session to a specific directory instead of the daemon-wide ' +
          'AFK_DAEMON_CWD. Precedence: task cwd → AFK_DAEMON_CWD → process.cwd(). ' +
          'Must be an existing directory. Tilde (~) is expanded at save time.',
      },
    },
    required: ['name', 'command', 'cron'],
  },
};

export const updateScheduleTool: AnthropicToolDef = {
  name: 'update_schedule',
  category: 'schedule',
  concurrencySafe: false,
  description:
    'Update one or more fields on an existing scheduled task. Only supplied fields are changed; ' +
    'omitted fields are preserved. The task ID (slug) is immutable and cannot be changed. ' +
    'Returns the updated config on success, plus daemonSynced/syncDetail — when daemonSynced is false, ' +
    'the running daemon did not pick up the change and it applies on the next daemon (re)start.',
  input_schema: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The task ID (slug) to update.',
      },
      name: {
        type: 'string',
        description: 'New human-readable label. Does not change the task ID.',
      },
      command: {
        type: 'string',
        description:
          'New command to run. For executor "agent": a prompt or slash command. ' +
          'For executor "shell": a shell command.',
      },
      cron: {
        type: 'string',
        description: 'New 5-field cron expression, e.g. "0 2 * * *".',
      },
      executor: {
        type: 'string',
        enum: ['agent', 'shell'],
        description: 'New execution strategy.',
      },
      trigger: {
        type: 'string',
        enum: ['cron', 'sessionstart', 'both'],
        description: 'New trigger mode.',
      },
      notifyOn: {
        type: 'string',
        enum: ['failure', 'always', 'never'],
        description: 'When to push Telegram notifications.',
      },
      notifyChat: {
        type: ['number', 'string'],
        description:
          'Route this task\'s completion notification to a specific chat. ' +
          'A number (or numeric string) is a raw Telegram chat id; ' +
          'a non-numeric string is a chat alias name from afk.config.json `telegram.chatAliases`.',
      },
      enabled: {
        type: 'boolean',
        description: 'Whether the task should be active.',
      },
      cwd: {
        type: 'string',
        description:
          'New per-task working directory (absolute path or ~/…). ' +
          'Must be an existing directory. Tilde (~) is expanded at save time. ' +
          'Omit to leave unchanged.',
      },
    },
    required: ['taskId'],
  },
};

export const listSchedulesTool: AnthropicToolDef = {
  name: 'list_schedules',
  category: 'schedule',
  concurrencySafe: true,
  description:
    'List all scheduled tasks with their IDs, cron expressions, enabled status, and notify settings. ' +
    'Returns a JSON array of task configs.',
  input_schema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

export const getScheduleHistoryTool: AnthropicToolDef = {
  name: 'get_schedule_history',
  category: 'schedule',
  concurrencySafe: true,
  description:
    'Retrieve recent execution history for a scheduled task from forge-telemetry.jsonl. ' +
    'Returns records in chronological order (oldest first), up to `limit` entries.',
  input_schema: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The task ID (slug) to look up.',
      },
      limit: {
        type: 'number',
        description: 'Max records to return (default: 10, max: 50).',
      },
    },
    required: ['taskId'],
  },
};

export const cancelScheduleTool: AnthropicToolDef = {
  name: 'cancel_schedule',
  category: 'schedule',
  concurrencySafe: false,
  description:
    'Disable, re-enable, or permanently remove a scheduled task. ' +
    'Default (no flags): sets enabled: false. enable: true re-enables and re-registers with the daemon. ' +
    'permanent: true removes from the store entirely (takes precedence over enable). ' +
    'The result includes daemonSynced/syncDetail — when daemonSynced is false, the running daemon ' +
    'did not pick up the change and will apply it on next restart.',
  input_schema: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'The task ID (slug) to operate on.' },
      permanent: { type: 'boolean', description: 'If true, remove from store entirely.' },
      enable: { type: 'boolean', description: 'If true, re-enable a disabled task and register it with the daemon.' },
    },
    required: ['taskId'],
  },
};
