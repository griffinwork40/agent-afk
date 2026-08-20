/**
 * Handler for the `extract_document` tool.
 *
 * Extracts text from binary document formats (.docx, .pdf, .xlsx, .pptx, .zip)
 * that `read_file` rejects at its null-byte check. Zero npm dependencies for
 * Office formats (OOXML is just zipped XML); PDF delegates to `pdftotext`
 * (poppler-utils) via subprocess with an explicit argv array — no shell string.
 *
 * Security: 4 MB decompression cap, zip-slip path containment, explicit argv
 * (no shell injection surface), read-only (`category: 'read'`).
 *
 * @module agent/tools/handlers/extract-document
 */

import { promises as fs } from 'fs';
import { spawn } from 'child_process';
import { extname, basename, normalize, isAbsolute } from 'path';
import { createInflateRaw } from 'zlib';
import type { ToolHandler, ToolHandlerContext } from '../types.js';
import { resolveAndContain } from './_cwd-utils.js';
import { fsErrorToToolResult } from './_fs-error.js';

/** Max decompressed bytes before we stop reading (4 MB). */
const MAX_DECOMPRESSED_BYTES = 4 * 1024 * 1024;

/** Max output text length returned to the model (512 KB of text). */
const MAX_OUTPUT_CHARS = 512 * 1024;

// ── ZIP Central-Directory parser (minimal, no npm deps) ──────────────

interface ZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod: number;
  localHeaderOffset: number;
}

/**
 * Parse the ZIP central directory from a buffer. Returns entries in order.
 * Throws on malformed archives or if the end-of-central-directory record
 * is not found (not a ZIP file).
 */
function parseZipEntries(buf: Buffer): ZipEntry[] {
  // Find End of Central Directory (EOCD) — scan backwards from end.
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 65557; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocdOffset = i; break; }
  }
  if (eocdOffset === -1) throw new Error('Not a valid ZIP file (no EOCD record)');

  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  const cdEntries = buf.readUInt16LE(eocdOffset + 10);
  const entries: ZipEntry[] = [];
  let pos = cdOffset;

  for (let i = 0; i < cdEntries && pos + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) break;
    const compressionMethod = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const uncompressedSize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localHeaderOffset = buf.readUInt32LE(pos + 42);
    const name = buf.subarray(pos + 46, pos + 46 + nameLen).toString('utf-8');
    entries.push({ name, compressedSize, uncompressedSize, compressionMethod, localHeaderOffset });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * Zip-slip guard: reject entry names that escape the archive root.
 * Rejects absolute paths and `..` traversal.
 */
function isSafeZipEntryName(name: string): boolean {
  if (isAbsolute(name)) return false;
  const normalized = normalize(name);
  if (normalized.startsWith('..')) return false;
  return true;
}

/**
 * Extract raw bytes of a single entry from the ZIP buffer.
 * Handles stored (method 0) and deflated (method 8) entries.
 */
async function extractEntryBytes(buf: Buffer, entry: ZipEntry): Promise<Buffer> {
  if (entry.uncompressedSize > MAX_DECOMPRESSED_BYTES) {
    throw new Error(`Entry ${entry.name} too large (${entry.uncompressedSize} bytes, cap ${MAX_DECOMPRESSED_BYTES})`);
  }
  const lhOff = entry.localHeaderOffset;
  if (lhOff + 30 > buf.length || buf.readUInt32LE(lhOff) !== 0x04034b50) {
    throw new Error(`Invalid local header for ${entry.name}`);
  }
  const localNameLen = buf.readUInt16LE(lhOff + 26);
  const localExtraLen = buf.readUInt16LE(lhOff + 28);
  const dataStart = lhOff + 30 + localNameLen + localExtraLen;
  const raw = buf.subarray(dataStart, dataStart + entry.compressedSize);

  if (entry.compressionMethod === 0) return Buffer.from(raw);
  if (entry.compressionMethod === 8) {
    return new Promise<Buffer>((res, rej) => {
      const inflate = createInflateRaw();
      const chunks: Buffer[] = [];
      let total = 0;
      inflate.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_DECOMPRESSED_BYTES) { inflate.destroy(); rej(new Error('Decompression cap exceeded')); return; }
        chunks.push(chunk);
      });
      inflate.on('end', () => res(Buffer.concat(chunks)));
      inflate.on('error', rej);
      inflate.end(raw);
    });
  }
  throw new Error(`Unsupported compression method ${entry.compressionMethod} for ${entry.name}`);
}

