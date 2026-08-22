/**
 * Tests for the `extract_document` tool handler.
 *
 * Builds minimal fixture files in-memory (no checked-in binaries) using Node's
 * zlib to construct valid ZIP archives containing OOXML payloads.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { deflateRawSync } from 'zlib';
import { extractDocumentHandler, createExtractDocumentHandler } from './extract-document.js';
import type { ToolHandlerContext } from '../types.js';

const signal = new AbortController().signal;

// ── ZIP builder helpers ──────────────────────────────────────────────

/** Build a minimal ZIP file from an array of {name, data} entries. */
function buildZip(entries: { name: string; data: Buffer }[]): Buffer {
  const localHeaders: Buffer[] = [];
  const centralHeaders: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf-8');
    const compressed = deflateRawSync(entry.data);

    // Local file header
    const local = Buffer.alloc(30 + nameBytes.length + compressed.length);
    local.writeUInt32LE(0x04034b50, 0);  // signature
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0, 6);           // flags
    local.writeUInt16LE(8, 8);           // compression: deflate
    local.writeUInt16LE(0, 10);          // mod time
    local.writeUInt16LE(0, 12);          // mod date
    local.writeUInt32LE(0, 14);          // crc32 (not validated by our parser)
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);          // extra length
    nameBytes.copy(local, 30);
    compressed.copy(local, 30 + nameBytes.length);
    localHeaders.push(local);

    // Central directory header
    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);        // version made by
    central.writeUInt16LE(20, 6);        // version needed
    central.writeUInt16LE(0, 8);         // flags
    central.writeUInt16LE(8, 10);        // compression: deflate
    central.writeUInt16LE(0, 12);        // mod time
    central.writeUInt16LE(0, 14);        // mod date
    central.writeUInt32LE(0, 16);        // crc32
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);        // extra length
    central.writeUInt16LE(0, 32);        // comment length
    central.writeUInt16LE(0, 34);        // disk number
    central.writeUInt16LE(0, 36);        // internal attrs
    central.writeUInt32LE(0, 38);        // external attrs
    central.writeUInt32LE(offset, 42);   // local header offset
    nameBytes.copy(central, 46);
    centralHeaders.push(central);

    offset += local.length;
  }

  const cdOffset = offset;
  const cdSize = centralHeaders.reduce((a, b) => a + b.length, 0);

  // End of central directory
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);             // disk number
  eocd.writeUInt16LE(0, 6);             // cd start disk
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);            // comment length

  return Buffer.concat([...localHeaders, ...centralHeaders, eocd]);
}

/** Build a minimal .docx (ZIP with word/document.xml). */
function buildDocx(bodyXml: string): Buffer {
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:body>' + bodyXml + '</w:body></w:document>';
  return buildZip([{ name: 'word/document.xml', data: Buffer.from(xml, 'utf-8') }]);
}

// ── Tests ────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(join(tmpdir(), 'extract-doc-test-'));
});

afterEach(async () => {
  try { await fs.rm(tmpDir, { recursive: true }); } catch { /* best-effort */ }
});

