/**
 * Desktop backend interface types.
 *
 * The backend is the platform-native layer that actually takes a screenshot.
 * Tranche 1 implements macOS (screencapture) and Windows (PowerShell/.NET).
 * Linux is unsupported and refused. WSL2 is refused (native Windows required).
 *
 * @module desktop/types
 */

// ---------------------------------------------------------------------------
// Screenshot input / output
// ---------------------------------------------------------------------------

/**
 * Optional region rectangle for a partial-screen capture.
 * All values are in logical (CSS) pixels at scale 1.
 */
export interface DesktopRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Input accepted by the backend screenshot method. */
export interface DesktopScreenshotInput {
  /**
   * Zero-based display index. When omitted the backend captures the primary
   * display (index 0). Backends report the display actually used in the result.
   */
  displayIndex?: number;
  /**
   * Optional capture region in logical pixels. When omitted, the full display
   * is captured. Reported in the result so callers can map coordinates.
   */
  region?: DesktopRegion;
  /**
   * AbortSignal forwarded from the tool handler. The backend must pass this
   * to the child process (via the `signal` spawn option) so an interruption
   * terminates an in-flight capture. The backend must also check the signal
   * before spawning and return an aborted result when it is already aborted.
   */
  signal?: AbortSignal;
}

/**
 * Result returned by a successful screenshot.
 *
 * Invariant: `dataBase64` must NEVER appear in a text content block visible to
 * the model — it is megabytes of raw image bytes. The handler maps it onto
 * `ToolResult.image` and keeps it out of `content`, mirroring `browser_screenshot`.
 */
export interface DesktopScreenshotResult {
  /** Absolute path to the written sidecar PNG. */
  path: string;
  /** File size in bytes. */
  bytes: number;
  /** Pixel width of the captured image. */
  width: number;
  /** Pixel height of the captured image. */
  height: number;
  /**
   * Display scale factor (e.g. 2 on a Retina/HiDPI display), or `null` when
   * the scale cannot be determined without a permission prompt or native API
   * call (full-display capture on macOS when no region is supplied and
   * `system_profiler` returns no match for the requested display).
   * Reported for coordinate-space transparency so later tranches can map
   * logical→physical pixels without guessing at the scale.
   */
  scaleFactor: number | null;
  /**
   * Zero-based index of the display that was actually captured (may differ
   * from the requested index when the request was clamped to the display
   * count).
   */
  displayIndex: number;
  /** Logical width of the captured region (or full display if no region). */
  logicalWidth: number;
  /** Logical height of the captured region (or full display if no region). */
  logicalHeight: number;
  /**
   * Base64-encoded raw PNG bytes (no `data:` URI prefix).
   * Kept separate from the sidecar so the tool handler can hand the pixels
   * to the model as an image content block.
   */
  dataBase64: string;
  /** Media type — always `image/png` in Tranche 1. */
  mediaType: 'image/png';
}

/**
 * Result returned when the AbortSignal fires before or during capture.
 * The handler must clean up any partial output file before returning this.
 */
export interface DesktopScreenshotAborted {
  aborted: true;
  reason: string;
}

// ---------------------------------------------------------------------------
// Backend interface
// ---------------------------------------------------------------------------

/**
 * Platform-specific desktop backend.
 *
 * Tranche 1 only requires `screenshot`. Input tools are added in Tranche 3M/3W
 * after the platform feasibility spikes complete.
 */
export interface DesktopBackend {
  /**
   * Capture a screenshot of the specified display / region.
   *
   * Returns `DesktopScreenshotAborted` when the AbortSignal fires before the
   * image bytes are available; in that case the backend must remove any
   * partial output file.
   *
   * Throws a `DesktopBackendError` on failure (permission denied, display out
   * of range, OS refusal, etc.). The error message is surfaced to the model
   * verbatim, so make it human-readable and actionable.
   */
  screenshot(
    input: DesktopScreenshotInput,
    sidecarPath: string,
  ): Promise<DesktopScreenshotResult | DesktopScreenshotAborted>;
}

// ---------------------------------------------------------------------------
// Structured error
// ---------------------------------------------------------------------------

/**
 * Error thrown by a backend when a desktop operation cannot be completed.
 * The `code` lets handlers apply special-case logic (e.g. `UNSUPPORTED_PLATFORM`
 * triggers a "set up desktop tools" message; `PERMISSION_DENIED` explains the
 * OS permission grant steps).
 */
export class DesktopBackendError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'UNSUPPORTED_PLATFORM'
      | 'PERMISSION_DENIED'
      | 'DISPLAY_NOT_FOUND'
      | 'CAPTURE_FAILED'
      | 'PROCESS_ERROR',
  ) {
    super(message);
    this.name = 'DesktopBackendError';
  }
}
