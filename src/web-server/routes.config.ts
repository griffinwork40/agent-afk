/**
 * Config-info route for the `afk web` surface.
 *
 * Contract: this handler is dispatched from `server.ts` after bearer-token
 * and Origin checks have already passed. The response is read-only and
 * contains no secrets — credentials are never surfaced here.
 */

import type { ServerResponse } from 'node:http';
import { getAfkHome, getAfkStateDir, getAfkConfigDir } from '../paths.js';
import { getVersion } from '../cli/version.js';
import { env } from '../config/env.js';
import { sendJson } from './routes.js';
import { DEFAULT_WEB_PORT, DEFAULT_WEB_HOST } from './server.js';

/** Shape returned by `GET /api/config`. */
export interface ConfigInfo {
  version: string;
  nodeVersion: string;
  model: string;
  stateDir: string;
  configDir: string;
  afkHome: string;
  webPort: number;
  webHost: string;
}

/** `GET /api/config` — return read-only AFK configuration info. */
export function handleGetConfig(
  res: ServerResponse,
  port: number,
  host: string,
): void {
  const model = env.AFK_MODEL ?? env.CLAUDE_MODEL ?? 'medium';
  const webPort = port > 0 ? port : (Number(env.AFK_WEB_PORT) || DEFAULT_WEB_PORT);
  const webHost = env.AFK_WEB_HOST ?? host ?? DEFAULT_WEB_HOST;

  const info: ConfigInfo = {
    version: getVersion(),
    nodeVersion: process.version,
    model,
    stateDir: getAfkStateDir(),
    configDir: getAfkConfigDir(),
    afkHome: getAfkHome(),
    webPort,
    webHost,
  };

  sendJson(res, 200, info);
}
