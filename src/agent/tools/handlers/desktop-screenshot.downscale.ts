import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_IMAGE_DIMENSION = 8000;
const MAX_BASE64_BYTES = 2 * 1024 * 1024;
// See desktop-screenshot.ts for the long-side derivation. Full-res sidecars are preserved.
export const ATTACHED_LONG_SIDE = 1092;

export type DesktopDownscale = (
  sourcePath: string, outPath: string, longSide: number, signal: AbortSignal,
) => Promise<Buffer | null>;

/** Best-effort macOS resize; aborts propagate to the handler via its signal check. */
export const downscaleWithSips: DesktopDownscale = async (sourcePath, outPath, longSide, signal) => {
  try {
    await execFileAsync(
      'sips',
      ['--resampleHeightWidthMax', String(longSide), sourcePath, '--out', outPath],
      { timeout: 15_000, signal },
    );
    const buf = await readFile(outPath);
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  } finally {
    await unlink(outPath).catch(() => undefined);
  }
};

interface AttachedImage {
  dataBase64: string;
  attachedWidth: number;
  attachedHeight: number;
}

/** Downscale only the attachment; temporary copies stay in the private directory. */
export async function buildAttachedImage(
  capturedBase64: string,
  capturedWidth: number,
  capturedHeight: number,
  sidecarPath: string,
  signal: AbortSignal,
  downscale?: DesktopDownscale,
): Promise<AttachedImage | null> {
  const needsResize = capturedWidth > MAX_IMAGE_DIMENSION ||
    capturedHeight > MAX_IMAGE_DIMENSION || capturedBase64.length > MAX_BASE64_BYTES;
  if (!needsResize) {
    return { dataBase64: capturedBase64, attachedWidth: capturedWidth, attachedHeight: capturedHeight };
  }
  if (!downscale && process.platform !== 'darwin') return null;
  const tmpOut = join(dirname(sidecarPath), `attach-${Date.now()}-${randomUUID()}.png`);
  const buf = await (downscale ?? downscaleWithSips)(sidecarPath, tmpOut, ATTACHED_LONG_SIDE, signal);
  if (!buf || buf.length < 24) return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const dataBase64 = buf.toString('base64');
  if (dataBase64.length > MAX_BASE64_BYTES || width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
    return null;
  }
  return { dataBase64, attachedWidth: width, attachedHeight: height };
}
