/**
 * Daemon mode — Phase 5.
 *
 * Long-running host that runs scheduled tasks (e.g. a recurring slash-command
 * invocation on cron) without an interactive Claude Code session, so
 * automation can fire unattended.
 *
 * v1 ships cron-only. SessionStart trigger + dedup land in Phase 6 — the
 * `TriggerMode` union and `ScheduledTask` shape already reserve the surface.
 *
 * @module agent/daemon
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { writeFileSync, unlinkSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AgentConfig } from './types.js';
import { CronScheduler, type SchedulerOptions, type TelemetryRecord } from './daemon/scheduler.js';
import type { ScheduledTask, TriggerMode } from './daemon/triggers.js';
import { getDaemonStateDir } from '../paths.js';

export interface DaemonOptions {
  /** Port for the HTTP control surface. Defaults to 7777. */
  port?: number;
  /**
   * Host/interface the HTTP control surface binds to. Defaults to
   * '127.0.0.1' (loopback only).
   *
   * Invariant: the control surface is UNAUTHENTICATED and `POST /tasks`
   * registers commands the daemon will execute via an agent session (which
   * has shell access). Binding a non-loopback address therefore exposes
   * arbitrary-command scheduling to anyone who can reach the port — so the
   * default refuses off-host connections. Override only on a trusted or
   * firewalled network.
   */
  host?: string;
  /** Tasks to register at startup. */
  tasks?: ScheduledTask[];
  /** Per-tick session config; flows through to `CronScheduler`. */
  sessionConfig?: Partial<AgentConfig>;
  /** Override telemetry sink path (tests). */
  telemetryPath?: string;
  /** Override session factory (tests). */
  sessionFactory?: SchedulerOptions['sessionFactory'];
  /**
   * Default cooldown (ms) between Phase 6 sessionstart fires of the same
   * task. Flows into `CronScheduler`.
   */
  cooldownMs?: number;
  /** Clock injection (tests). */
  now?: () => number;
  /** Optional callback fired after every telemetry record is written. */
  onTaskComplete?: SchedulerOptions['onTaskComplete'];
  /**
   * "Done"-verification probe. Injected by the CLI daemon wiring (where the
   * `parseTerminalState` + `doneHasCorroboratingEvidence` reusables are legally
   * importable — `src/agent/` must not import `src/cli/`). Flows into
   * `CronScheduler`. See `SchedulerOptions.doneUnverifiedProbe`.
   */
  doneUnverifiedProbe?: SchedulerOptions['doneUnverifiedProbe'];
  /**
   * Poll interval (ms) for pull-trigger mode. When set and > 0, the daemon
   * will call `scheduler.startPullLoop()` after construction and dequeue one
   * task per tick from `queueDir` when idle.
   */
  pullPollIntervalMs?: number;
  /** Override the queue directory for pull-mode dequeue (defaults to `getQueueDir()`). */
  queueDir?: string;
  /**
   * Write the port-discovery file under the daemon state dir so tool handlers
   * (create_schedule / cancel_schedule live-sync) can find this instance.
   * Defaults to true. Set false for transient instances (`--once` ticks,
   * tests) so they do not overwrite — and then delete — the long-running
   * service daemon's port file, silently severing live-sync until restart.
   */
  writePortFile?: boolean;
}

export interface DaemonHandle {
  readonly port: number;
  /** The address the control surface actually bound to (e.g. '127.0.0.1'). */
  readonly host: string;
  readonly scheduler: CronScheduler;
  registerTask(task: ScheduledTask): void;
  unregisterTask(taskId: string): void;
  /** Run one tick of a registered task immediately; surfaces the telemetry record. */
  tickOnce(taskId: string): Promise<TelemetryRecord>;
  /**
   * Phase 6: evaluate sessionstart gates and fire eligible tasks. Callable
   * explicitly (CLI triggers it at startup) or manually (tests).
   */
  fireOnStart(): Promise<TelemetryRecord[]>;
  stop(): Promise<void>;
}

const DEFAULT_PORT = 7777;
// Invariant: loopback-only by default. The control surface is unauthenticated
// (see DaemonOptions.host) — binding all interfaces would expose command
// scheduling to the local network. Callers opt into a wider bind explicitly.
const DEFAULT_HOST = '127.0.0.1';

