/** Safe LSP WorkspaceEdit adapter: all mutations use the normal patch_apply path. */
import { randomUUID } from 'node:crypto';
import { readFile, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LspClient } from '../../lsp/client.js';
import type { ToolHandlerContext, ToolResult } from '../types.js';
import { validatedWriteTarget } from '../../file-checkpoint/write-policy.js';
import { createPatchApplyHandler } from './patch-apply.js';
import { sha256Hex, type PatchFileChange } from './patch-validate.js';
import { decidePathAccess } from './path-policy.js';
import { resolveAndContain } from './_cwd-utils.js';
import { errorMessage } from '../../../utils/errors.js';
import { applyTextEdits, workspaceDocuments } from './lsp-workspace-edit-parse.js';

export interface WorkspaceEditOptions {
  cwd: string;
  context?: ToolHandlerContext;
  signal?: AbortSignal;
  dryRun?: boolean;
  client?: Pick<LspClient, 'syncFile'>;
  /** Numeric TextDocumentEdit versions fail closed without this lookup. */
  documentVersion?: (uri: string) => number | undefined;
  /**
   * Request-time snapshot (required: every target gets a staleness guard).
   * Open documents must equal the text synchronized at snapshot time; every
   * other target is rejected when its mtime or ctime is later than
   * `requestStartedAt`. Capture both before sending the request. Residuals
   * (see assertUnchangedSinceRequest): stale server caches, same-tick writes,
   * and a workspace on a different filesystem clock than os.tmpdir().
   */
  expectedContents: ReadonlyMap<string, string>;
  /** `fileClockNow()` (a FILE timestamp, never `Date.now()`) taken with `expectedContents`. */
  requestStartedAt: number;
  /**
   * Canonical target path -> text this caller itself wrote after the snapshot
   * (e.g. earlier edits of one command). Takes precedence over both checks above.
   */
  writtenContents?: ReadonlyMap<string, string>;
  /** Called with canonical path -> written text when every change was applied. */
  onApplied?: (written: ReadonlyMap<string, string>) => void;
}

/**
 * Current time on the filesystem clock: the mtime of a short-lived sentinel in
 * os.tmpdir() (never the user's workspace). Staleness compares file timestamps
 * only with other file timestamps; `Date.now()` is a different clock (coarse
 * ticks on Windows) and is never used for that comparison.
 */
export async function fileClockNow(): Promise<number> {
  const sentinel = nodePath.join(os.tmpdir(), `afk-lsp-clock-${randomUUID()}`);
  await writeFile(sentinel, '', { flag: 'wx' });
  try {
    return (await stat(sentinel)).mtimeMs;
  } finally {
    await unlink(sentinel).catch(() => {});
  }
}

interface PlannedDocument { change: PatchFileChange; sourcePath: string }

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Aborted');
}

function localFile(uri: string): string {
  const url = new URL(uri);
  if (url.protocol !== 'file:' || url.host || url.search || url.hash) {
    throw new Error('WorkspaceEdit requires local file URIs without query or fragment');
  }
  const path = fileURLToPath(url);
  if (path.includes('\0')) throw new Error('WorkspaceEdit URI contains NUL');
  if (path.startsWith('//')) throw new Error('WorkspaceEdit URI resolved to a network path');
  return path;
}

// Contract: reject a target with positive evidence of change after the request
// snapshot. Servers answer for non-open documents from disk, so `version: null`
// is normal there; staleness is decided by evidence, not by version knowledge.
// 1. Text this caller wrote itself (`writtenContents`, canonical path) must
//    equal the current disk text exactly.
// 2. A document open at snapshot time must equal its snapshot text exactly.
// 3. Any other target: evidence = mtime or ctime inside (requestStartedAt, now],
//    where BOTH bounds are sentinel-file timestamps (`fileClockNow`), so the
//    comparison never mixes the file clock with the JavaScript clock. ctime
//    catches mtime-preserving writes; a timestamp above `now` (future-dated) is
//    not evidence. Stat runs AFTER the read; `now` is taken after the stat;
//    patch_apply's sha256 guard covers read-to-write.
// Residuals: a server cache already stale BEFORE the request is not detectable;
// a write within the same timestamp tick as the snapshot ties and is accepted
// (resolution: coarse kernel ticks on Linux, 1-2 s on FAT/HFS+/some mounts); a
// workspace on a different filesystem or volume than os.tmpdir() (network mount,
// other volume) is compared across clocks and resolutions; a filesystem clock
// step between snapshot and check shifts both bounds equally, so the window
// width is preserved but its absolute position moves.
async function assertUnchangedSinceRequest(path: string, uri: string, before: string, options: WorkspaceEditOptions): Promise<void> {
  const written = options.writtenContents?.get(path);
  const expected = written ?? options.expectedContents.get(uri);
  if (expected !== undefined) {
    if (before !== expected) throw new Error('WorkspaceEdit document changed during request');
    return;
  }
  const { mtimeMs, ctimeMs } = await stat(path);
  const now = await fileClockNow();
  const inWindow = (ms: number) => ms > options.requestStartedAt && ms <= now;
  if (inWindow(mtimeMs) || inWindow(ctimeMs)) {
    throw new Error(`WorkspaceEdit target modified after the request was sent: ${uri}`);
  }
}