// ── Format extractors ────────────────────────────────────────────────

/** Strip XML tags and collapse whitespace. Handles <w:t>, <w:p>, etc. */
function stripXmlToText(xml: string): string {
  return xml
    .replace(/<w:p\b[^>]*\/>/g, '\n')          // self-closing paragraphs → newline
    .replace(/<\/w:p>/g, '\n')                  // paragraph close → newline
    .replace(/<w:tab\/>/g, '\t')                // tabs
    .replace(/<w:br[^>]*\/>/g, '\n')            // breaks
    .replace(/<w:del\b[^>]*>[\s\S]*?<\/w:del>/g, '') // remove tracked deletions
    .replace(/<[^>]+>/g, '')                    // strip remaining tags
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\n{3,}/g, '\n\n')                 // collapse triple+ newlines
    .trim();
}

async function extractDocx(buf: Buffer): Promise<string> {
  const entries = parseZipEntries(buf);
  const docEntry = entries.find(e => e.name === 'word/document.xml');
  if (!docEntry) return '[Error: word/document.xml not found in .docx archive]';
  const xml = (await extractEntryBytes(buf, docEntry)).toString('utf-8');
  return stripXmlToText(xml);
}

async function extractXlsx(buf: Buffer): Promise<string> {
  const entries = parseZipEntries(buf);
  // Read shared strings first
  const ssEntry = entries.find(e => e.name === 'xl/sharedStrings.xml');
  const strings: string[] = [];
  if (ssEntry) {
    const ssXml = (await extractEntryBytes(buf, ssEntry)).toString('utf-8');
    const re = /<t[^>]*>([\s\S]*?)<\/t>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(ssXml)) !== null) strings.push(m[1]!);
  }
  // Read each sheet
  const sheetEntries = entries.filter(e => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name)).sort();
  const sheets: string[] = [];
  for (const se of sheetEntries) {
    const xml = (await extractEntryBytes(buf, se)).toString('utf-8');
    const rows: string[] = [];
    const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
    let rowMatch: RegExpExecArray | null;
    while ((rowMatch = rowRe.exec(xml)) !== null) {
      const cells: string[] = [];
      const cellRe = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;
      let cellMatch: RegExpExecArray | null;
      while ((cellMatch = cellRe.exec(rowMatch[1]!)) !== null) {
        const attrs = cellMatch[1]!;
        const inner = cellMatch[2]!;
        const valMatch = inner.match(/<v>([\s\S]*?)<\/v>/);
        if (!valMatch) { cells.push(''); continue; }
        const val = valMatch[1]!;
        // t="s" → shared string index; otherwise literal value
        cells.push(attrs.includes('t="s"') ? (strings[parseInt(val, 10)] ?? val) : val);
      }
      rows.push(cells.join('\t'));
    }
    sheets.push(`--- ${basename(se.name)} ---\n${rows.join('\n')}`);
  }
  return sheets.join('\n\n') || '[No sheet data found]';
}

async function extractPptx(buf: Buffer): Promise<string> {
  const entries = parseZipEntries(buf);
  const slideEntries = entries.filter(e => /^ppt\/slides\/slide\d+\.xml$/.test(e.name)).sort();
  const slides: string[] = [];
  for (const se of slideEntries) {
    const xml = (await extractEntryBytes(buf, se)).toString('utf-8');
    const text = stripXmlToText(xml);
    if (text) slides.push(`--- Slide ${slides.length + 1} ---\n${text}`);
  }
  return slides.join('\n\n') || '[No slide text found]';
}

async function extractZip(buf: Buffer): Promise<string> {
  const entries = parseZipEntries(buf);
  const lines = [`Archive contains ${entries.length} entries:\n`];
  const textEntries: { name: string; text: string }[] = [];
  for (const e of entries) {
    const sizeInfo = e.uncompressedSize > 0 ? ` (${e.uncompressedSize} bytes)` : '';
    lines.push(`  ${e.name}${sizeInfo}`);
    if (e.name.endsWith('/') || !isSafeZipEntryName(e.name)) continue;
    // Extract text-like members (by extension)
    const ext = extname(e.name).toLowerCase();
    if (['.txt', '.md', '.csv', '.json', '.xml', '.html', '.yml', '.yaml', '.log', '.ini', '.cfg', '.toml'].includes(ext)) {
      if (e.uncompressedSize <= MAX_DECOMPRESSED_BYTES) {
        try {
          const data = await extractEntryBytes(buf, e);
          // Quick binary check (null bytes in first 1KB)
          const check = Math.min(1024, data.length);
          let isBinary = false;
          for (let i = 0; i < check; i++) { if (data[i] === 0) { isBinary = true; break; } }
          if (!isBinary) textEntries.push({ name: e.name, text: data.toString('utf-8') });
        } catch { /* skip unextractable entries */ }
      }
    }
  }
  if (textEntries.length > 0) {
    lines.push('\n--- Text file contents ---');
    for (const te of textEntries) {
      lines.push(`\n=== ${te.name} ===\n${te.text}`);
    }
  }
  return lines.join('\n');
}

