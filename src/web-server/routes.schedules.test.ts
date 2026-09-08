import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ServerResponse } from 'node:http';
import {
  handleListSchedules,
  handleCreateSchedule,
  handleUpdateSchedule,
  handleDeleteSchedule,
  handleToggleSchedule,
  handleScheduleHistory,
  handleDaemonStatus,
} from './routes.schedules.js';

// ---- mocks -----------------------------------------------------------------

const mockSchedules = [
  {
    id: 'nightly-forge',
    name: 'Nightly forge',
    command: '/forge-friction --auto',
    cron: '0 2 * * *',
    trigger: 'cron' as const,
    enabled: true,
    notifyOn: 'failure' as const,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
];

vi.mock('../agent/daemon/schedule-store.js', () => ({
  loadSchedules: vi.fn(() => [...mockSchedules]),
  saveSchedules: vi.fn(),
  addSchedule: vi.fn((config: Record<string, unknown>) => ({
    id: 'test-schedule',
    ...config,
    notifyOn: config['notifyOn'] ?? 'failure',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })),
  removeSchedule: vi.fn((id: string) => id === 'nightly-forge'),
  getSchedule: vi.fn((id: string) =>
    id === 'nightly-forge' ? mockSchedules[0] : undefined,
  ),
  toScheduledTask: vi.fn((config: Record<string, unknown>) => ({
    taskId: config['id'],
    command: config['command'],
    cronExpression: config['cron'],
    trigger: config['trigger'] ?? 'cron',
  })),
}));

vi.mock('../agent/daemon/http-client.js', () => ({
  trySyncToDaemon: vi.fn(async () => ({ synced: true, detail: 'synced' })),
  SYNC_FAILED_NOTE: 'sync note',
  parsePortFile: vi.fn(() => ({ host: '127.0.0.1', port: 7777 })),
}));

vi.mock('../paths.js', () => ({
  getTelemetryPath: vi.fn(() => '/tmp/nonexistent-telemetry.jsonl'),
  getDaemonStateDir: vi.fn(() => '/tmp/nonexistent-daemon'),
}));

// ---- helpers ---------------------------------------------------------------

function makeRes(): { res: ServerResponse; json: () => { status: number; body: unknown } } {
  let status = 0;
  const chunks: string[] = [];
  const headers: Record<string, string> = {};
  const res = {
    writeHead(s: number, h: Record<string, string>) {
      status = s;
      Object.assign(headers, h);
    },
    end(payload: string) {
      chunks.push(payload);
    },
  } as unknown as ServerResponse;
  return {
    res,
    json: () => ({ status, body: JSON.parse(chunks.join('')) as unknown }),
  };
}

// ---- tests -----------------------------------------------------------------

describe('routes.schedules', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('handleListSchedules', () => {
    it('returns the schedule list', async () => {
      const { res, json } = makeRes();
      await handleListSchedules(res);
      const { status, body } = json();
      expect(status).toBe(200);
      expect(body).toHaveProperty('schedules');
      expect((body as { schedules: unknown[] }).schedules).toHaveLength(1);
    });
  });

  describe('handleCreateSchedule', () => {
    it('creates a schedule with valid input', async () => {
      const { res, json } = makeRes();
      await handleCreateSchedule(res, {
        name: 'Test',
        command: '/test',
        cron: '0 * * * *',
      });
      const { status, body } = json();
      expect(status).toBe(201);
      expect(body).toHaveProperty('schedule');
      expect(body).toHaveProperty('daemonSynced', true);
    });

    it('rejects missing fields', async () => {
      const { res, json } = makeRes();
      await handleCreateSchedule(res, { name: 'Test' });
      expect(json().status).toBe(400);
    });

    it('rejects invalid cron', async () => {
      const { res, json } = makeRes();
      await handleCreateSchedule(res, {
        name: 'Test',
        command: '/test',
        cron: 'bad',
      });
      expect(json().status).toBe(400);
    });
  });

  describe('handleUpdateSchedule', () => {
    it('updates an existing schedule', async () => {
      const { res, json } = makeRes();
      await handleUpdateSchedule(res, 'nightly-forge', { name: 'Updated' });
      const { status, body } = json();
      expect(status).toBe(200);
      expect((body as { schedule: { name: string } }).schedule.name).toBe('Updated');
    });

    it('returns 404 for unknown id', async () => {
      const { res, json } = makeRes();
      await handleUpdateSchedule(res, 'nonexistent', { name: 'x' });
      expect(json().status).toBe(404);
    });
  });

  describe('handleDeleteSchedule', () => {
    it('deletes an existing schedule', async () => {
      const { res, json } = makeRes();
      await handleDeleteSchedule(res, 'nightly-forge');
      expect(json().status).toBe(200);
    });

    it('returns 404 for unknown id', async () => {
      const { res, json } = makeRes();
      await handleDeleteSchedule(res, 'nonexistent');
      expect(json().status).toBe(404);
    });
  });

  describe('handleToggleSchedule', () => {
    it('toggles an existing schedule', async () => {
      const { res, json } = makeRes();
      await handleToggleSchedule(res, 'nightly-forge');
      const { status, body } = json();
      expect(status).toBe(200);
      // Was enabled, now disabled
      expect((body as { enabled: boolean }).enabled).toBe(false);
    });

    it('returns 404 for unknown id', async () => {
      const { res, json } = makeRes();
      await handleToggleSchedule(res, 'nonexistent');
      expect(json().status).toBe(404);
    });
  });

  describe('handleScheduleHistory', () => {
    it('returns empty history when telemetry file missing', async () => {
      const { res, json } = makeRes();
      await handleScheduleHistory(res, 'nightly-forge');
      const { status, body } = json();
      expect(status).toBe(200);
      expect((body as { history: unknown[] }).history).toEqual([]);
    });
  });

  describe('handleDaemonStatus', () => {
    it('returns running: false when port file missing', async () => {
      const { res, json } = makeRes();
      await handleDaemonStatus(res);
      const { status, body } = json();
      expect(status).toBe(200);
      expect((body as { running: boolean }).running).toBe(false);
    });
  });
});
