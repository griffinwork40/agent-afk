import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';

import { getSessionBlobsDir, getSessionsDir } from '../../paths.js';
import { useTmpAfkHome } from './__test-utils__/helpers.js';
import { extForMediaType, resolveBlobPath } from './blobs.js';
import { findToolResult, hydrateMessages, loadJournalMessages, readJournalRecords } from './reader.js';
import { PREVIEW_CHARS, SPILL_TEXT_BYTES } from './spill.js';
import type { BlobRef, JournalMessage } from './types.js';
import { createMessageJournal } from './writer.js';

useTmpAfkHome();
afterEach(() => vi.restoreAllMocks());

const big = 'x'.repeat(SPILL_TEXT_BYTES + 10);
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

function heavyMessage(): JournalMessage {
  return {
    role: 'user',
    content: [
      { type: 'text', text: big },
      { type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: png.toString('base64') } },
      {
        type: 'tool_result',
        toolUseId: 'tu-big',
        content: [
          { type: 'text', text: big },
          { type: 'text', text: 'small' },
          { type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: png.toString('base64') } },
        ],
      },
      { type: 'document', source: { kind: 'base64', mediaType: 'application/pdf', data: Buffer.from('%PDF').toString('base64') } },
    ],
  };
}

describe('spill policy', () => {
  it('spills large text + base64 binaries to deduped blobs and hydrates them back', async () => {
    const j = createMessageJournal({ getSessionId: () => 'spill' });
    const original = heavyMessage();
    const snapshot = JSON.parse(JSON.stringify(original)) as JournalMessage;
    j.append(0, original);
    j.append(1, heavyMessage());
    await j.flush();
    expect(original).toEqual(snapshot); // input not mutated

    const blobs = fs.readdirSync(getSessionBlobsDir('spill')).sort();
    expect(blobs).toEqual([`${sha(Buffer.from('%PDF'))}.pdf`, `${sha(png)}.png`, `${sha(big)}.txt`].sort());
    for (const b of blobs) {
      if (process.platform !== 'win32') expect(fs.statSync(join(getSessionBlobsDir('spill'), b)).mode & 0o777).toBe(0o600);
    }
    if (process.platform !== 'win32') expect(fs.statSync(getSessionBlobsDir('spill')).mode & 0o777).toBe(0o700);

    const rec = readJournalRecords('spill').find((r) => r.kind === 'append')!;
    if (rec.kind !== 'append') throw new Error('unreachable');
    const [t, img, tr] = rec.message.content;
    expect(t).toMatchObject({ type: 'text_ref', preview: big.slice(0, PREVIEW_CHARS) });
    const ref = (t as { ref: BlobRef }).ref;
    expect(ref).toEqual({ path: `spill/blobs/${sha(big)}.txt`, bytes: big.length, sha256: sha(big), mediaType: 'text/plain' });
    expect(resolveBlobPath(ref)).toBe(join(getSessionsDir(), 'spill', 'blobs', `${sha(big)}.txt`));
    expect(img).toMatchObject({ type: 'image', source: { kind: 'ref' } });
    expect(tr).toMatchObject({ type: 'tool_result', content: [{ type: 'text_ref' }, { type: 'text', text: 'small' }, { type: 'image', source: { kind: 'ref' } }] });
    expect(fs.readFileSync(join(getSessionsDir(), 'spill', 'journal.jsonl'), 'utf8').length).toBeLessThan(SPILL_TEXT_BYTES);

    const loaded = loadJournalMessages('spill')!;
    expect(loaded).toEqual([heavyMessage(), heavyMessage()]);
  });

  it('keeps text at exactly the threshold inline', async () => {
    const j = createMessageJournal({ getSessionId: () => 'edge' });
    j.append(0, { role: 'user', content: [{ type: 'text', text: 'y'.repeat(SPILL_TEXT_BYTES) }] });
    await j.flush();
    expect(fs.existsSync(getSessionBlobsDir('edge'))).toBe(false);
  });

  it('degrades a missing blob to a text part naming what was lost', async () => {
    const j = createMessageJournal({ getSessionId: () => 'lost' });
    j.append(0, heavyMessage());
    await j.flush();
    fs.rmSync(getSessionBlobsDir('lost'), { recursive: true });
    const [m] = loadJournalMessages('lost')!;
    const [t, img, tr] = m!.content;
    expect(t).toMatchObject({ type: 'text' });
    expect((t as { text: string }).text).toMatch(/^\[journal: spilled text lost\/blobs\/.*\.txt .* is missing; preview follows\]\nxxx/);
    expect((img as { text: string }).text).toMatch(/\[journal: image .*\.png .* is missing\]/);
    const parts = (tr as { content: Array<{ type: string; text?: string }> }).content;
    expect(parts.map((p) => p.type)).toEqual(['text', 'text', 'text']);
    expect(parts[0]!.text).toContain('is missing');
    const found = findToolResult('lost', 'tu-big')!;
    expect(found.block.content[0]).toMatchObject({ type: 'text' });
  });

  it('refuses refs that escape the sessions root', () => {
    const evil: BlobRef = { path: '../../etc/passwd', bytes: 1, sha256: 'x', mediaType: 'text/plain' };
    expect(resolveBlobPath(evil)).toBeNull();
    expect(resolveBlobPath({ ...evil, path: '/etc/passwd' })).toBeNull();
    const [m] = hydrateMessages([{ role: 'user', content: [{ type: 'text_ref', ref: evil, preview: '' }] }]);
    expect(m!.content[0]).toMatchObject({ type: 'text' });
    expect((m!.content[0] as { text: string }).text).toContain('is missing]');
  });

  it('reuses an existing blob with the same hash (dedup across writers)', async () => {
    const a = createMessageJournal({ getSessionId: () => 'dedup' });
    a.append(0, heavyMessage());
    await a.close();
    const blobPath = join(getSessionBlobsDir('dedup'), `${sha(png)}.png`);
    const before = fs.statSync(blobPath).ino;
    const b = createMessageJournal({ getSessionId: () => 'dedup' });
    b.append(1, heavyMessage());
    await b.close();
    expect(fs.statSync(blobPath).ino).toBe(before);
    expect(fs.readdirSync(getSessionBlobsDir('dedup')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('replaces a torn blob with the right bytes', async () => {
    fs.mkdirSync(getSessionBlobsDir('torn-blob'), { recursive: true });
    fs.writeFileSync(join(getSessionBlobsDir('torn-blob'), `${sha(png)}.png`), 'x');
    const j = createMessageJournal({ getSessionId: () => 'torn-blob' });
    j.append(0, { role: 'user', content: [{ type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: png.toString('base64') } }] });
    await j.flush();
    const [m] = loadJournalMessages('torn-blob')!;
    expect(m!.content[0]).toMatchObject({ source: { kind: 'base64', data: png.toString('base64') } });
  });

  it('writes the record inline when the blob store is unwritable', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    fs.mkdirSync(join(getSessionsDir(), 'noblob'), { recursive: true });
    fs.writeFileSync(getSessionBlobsDir('noblob'), 'file in the way');
    const j = createMessageJournal({ getSessionId: () => 'noblob' });
    j.append(0, heavyMessage());
    await j.flush();
    const rec = readJournalRecords('noblob').find((r) => r.kind === 'append');
    expect(rec && rec.kind === 'append' ? rec.message : null).toEqual(heavyMessage());
  });

  it('maps media types to extensions', () => {
    expect(extForMediaType('image/jpeg')).toBe('jpg');
    expect(extForMediaType('image/x-icon')).toBe('xicon');
    expect(extForMediaType('weird')).toBe('bin');
    expect(extForMediaType('text/plain; charset=utf-8')).toBe('txt');
  });
});
