/**
 * Background-job read routes for the `afk web` surface.
 *
 * Contract: these handlers are dispatched from `server.ts` after bearer-token
 * and Origin checks have already passed. They are read-only — no writes, no
 * daemon sync needed.
 */

import type { ServerResponse } from 'node:http';
import { BgJobLogReader } from '../agent/bg-job-log.js';
import { sendJson } from './routes.js';

// Invariant: jobId chars are limited to alphanumeric + dash, matching the
// format emitted by BackgroundAgentRegistry (randomBytes hex + timestamp).
// Any other character could indicate a path traversal attempt.
const VALID_JOB_ID = /^[a-zA-Z0-9-]+$/;

/** `GET /api/bg-jobs` — list all background jobs, newest first. */
export async function handleListBgJobs(res: ServerResponse): Promise<void> {
  const jobs = await BgJobLogReader.listJobs();
  sendJson(res, 200, { jobs });
}

/** `GET /api/bg-jobs/:id` — fetch a single background job's metadata. */
export async function handleGetBgJob(
  res: ServerResponse,
  jobId: string,
): Promise<void> {
  if (!VALID_JOB_ID.test(jobId)) {
    sendJson(res, 400, { error: 'bad_request', message: 'invalid job id format' });
    return;
  }

  const job = await BgJobLogReader.readMeta(jobId);
  if (!job) {
    sendJson(res, 404, { error: 'not_found', message: `bg job ${jobId} not found` });
    return;
  }

  sendJson(res, 200, { job });
}