async function planWorkspaceEdit(edit: unknown, options: WorkspaceEditOptions): Promise<PlannedDocument[]> {
  checkAbort(options.signal);
  const documents = workspaceDocuments(edit);
  const paths = new Set<string>();
  // Resolve every destination through the SAME grants/denylist/canonicalization
  // as patch_apply, before reading any file or taking a checkpoint.
  const targets: Array<{ path: string; sourcePath: string; document: typeof documents[number] }> = [];
  for (const document of documents) {
    checkAbort(options.signal);
    if (document.version !== null && document.version !== undefined &&
        options.documentVersion?.(document.uri) !== document.version) {
      throw new Error(`WorkspaceEdit document version mismatch: ${document.uri}`);
    }
    const sourcePath = localFile(document.uri);
    const path = await validatedWriteTarget(sourcePath, options.context, options.cwd);
    // Patch previews contain old content: never expose a read-denylisted secret,
    // even if it is allowed by the (intentionally different) write denylist.
    if (decidePathAccess(sourcePath, 'read').kind === 'deny' || decidePathAccess(path, 'read').kind === 'deny') {
      throw new Error('WorkspaceEdit target is a protected credential path');
    }
    if (paths.has(path)) throw new Error(`WorkspaceEdit has duplicate physical target: ${path}`);
    paths.add(path);
    targets.push({ path, sourcePath, document });
  }
  const planned: PlannedDocument[] = [];
  for (const { path, sourcePath, document } of targets) {
    checkAbort(options.signal);
    // Text edits cannot implicitly create files. Fatal UTF-8 decoding prevents
    // replacement characters from corrupting binary / non-UTF-8 documents.
    const before = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await readFile(path));
    if (before.includes('\0')) throw new Error('WorkspaceEdit cannot edit binary files');
    await assertUnchangedSinceRequest(path, document.uri, before, options);
    const content = applyTextEdits(before, document.edits);
    if (content !== before) {
      planned.push({ sourcePath, change: { path, content, expected_hash: `sha256:${sha256Hex(before)}` } });
    }
  }
  checkAbort(options.signal);
  return planned;
}

/** Convert validated UTF-16 edits to hash-guarded full-content patch changes; no writes. */
export async function convertWorkspaceEdit(edit: unknown, options: WorkspaceEditOptions): Promise<PatchFileChange[]> {
  return (await planWorkspaceEdit(edit, options)).map(({ change }) => change);
}

/**
 * One patch handler invocation -> one applyPatch transaction, including its
 * write grants, canonical snapshots, hashes, denylist and best-effort rollback.
 * Conversion failures never write or snapshot. A failed resync is reported as
 * a warning on the successful write, NOT a misleading mutation failure.
 */
export async function applyWorkspaceEdit(edit: unknown, options: WorkspaceEditOptions): Promise<ToolResult> {
  let planned: PlannedDocument[];
  try {
    planned = await planWorkspaceEdit(edit, options);
  } catch (err) {
    return { isError: true, content: JSON.stringify({ status: 'validation_failed', diff: '', files_changed: [],
      errors: [{ error: 'workspace_edit_invalid', detail: errorMessage(err) }] }) };
  }
  let result: ToolResult;
  try {
    result = await createPatchApplyHandler(options.cwd)(
      { changes: planned.map(({ change }) => change), dry_run: options.dryRun ?? false },
      options.signal ?? new AbortController().signal, options.context,
    );
  } catch (err) {
    // The normal handler may throw on checkpoint I/O; it has not applied yet.
    return { isError: true, content: JSON.stringify({ status: 'validation_failed', files_changed: [],
      errors: [{ error: 'workspace_edit_apply_failed', detail: errorMessage(err) }] }) };
  }
  const payload = JSON.parse(result.content) as { status?: string; sync_warnings?: string[] };
  if (payload.status === 'applied' && !options.dryRun) {
    const written = new Map<string, string>();
    for (const { change } of planned) if (change.content !== undefined) written.set(change.path, change.content);
    options.onApplied?.(written);
  }
  if (options.client && (payload.status === 'applied' || payload.status === 'partial_failure') && !options.dryRun) {
    const warnings: string[] = [];
    // Read actual disk state, including after the engine's best-effort rollback.
    // Sync both spellings for an originally-open symlink document.
    for (const path of new Set(planned.flatMap(({ change, sourcePath }) => [change.path, sourcePath]))) {
      try {
        // The source spelling may be a symlink retargeted since planning.
        // Recheck read policy before syncFile reads and sends its text to LSP.
        resolveAndContain(path, options.context, 'read', options.cwd);
        await options.client.syncFile(path);
      } catch (err) { warnings.push(`${path}: ${errorMessage(err)}`); }
    }
    if (warnings.length) {
      payload.sync_warnings = warnings;
      result = { ...result, content: JSON.stringify(payload), incomplete: true, incompleteReason: 'LSP document resync failed after patch' };
    }
  }
  return result;
}