export async function startDaemon(options: DaemonOptions = {}): Promise<DaemonHandle> {
  const scheduler = new CronScheduler({
    ...(options.sessionConfig !== undefined ? { sessionConfig: options.sessionConfig } : {}),
    ...(options.telemetryPath !== undefined ? { telemetryPath: options.telemetryPath } : {}),
    ...(options.sessionFactory !== undefined ? { sessionFactory: options.sessionFactory } : {}),
    ...(options.cooldownMs !== undefined ? { cooldownMs: options.cooldownMs } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.onTaskComplete !== undefined ? { onTaskComplete: options.onTaskComplete } : {}),
    ...(options.doneUnverifiedProbe !== undefined ? { doneUnverifiedProbe: options.doneUnverifiedProbe } : {}),
    ...(options.pullPollIntervalMs !== undefined ? { pullPollIntervalMs: options.pullPollIntervalMs } : {}),
    ...(options.queueDir !== undefined ? { queueDir: options.queueDir } : {}),
  });

  if (options.pullPollIntervalMs !== undefined && options.pullPollIntervalMs > 0) {
    scheduler.startPullLoop();
  }

  for (const task of options.tasks ?? []) {
    scheduler.register(task);
  }

  // Port file path — written on listen, deleted on stop.
  // STALE-FILE NOTE: SIGKILL cannot be intercepted — a stale port file may
  // survive a crash. Tool handlers report this as 'daemon-unreachable'.
  const writePortFile = options.writePortFile !== false;
  const portFilePath = join(getDaemonStateDir('default'), 'port');

  const server = createServer((req, res) => handleRequest(req, res, scheduler));
  const { port, address: host } = await listen(
    server,
    options.port ?? DEFAULT_PORT,
    options.host ?? DEFAULT_HOST,
  );

  // Write the port file so tool handlers can find the running daemon.
  if (writePortFile) {
    try {
      mkdirSync(dirname(portFilePath), { recursive: true });
      writeFileSync(portFilePath, String(port), 'utf-8');
    } catch {
      // Best-effort; daemon still functional without port file
    }
  }

  return {
    port,
    host,
    scheduler,
    registerTask(task) {
      scheduler.register(task);
    },
    unregisterTask(taskId) {
      scheduler.unregister(taskId);
    },
    tickOnce(taskId) {
      return scheduler.tick(taskId);
    },
    fireOnStart() {
      return scheduler.fireOnStart();
    },
    async stop() {
      await scheduler.stop();
      // Delete the port file on graceful shutdown — but only if it still
      // records OUR port. Another daemon instance may have (re)claimed the
      // path since we wrote it; unconditionally unlinking would sever
      // live-sync discovery for that instance.
      // Invariant: the read→unlink below is not atomic (Node fs has no
      // compare-and-delete). A residual TOCTOU window remains — a competing
      // instance could rewrite the file between the read and the unlink. It is
      // accepted: the path is localhost-only and the worst case is a live
      // daemon losing port-file discovery until its next (re)start.
      if (writePortFile) {
        try {
          if (readFileSync(portFilePath, 'utf-8').trim() === String(port)) {
            unlinkSync(portFilePath);
          }
        } catch {
          // Port file may not exist (tests with port: 0, or already deleted)
        }
      }
      await closeServer(server);
    },
  };
}

/**
 * Read the full HTTP request body as a UTF-8 string.
 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

/**
 * Synchronous outer wrapper that delegates to the async handler.
 * The catch handler closes `res` unconditionally if the inner function rejects.
 */
function handleRequest(req: IncomingMessage, res: ServerResponse, scheduler: CronScheduler): void {
  void handleRequestAsync(req, res, scheduler).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
    }
    res.end(JSON.stringify({ error: msg }));
  });
}

async function handleRequestAsync(
  req: IncomingMessage,
  res: ServerResponse,
  scheduler: CronScheduler,
): Promise<void> {
  const url = req.url ?? '/';

  if (req.method === 'GET' && url === '/health') {
    const body = JSON.stringify({ status: 'ok', tasks: scheduler.list().length });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(body);
    return;
  }

  if (req.method === 'GET' && url === '/tasks') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(scheduler.list()));
    return;
  }

  // POST /tasks — register a new task
  if (req.method === 'POST' && url === '/tasks') {
    const raw = await readBody(req);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid JSON body' }));
      return;
    }
    if (!body || typeof body !== 'object') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'body must be an object' }));
      return;
    }
    const obj = body as Record<string, unknown>;
    // Tolerant reader: GET /tasks returns `cronExpression`, so accept it as
    // an alias for `cron` on the way in (round-trip symmetry for manual ops).
    const cronValue = obj['cron'] ?? obj['cronExpression'];
    if (
      typeof obj['taskId'] !== 'string' ||
      typeof obj['command'] !== 'string' ||
      typeof cronValue !== 'string'
    ) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ error: 'taskId, command, and cron (or cronExpression) are required strings' }),
      );
      return;
    }
    const notifyChatRaw = obj['notifyChat'];
    const task: ScheduledTask = {
      taskId: obj['taskId'] as string,
      command: obj['command'] as string,
      trigger: (obj['trigger'] as TriggerMode | undefined) ?? 'cron',
      cronExpression: cronValue,
      ...(obj['notifyOn'] !== undefined
        ? { notifyOn: obj['notifyOn'] as ScheduledTask['notifyOn'] }
        : {}),
      ...(typeof notifyChatRaw === 'number' || typeof notifyChatRaw === 'string'
        ? { notifyChat: notifyChatRaw }
        : {}),
    };
    try {
      scheduler.register(task);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = msg.includes('already registered') ? 409 : 400;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: msg }));
      return;
    }
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // DELETE /tasks/:id — unregister a task
  if (req.method === 'DELETE' && url.startsWith('/tasks/')) {
    const taskId = url.slice('/tasks/'.length);
    if (!taskId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'taskId required in URL' }));
      return;
    }
    const exists = scheduler.list().some((t) => t.taskId === taskId);
    if (!exists) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    scheduler.unregister(taskId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
}

function listen(
  server: Server,
  requestedPort: number,
  host: string,
): Promise<{ port: number; address: string }> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // Contract: passing `host` restricts the bind to that interface. Omitting
    // it (the prior behaviour) made Node bind the unspecified address (all
    // interfaces) — the vulnerability this argument closes.
    server.listen(requestedPort, host, () => {
      server.removeListener('error', reject);
      const address = server.address();
      if (typeof address === 'object' && address) {
        resolve({ port: address.port, address: address.address });
      } else {
        resolve({ port: requestedPort, address: host });
      }
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
