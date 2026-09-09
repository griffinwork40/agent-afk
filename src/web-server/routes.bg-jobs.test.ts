import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ServerResponse } from 'node:http';
import { handleListBgJobs, handleGetBgJob } from './routes.bg-jobs.js';
import type { BgJobMeta } from '../agent/bg-job-log.js';

// ---- mocks -----------------------------------------------------------------

const mockListJobs = vi.fn<() => Promise<BgJobMeta[]>>();
const mockReadMeta = vi.fn<(jobId: string) => Promise<BgJobMeta | null>>();

vi.mock('../agent/bg-job-log.js', () => ({
  BgJobLogReader: {
    listJobs: () => mockListJobs(),
    readMeta: (id: string) => mockReadMeta(id),
  },
}));

// ---- fixtures --------------------------------------------------------------

const JOB_A: BgJobMeta = {
  jobId: 'abc123',
  subagentId: 'sub-1',
  label: 'Research task',
  promptHash: 'deadbeef',
  model: 'sonnet',
  startedAt: 1_700_000_000_000,
  endedAt: 1_700_000_060_000,
  status: 'completed',
  schemaVersion: 1,
};

const JOB_B: BgJobMeta = {
  jobId: 'def456',
  subagentId: 'sub-2',
  label: 'Build task',
  promptHash: 'cafebabe',
  model: 'haiku',
  startedAt: 1_700_000_100_000,
  status: 'running',
  schemaVersion: 1,
};

// ---- helpers ---------------------------------------------------------------

function makeRes(): { res: ServerResponse; json: () => { status: number; body: unknown } } {
  let status = 0;
  const chunks: string[] = [];
  const res = {
    writeHead(s: number) {
      status = s;
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

describe('routes.bg-jobs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --------------------------------------------------------------------------
  // handleListBgJobs
  // --------------------------------------------------------------------------

  describe('handleListBgJobs', () => {
    it('returns 200 with a jobs array', async () => {
      mockListJobs.mockResolvedValue([JOB_A, JOB_B]);
      const { res, json } = makeRes();
      await handleListBgJobs(res);
      const { status, body } = json();
      expect(status).toBe(200);
      expect(body).toHaveProperty('jobs');
    });

    it('returns all jobs from the registry', async () => {
      mockListJobs.mockResolvedValue([JOB_A, JOB_B]);
      const { res, json } = makeRes();
      await handleListBgJobs(res);
      const { jobs } = json().body as { jobs: BgJobMeta[] };
      expect(jobs).toHaveLength(2);
      expect(jobs[0]?.jobId).toBe('abc123');
      expect(jobs[1]?.jobId).toBe('def456');
    });

    it('returns empty list when there are no jobs', async () => {
      mockListJobs.mockResolvedValue([]);
      const { res, json } = makeRes();
      await handleListBgJobs(res);
      const { status, body } = json();
      expect(status).toBe(200);
      expect((body as { jobs: unknown[] }).jobs).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  // handleGetBgJob
  // --------------------------------------------------------------------------

  describe('handleGetBgJob', () => {
    it('returns 400 for an id with disallowed characters (path-traversal guard)', async () => {
      const { res, json } = makeRes();
      await handleGetBgJob(res, '../etc/passwd');
      const { status, body } = json();
      expect(status).toBe(400);
      expect((body as { error: string }).error).toBe('bad_request');
    });

    it('returns 400 for an id with spaces', async () => {
      const { res, json } = makeRes();
      await handleGetBgJob(res, 'job id with spaces');
      expect(json().status).toBe(400);
    });

    it('returns 404 when the job is not found', async () => {
      mockReadMeta.mockResolvedValue(null);
      const { res, json } = makeRes();
      await handleGetBgJob(res, 'nonexistent-job-id');
      const { status, body } = json();
      expect(status).toBe(404);
      expect((body as { error: string }).error).toBe('not_found');
    });

    it('returns 200 with the job for a known id', async () => {
      mockReadMeta.mockResolvedValue(JOB_A);
      const { res, json } = makeRes();
      await handleGetBgJob(res, 'abc123');
      const { status, body } = json();
      expect(status).toBe(200);
      expect((body as { job: BgJobMeta }).job).toEqual(JOB_A);
    });

    it('passes the jobId through to BgJobLogReader.readMeta', async () => {
      mockReadMeta.mockResolvedValue(JOB_B);
      const { res } = makeRes();
      await handleGetBgJob(res, 'def456');
      expect(mockReadMeta).toHaveBeenCalledWith('def456');
    });

    it('accepts alphanumeric-and-dash ids', async () => {
      mockReadMeta.mockResolvedValue(JOB_A);
      const { res, json } = makeRes();
      await handleGetBgJob(res, 'job-abc-123');
      expect(json().status).toBe(200);
    });

    it('returns the correct job shape (all BgJobMeta fields)', async () => {
      mockReadMeta.mockResolvedValue(JOB_A);
      const { res, json } = makeRes();
      await handleGetBgJob(res, 'abc123');
      const { job } = json().body as { job: BgJobMeta };
      expect(job.jobId).toBe('abc123');
      expect(job.model).toBe('sonnet');
      expect(job.status).toBe('completed');
      expect(job.schemaVersion).toBe(1);
    });

    it('returns a running job (no endedAt) correctly', async () => {
      mockReadMeta.mockResolvedValue(JOB_B);
      const { res, json } = makeRes();
      await handleGetBgJob(res, 'def456');
      const { job } = json().body as { job: BgJobMeta };
      expect(job.status).toBe('running');
      expect(job.endedAt).toBeUndefined();
    });
  });
});