describe('extractDocumentHandler', () => {
  describe('input validation', () => {
    it('rejects missing input', async () => {
      const result = await extractDocumentHandler(null, signal);
      expect(result.isError).toBe(true);
      expect(result.content).toContain('Invalid input');
    });

    it('rejects missing file_path', async () => {
      const result = await extractDocumentHandler({}, signal);
      expect(result.isError).toBe(true);
      expect(result.content).toContain('file_path must be a string');
    });

    it('rejects unsupported extension', async () => {
      const filePath = join(tmpDir, 'test.rtf');
      await fs.writeFile(filePath, 'test');
      const result = await extractDocumentHandler({ file_path: filePath }, signal);
      expect(result.isError).toBe(true);
      expect(result.content).toContain('Unsupported format');
      expect(result.content).toContain('.rtf');
    });
  });

  describe('.docx extraction', () => {
    it('extracts text from a minimal docx', async () => {
      const docx = buildDocx(
        '<w:p><w:r><w:t>Hello World</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>Second paragraph</w:t></w:r></w:p>',
      );
      const filePath = join(tmpDir, 'test.docx');
      await fs.writeFile(filePath, docx);
      const result = await extractDocumentHandler({ file_path: filePath }, signal);
      expect(result.isError).not.toBe(true);
      expect(result.content).toContain('Hello World');
      expect(result.content).toContain('Second paragraph');
    });

    it('strips tracked deletions from docx', async () => {
      const docx = buildDocx(
        '<w:p><w:r><w:t>Keep this</w:t></w:r>' +
        '<w:del><w:r><w:t>Remove this</w:t></w:r></w:del></w:p>',
      );
      const filePath = join(tmpDir, 'tracked.docx');
      await fs.writeFile(filePath, docx);
      const result = await extractDocumentHandler({ file_path: filePath }, signal);
      expect(result.content).toContain('Keep this');
      expect(result.content).not.toContain('Remove this');
    });

    it('handles XML entities', async () => {
      const docx = buildDocx(
        '<w:p><w:r><w:t>A &amp; B &lt; C</w:t></w:r></w:p>',
      );
      const filePath = join(tmpDir, 'entities.docx');
      await fs.writeFile(filePath, docx);
      const result = await extractDocumentHandler({ file_path: filePath }, signal);
      expect(result.content).toContain('A & B < C');
    });

    it('returns error for docx missing word/document.xml', async () => {
      const badDocx = buildZip([{ name: 'other.xml', data: Buffer.from('<x/>') }]);
      const filePath = join(tmpDir, 'bad.docx');
      await fs.writeFile(filePath, badDocx);
      const result = await extractDocumentHandler({ file_path: filePath }, signal);
      expect(result.content).toContain('word/document.xml not found');
    });
  });

  describe('.zip extraction', () => {
    it('lists members and extracts text files', async () => {
      const zip = buildZip([
        { name: 'readme.txt', data: Buffer.from('Hello from zip') },
        { name: 'data.csv', data: Buffer.from('a,b,c\n1,2,3') },
        { name: 'image.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]) },
      ]);
      const filePath = join(tmpDir, 'test.zip');
      await fs.writeFile(filePath, zip);
      const result = await extractDocumentHandler({ file_path: filePath }, signal);
      expect(result.isError).not.toBe(true);
      expect(result.content).toContain('3 entries');
      expect(result.content).toContain('readme.txt');
      expect(result.content).toContain('Hello from zip');
      expect(result.content).toContain('a,b,c');
      // Binary file (image.png) should be listed but not extracted as text
      expect(result.content).toContain('image.png');
    });

    it('skips zip entries with path traversal', async () => {
      const zip = buildZip([
        { name: '../escape.txt', data: Buffer.from('escaped') },
        { name: 'safe.txt', data: Buffer.from('safe content') },
      ]);
      const filePath = join(tmpDir, 'traversal.zip');
      await fs.writeFile(filePath, zip);
      const result = await extractDocumentHandler({ file_path: filePath }, signal);
      expect(result.content).toContain('safe content');
      // The traversal entry should be listed but its content should NOT be extracted
      expect(result.content).not.toContain('escaped');
    });
  });

  describe('.xlsx extraction', () => {
    it('extracts cell values from a minimal xlsx', async () => {
      const sharedStrings =
        '<?xml version="1.0"?><sst><si><t>Name</t></si><si><t>Alice</t></si></sst>';
      const sheet =
        '<?xml version="1.0"?><worksheet><sheetData>' +
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c></row>' +
        '<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>99</v></c></row>' +
        '</sheetData></worksheet>';
      const xlsx = buildZip([
        { name: 'xl/sharedStrings.xml', data: Buffer.from(sharedStrings) },
        { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheet) },
      ]);
      const filePath = join(tmpDir, 'test.xlsx');
      await fs.writeFile(filePath, xlsx);
      const result = await extractDocumentHandler({ file_path: filePath }, signal);
      expect(result.isError).not.toBe(true);
      expect(result.content).toContain('Name');
      expect(result.content).toContain('Alice');
      expect(result.content).toContain('42');
      expect(result.content).toContain('99');
    });
  });

  describe('.pptx extraction', () => {
    it('extracts slide text from a minimal pptx', async () => {
      const slide =
        '<?xml version="1.0"?><p:sld xmlns:a="urn:a" xmlns:p="urn:p">' +
        '<p:cSld><p:spTree><p:sp><p:txBody>' +
        '<a:p><a:r><a:t>Slide Title</a:t></a:r></a:p>' +
        '</p:txBody></p:sp></p:spTree></p:cSld></p:sld>';
      const pptx = buildZip([
        { name: 'ppt/slides/slide1.xml', data: Buffer.from(slide) },
      ]);
      const filePath = join(tmpDir, 'test.pptx');
      await fs.writeFile(filePath, pptx);
      const result = await extractDocumentHandler({ file_path: filePath }, signal);
      expect(result.isError).not.toBe(true);
      expect(result.content).toContain('Slide Title');
    });
  });

  describe('.pdf extraction', () => {
    it('returns install instructions when pdftotext is not available', async () => {
      // Write a minimal PDF-like binary (just needs the extension to trigger the path)
      const filePath = join(tmpDir, 'test.pdf');
      await fs.writeFile(filePath, Buffer.from('%PDF-1.4 fake'));
      const result = await extractDocumentHandler({ file_path: filePath }, signal);
      // On CI/test machines without poppler, this should give install instructions
      // On machines with pdftotext, it may succeed or fail on the fake PDF — both ok
      expect(result.isError).not.toBe(true);
      expect(typeof result.content).toBe('string');
    });
  });

  describe('error handling', () => {
    it('returns error for non-existent file', async () => {
      const result = await extractDocumentHandler(
        { file_path: join(tmpDir, 'nonexistent.docx') }, signal,
      );
      expect(result.isError).toBe(true);
    });

    it('returns error for invalid zip data with docx extension', async () => {
      const filePath = join(tmpDir, 'corrupt.docx');
      await fs.writeFile(filePath, 'not a zip file at all');
      const result = await extractDocumentHandler({ file_path: filePath }, signal);
      expect(result.isError).toBe(true);
      expect(result.content).toContain('Not a valid ZIP');
    });
  });

  describe('cwd containment', () => {
    it('rejects paths outside context.cwd', async () => {
      const context: ToolHandlerContext = { cwd: tmpDir };
      const result = await extractDocumentHandler(
        { file_path: '/etc/passwd.docx' }, signal, context,
      );
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/outside.*allowed|not allowed|Access denied/i);
    });

    it('factory handler uses cwd for containment', async () => {
      const handler = createExtractDocumentHandler(tmpDir);
      const result = await handler(
        { file_path: '/tmp/outside.docx' }, signal,
      );
      expect(result.isError).toBe(true);
    });
  });
});
