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
        description: '5-field cron expression, e.g. "0 2 * * *". Must be exactly 5 fields (no year field).',
      },
      runAt: {
        type: 'string',
        description:
          'ISO 8601 datetime for a one-shot fire, e.g. "2026-11-01T09:00:00Z". ' +
          'When set, the task fires once at or after this instant and is automatically disabled. ' +
          'Mutually exclusive with a recurring cron expression — omit `cron` or leave it as a ' +
          'polling cadence placeholder when using runAt.',
      },
      expiresAt: {
        type: 'string',
        description:
          'ISO 8601 datetime after which the task is automatically disabled, ' +
          'e.g. "2026-12-31T23:59:59Z". On expiry the scheduler skips the task, ' +
          'writes a skipped/expired telemetry record, and disables the task in the store. ' +
          'Works with both recurring cron tasks and runAt one-shots.',
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
      maxAttempts: {
        type: 'integer',
        minimum: 1,
        maximum: 5,
        description:
          'Optional total attempts per run for agent tasks (1-5). Default 1 = no retry. ' +
          'When > 1, a run that fails with a transient error (rate limit 429, network blip, provider 5xx) ' +
          'is retried in-process with exponential backoff; non-transient failures never retry.',
      },
      retryDelayMs: {
        type: 'integer',
        minimum: 1000,
        maximum: 300000,
        description:
          'Optional backoff base in ms between retry attempts (1000-300000; doubles per attempt, ' +
          'capped at 5 minutes). Default 30000. Only used when maxAttempts > 1.',
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
        description: 'New 5-field cron expression (no year), e.g. "0 2 * * *".',
      },
      runAt: {
        type: ['string', 'null'],
        description:
          'ISO 8601 datetime for a one-shot fire. Pass null to clear a previously-set runAt.',
      },
      expiresAt: {
        type: ['string', 'null'],
        description:
          'ISO 8601 expiry datetime. Pass null to clear a previously-set expiresAt.',
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
      maxAttempts: {
        type: 'integer',
        minimum: 1,
        maximum: 5,
        description: 'New total attempts per run (1-5). 1 disables retries. Only transient failures retry.',
      },
      retryDelayMs: {
        type: 'integer',
        minimum: 1000,
        maximum: 300000,
        description: 'New backoff base in ms between retry attempts (1000-300000).',
      },
      enabled: {
        type: 'boolean',
        description: 'Whether the task should be active.',
      },
      cwd: {
        type: ['string', 'null'],
        description:
          'New per-task working directory (absolute path or ~/…). ' +
          'Must be an existing directory. Tilde (~) is expanded at save time. ' +
          'Omit to leave unchanged. Pass null or "" to clear a previously-set ' +
          'cwd and fall back to the daemon-wide AFK_DAEMON_CWD default.',
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