async function extractPdf(filePath: string, signal: AbortSignal): Promise<string> {
  return new Promise<string>((res, rej) => {
    // Explicit argv array — no shell string, no injection surface.
    const child = spawn('pdftotext', [filePath, '-'], { stdio: ['ignore', 'pipe', 'pipe'], signal });
    const chunks: Buffer[] = [];
    let total = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total <= MAX_DECOMPRESSED_BYTES) chunks.push(chunk);
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        res('[pdftotext not found. Install poppler-utils to extract PDF text:\n' +
          '  macOS:  brew install poppler\n' +
          '  Linux:  apt install poppler-utils (or yum install poppler-utils)\n]');
      } else {
        rej(err);
      }
    });
    child.on('close', (code) => {
      if (code !== 0) { res(`[pdftotext failed (exit ${code}): ${stderr.trim()}]`); return; }
      const text = Buffer.concat(chunks).toString('utf-8').trim();
      res(text || '[PDF contains no extractable text (may be image-only)]');
    });
  });
}

// ── Main handler ─────────────────────────────────────────────────────

const SUPPORTED_EXTS = new Set(['.docx', '.pdf', '.xlsx', '.pptx', '.zip']);

const extractDocumentImpl = async (
  input: unknown,
  signal: AbortSignal,
  context: ToolHandlerContext | undefined,
  cwd: string | undefined,
) => {
  if (!input || typeof input !== 'object') {
    return { content: 'Invalid input: expected an object', isError: true };
  }
  const obj = input as Record<string, unknown>;
  const rawPath = obj['file_path'];
  if (typeof rawPath !== 'string') {
    return { content: 'Invalid input: file_path must be a string', isError: true };
  }

  let filePath: string;
  try {
    filePath = resolveAndContain(rawPath, context, 'read', cwd);
  } catch (err) {
    return { content: err instanceof Error ? err.message : String(err), isError: true };
  }

  const ext = extname(filePath).toLowerCase();
  if (!SUPPORTED_EXTS.has(ext)) {
    return {
      content: `Unsupported format "${ext}". extract_document supports: ${[...SUPPORTED_EXTS].join(', ')}`,
      isError: true,
    };
  }

  try {
    // PDF uses subprocess — no buffer read needed
    if (ext === '.pdf') {
      const text = await extractPdf(filePath, signal);
      return { content: text.length > MAX_OUTPUT_CHARS ? text.slice(0, MAX_OUTPUT_CHARS) + '\n\n[… truncated]' : text };
    }

    // All other formats are ZIP-based — read into buffer
    const stat = await fs.stat(filePath);
    if (stat.size > MAX_DECOMPRESSED_BYTES * 2) {
      return { content: `File too large (${stat.size} bytes). Max supported: ${MAX_DECOMPRESSED_BYTES * 2} bytes.`, isError: true };
    }
    const buf = await fs.readFile(filePath);

    let text: string;
    switch (ext) {
      case '.docx': text = await extractDocx(buf); break;
      case '.xlsx': text = await extractXlsx(buf); break;
      case '.pptx': text = await extractPptx(buf); break;
      case '.zip':  text = await extractZip(buf);  break;
      default:      text = '[Unsupported format]';  break;
    }
    return { content: text.length > MAX_OUTPUT_CHARS ? text.slice(0, MAX_OUTPUT_CHARS) + '\n\n[… truncated]' : text };
  } catch (err) {
    const known = fsErrorToToolResult(err, filePath, 'File');
    if (known) return known;
    if (err instanceof Error) return { content: `Error extracting document: ${err.message}`, isError: true };
    return { content: 'Unknown error extracting document', isError: true };
  }
};

export function createExtractDocumentHandler(cwd?: string): ToolHandler {
  return (input, signal, context) => extractDocumentImpl(input, signal, context, cwd);
}

export const extractDocumentHandler: ToolHandler = createExtractDocumentHandler();
