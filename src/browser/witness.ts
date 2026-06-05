/**
 * Browser witness-layer sidecar helpers.
 *
 * Writes screenshot and DOM-snapshot sidecar files to the per-session browser
 * subdirectory inside the witness store. All files land under:
 *
 *   <getTraceDir(sessionId)>/browser/
 *     screenshots/    — PNG buffers, one file per browser_* call that
 *                       requests a screenshot.
 *     dom-snapshots/  — gzip-compressed HTML, Phase 2 opt-in.
 *
 * Invariant: these helpers are the ONLY writers for the browser sidecar
 * subtree. Tool handlers call them directly; the BrowserProvider backend
 * never touches the filesystem outside its own process boundary. This keeps
 * the witness layer decoupled from any specific provider implementation.
 *
 * Filename scheme (no seq dependency):
 *   Screenshots:   <isoTs-fs-safe>-<random6>-<tool>.png
 *   DOM snapshots: <isoTs-fs-safe>-<random6>.html.gz
 *
 * The ISO timestamp uses ':' → '-' and '.' → '-' so filenames are safe on
 * Windows and POSIX alike. Six hex bytes of randomness prevent collisions
 * when sibling subagents write screenshots concurrently in the same session.
 *
 * Seq alignment with the trace JSONL is NOT required: the trace event
 * references the sidecar path inline, so readers correlate by path rather
 * than by seq. This differs from the compaction sidecar pattern in
 * `src/agent/trace/writer.ts`, which embeds seq to support sort-by-arrival.
 *
 * @module browser/witness
 */

import { randomBytes } from 'crypto';
import { mkdir, stat, writeFile } from 'fs/promises';
import { join } from 'path';
import { gzip } from 'zlib';
import { promisify } from 'util';

import { getTraceDir } from '../paths.js';
import { redactSecrets } from './sanitize.js';

const gzipAsync = promisify(gzip);

// ---------------------------------------------------------------------------
// Directory helpers (pure, no I/O)
// ---------------------------------------------------------------------------

/**
 * Root browser sidecar directory for the session.
 * Created lazily on first write.
 */
export function browserSidecarDir(sessionId: string): string {
  return join(getTraceDir(sessionId), 'browser');
}

/** Directory containing screenshot sidecars. */
export function screenshotsDir(sessionId: string): string {
  return join(browserSidecarDir(sessionId), 'screenshots');
}

/** Directory containing DOM snapshot sidecars. */
export function domSnapshotsDir(sessionId: string): string {
  return join(browserSidecarDir(sessionId), 'dom-snapshots');
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build a filesystem-safe ISO timestamp string from the current wall clock.
 *
 * Contract:
 *   - Input: Date.prototype.toISOString() → "2026-05-20T14:30:00.123Z"
 *   - ':' and '.' are replaced with '-' → "2026-05-20T14-30-00-123Z"
 *   - The result is safe for use in filenames on all target platforms.
 */
function safeTsNow(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Six hex characters of randomness from crypto.randomBytes(3).
 * Prevents filename collisions when concurrent subagents write sidecars
 * inside the same session directory at the same wall-clock millisecond.
 */
function random6Hex(): string {
  return randomBytes(3).toString('hex');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Write a screenshot buffer to a sidecar file under the session's witness dir.
 * Returns the absolute path and byte count. Creates the screenshots/
 * subdirectory on first call.
 *
 * Filename pattern: `<isoTs-fs-safe>-<random6>-<tool>.png`
 *
 * Contract:
 *   @param sessionId  AFK session identifier; drives the directory path.
 *   @param buffer     Raw PNG bytes from the browser provider.
 *   @param tool       Which browser tool produced this screenshot.
 *   @returns          { path: absolute path written, bytes: file size }
 */
const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024; // 5 MiB

export async function writeScreenshotSidecar(
  sessionId: string,
  buffer: Buffer,
  tool: 'browser_open' | 'browser_observe' | 'browser_act' | 'browser_screenshot' | 'browser_extract',
): Promise<{ path: string; bytes: number }> {
  if (buffer.length > MAX_SCREENSHOT_BYTES) {
    throw new Error(
      `writeScreenshotSidecar: buffer exceeds ${MAX_SCREENSHOT_BYTES} byte cap ` +
        `(received ${buffer.length} bytes). Refusing to write oversized screenshot.`,
    );
  }

  const dir = screenshotsDir(sessionId);
  await mkdir(dir, { recursive: true });

  const filename = `${safeTsNow()}-${random6Hex()}-${tool}.png`;
  const filePath = join(dir, filename);

  await writeFile(filePath, buffer);

  const { size } = await stat(filePath);
  return { path: filePath, bytes: size };
}

/**
 * Write a gzipped DOM snapshot. Phase 2 opt-in — callers gate on
 * AFK_BROWSER_DOM_SNAPSHOTS before calling. Returns the absolute path and
 * the compressed byte count written to disk.
 *
 * Filename pattern: `<isoTs-fs-safe>-<random6>.html.gz`
 *
 * Contract:
 *   @param sessionId  AFK session identifier; drives the directory path.
 *   @param html       Raw HTML string. Gzip compression is applied here.
 *   @returns          { path: absolute path written, bytes: compressed size }
 */
export async function writeDomSnapshotSidecar(
  sessionId: string,
  html: string,
): Promise<{ path: string; bytes: number }> {
  const dir = domSnapshotsDir(sessionId);
  await mkdir(dir, { recursive: true });

  const filename = `${safeTsNow()}-${random6Hex()}.html.gz`;
  const filePath = join(dir, filename);

  // SECURITY: redact credential-shaped substrings before persisting the DOM.
  // redactSecrets covers AWS keys, GitHub PATs, OpenAI bearer tokens, Slack
  // tokens, JWTs, and form-encoded passwords.
  const sanitizedHtml = redactSecrets(html);
  const compressed = await gzipAsync(Buffer.from(sanitizedHtml, 'utf8'));
  await writeFile(filePath, compressed);

  const { size } = await stat(filePath);
  return { path: filePath, bytes: size };
}
