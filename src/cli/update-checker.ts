import { spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { get as httpsGet } from 'https';
import { join } from 'path';
import { getAfkCacheDir } from '../paths.js';
import { getVersion } from './version.js';
import { env } from '../config/env.js';

/** Maximum response body size accepted from the registry (64 KB). */
const MAX_RESPONSE_BYTES = 64 * 1024;

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
}

interface UpdateCache {
  latestVersion: string;
  checkedAt: number;
}

interface PendingUpdate {
  targetVersion: string;
  triggeredAt: number;
}

const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
const CACHE_FILE = 'update-check.json';
const PENDING_FILE = 'pending-update.json';

function cachePath(): string {
  return join(getAfkCacheDir(), CACHE_FILE);
}

function pendingPath(): string {
  return join(getAfkCacheDir(), PENDING_FILE);
}

function ensureCacheDir(): void {
  const dir = getAfkCacheDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function isNewerVersion(current: string, latest: string): boolean {
  const c = current.split('.').map(Number);
  const l = latest.split('.').map(Number);
  const len = Math.max(c.length, l.length);
  for (let i = 0; i < len; i++) {
    const cv = c[i] ?? 0;
    const lv = l[i] ?? 0;
    if (lv > cv) return true;
    if (lv < cv) return false;
  }
  return false;
}

function readCache(): UpdateCache | null {
  try {
    const raw = readFileSync(cachePath(), 'utf-8');
    const parsed = JSON.parse(raw) as UpdateCache;
    if (typeof parsed.latestVersion === 'string' && typeof parsed.checkedAt === 'number') {
      return parsed;
    }
  } catch {
    // missing or corrupt — treat as no cache
  }
  return null;
}

function spawnBackgroundCheck(): void {
  try {
    ensureCacheDir();
    const script = `
      const https = require('https');
      const fs = require('fs');
      const url = 'https://registry.npmjs.org/agent-afk/latest';
      https.get(url, { headers: { 'Accept': 'application/json' } }, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try {
            const pkg = JSON.parse(data);
            if (typeof pkg.version === 'string') {
              fs.writeFileSync(${JSON.stringify(cachePath())}, JSON.stringify({
                latestVersion: pkg.version,
                checkedAt: Date.now()
              }));
            }
          } catch {}
        });
      }).on('error', () => {});
    `;
    const child = spawn(process.execPath, ['-e', script], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch {
    // never crash the CLI for update checking
  }
}

export function checkForUpdates(updatePolicy: 'notify' | 'auto' | 'off'): UpdateInfo | null {
  if (updatePolicy === 'off') return null;
  if (env.NO_UPDATE_NOTIFIER) return null;
  if (env.CI) return null;

  const cache = readCache();
  const now = Date.now();

  if (!cache || now - cache.checkedAt > TWENTY_FOUR_HOURS) {
    spawnBackgroundCheck();
  }

  if (!cache) return null;

  const currentVersion = getVersion();
  if (isNewerVersion(currentVersion, cache.latestVersion)) {
    return { currentVersion, latestVersion: cache.latestVersion };
  }

  return null;
}

export function printUpdateBanner(info: UpdateInfo): void {
  const yellow = '\x1b[33m';
  const bold = '\x1b[1m';
  const dim = '\x1b[2m';
  const reset = '\x1b[0m';
  process.stderr.write(
    `\n${yellow}${bold}Update available:${reset} ${dim}${info.currentVersion}${reset} → ${bold}${info.latestVersion}${reset}\n` +
    `${dim}Run \`npm install -g agent-afk\` to update${reset}\n`,
  );
}

const SEMVER_RE = /^\d+\.\d+\.\d+(-[\da-z.]+)?$/i;

/**
 * Write the pending-update marker that `checkPendingUpdate()` consumes on
 * the next launch to print a "Updated to vX.Y.Z" confirmation line.
 *
 * Exported so the foreground `afk update` command can drop the marker after
 * a successful install — without going through the silent auto-update path.
 */
export function writePendingUpdateMarker(targetVersion: string): void {
  if (!SEMVER_RE.test(targetVersion)) return;
  try {
    ensureCacheDir();
    writeFileSync(
      pendingPath(),
      JSON.stringify({
        targetVersion,
        triggeredAt: Date.now(),
      }),
    );
  } catch {
    // best-effort — confirmation is a nicety
  }
}

/**
 * Synchronously-ish fetch the latest published version from npm. Returns
 * `undefined` on any network/parse failure so callers can degrade gracefully.
 *
 * Distinct from the background `spawnBackgroundCheck` path: this is awaited
 * inline by `afk update --check` and `afk update` when the user explicitly
 * asked for a current-version probe.
 */
export function fetchLatestVersion(
  timeoutMs: number = 5000,
  url: string = 'https://registry.npmjs.org/agent-afk/latest',
): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (v: string | undefined): void => {
      if (settled) return;
      settled = true;
      resolve(v);
    };

    const doGet = (targetUrl: string, redirectsLeft: number): void => {
      try {
        const req = httpsGet(
          targetUrl,
          { headers: { Accept: 'application/json' } },
          (res) => {
            // Follow HTTP 301/302 redirects (up to 3 hops).
            if (
              (res.statusCode === 301 || res.statusCode === 302) &&
              typeof res.headers.location === 'string' &&
              redirectsLeft > 0
            ) {
              res.resume(); // drain and discard body
              doGet(res.headers.location, redirectsLeft - 1);
              return;
            }
            // Reject non-200 responses.
            if (res.statusCode !== 200) {
              res.resume();
              settle(undefined);
              return;
            }
            let data = '';
            let byteCount = 0;
            let truncated = false;
            res.on('data', (chunk: Buffer) => {
              if (truncated) return;
              byteCount += chunk.byteLength;
              if (byteCount > MAX_RESPONSE_BYTES) {
                truncated = true;
                req.destroy();
                settle(undefined);
                return;
              }
              data += chunk.toString('utf-8');
            });
            res.on('end', () => {
              if (truncated) return;
              try {
                const pkg = JSON.parse(data) as { version?: unknown };
                if (typeof pkg.version === 'string' && SEMVER_RE.test(pkg.version)) {
                  settle(pkg.version);
                  return;
                }
              } catch {
                // fall through
              }
              settle(undefined);
            });
          },
        );
        req.on('error', () => settle(undefined));
        req.setTimeout(timeoutMs, () => {
          req.destroy();
          settle(undefined);
        });
      } catch {
        settle(undefined);
      }
    };

    doGet(url, 3);
  });
}

export function triggerAutoUpdate(latestVersion: string): void {
  if (!SEMVER_RE.test(latestVersion)) return;
  try {
    writePendingUpdateMarker(latestVersion);
    const child = spawn('npm', ['install', '-g', `agent-afk@${latestVersion}`], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch {
    // silent — auto-update is best-effort
  }
}

export function checkPendingUpdate(): void {
  try {
    const raw = readFileSync(pendingPath(), 'utf-8');
    const pending = JSON.parse(raw) as PendingUpdate;
    if (typeof pending.targetVersion === 'string') {
      const current = getVersion();
      unlinkSync(pendingPath());
      if (current === pending.targetVersion) {
        const green = '\x1b[32m';
        const bold = '\x1b[1m';
        const reset = '\x1b[0m';
        process.stderr.write(`${green}${bold}Updated to agent-afk v${current}${reset}\n`);
      }
    }
  } catch {
    // no pending update or corrupt file — ignore
  }
}
