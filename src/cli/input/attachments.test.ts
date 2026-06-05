import { describe, it, expect } from 'vitest';
import {
  type ImageAttachment,
  formatSize,
  renderStatusLine,
  describeForHistory,
  describeAttachmentSummary,
} from './attachments.js';

const png = (size: number): ImageAttachment => ({
  id: 'png-' + size,
  mediaType: 'image/png',
  bytes: Buffer.alloc(size),
  sizeBytes: size,
});

const jpeg = (size: number): ImageAttachment => ({
  id: 'jpeg-' + size,
  mediaType: 'image/jpeg',
  bytes: Buffer.alloc(size),
  sizeBytes: size,
});

const gif = (size: number): ImageAttachment => ({
  id: 'gif-' + size,
  mediaType: 'image/gif',
  bytes: Buffer.alloc(size),
  sizeBytes: size,
});

const webp = (size: number): ImageAttachment => ({
  id: 'webp-' + size,
  mediaType: 'image/webp',
  bytes: Buffer.alloc(size),
  sizeBytes: size,
});

describe('formatSize', () => {
  it('formats 0 bytes', () => {
    expect(formatSize(0)).toBe('0 B');
  });

  it('formats small byte values without decimal', () => {
    expect(formatSize(512)).toBe('512 B');
  });

  it('formats 1024 bytes as 1.0 KiB', () => {
    expect(formatSize(1024)).toBe('1.0 KiB');
  });

  it('formats 1 MiB', () => {
    expect(formatSize(1024 * 1024)).toBe('1.0 MiB');
  });

  it('formats 1.2 MiB correctly', () => {
    expect(formatSize(Math.round(1024 * 1024 * 1.2))).toBe('1.2 MiB');
  });

  it('formats 245_000 bytes as 239.3 KiB', () => {
    expect(formatSize(245_000)).toBe('239.3 KiB');
  });
});

describe('renderStatusLine', () => {
  it('returns empty string for empty attachments', () => {
    expect(renderStatusLine([])).toBe('');
  });

  it('renders single PNG attachment', () => {
    expect(renderStatusLine([png(Math.round(245_000))])).toBe(
      '[1 image attached · 239.3 KiB · PNG · Ctrl+X to discard]'
    );
  });

  it('renders two different image types', () => {
    const result = renderStatusLine([png(1024), jpeg(2048)]);
    expect(result).toContain('2 images attached');
    expect(result).toContain('PNG, JPEG');
    expect(result).toMatch(/\d+(\.\d)? KiB/);
  });

  it('collapses duplicate types in the label', () => {
    const result = renderStatusLine([png(1024), png(1024)]);
    expect(result).toBe('[2 images attached · 2.0 KiB · PNG · Ctrl+X to discard]');
  });

  it('handles multiple different types without collapsing', () => {
    const result = renderStatusLine([png(1024), jpeg(1024), gif(1024)]);
    expect(result).toContain('3 images attached');
    expect(result).toContain('PNG, JPEG, GIF');
  });

  it('handles WEBP format', () => {
    const result = renderStatusLine([webp(1024)]);
    expect(result).toContain('WEBP');
  });

  it('appends Ctrl+X to discard hint when attachments present', () => {
    const result = renderStatusLine([png(1024)]);
    expect(result).toContain('· Ctrl+X to discard');
  });
});

describe('describeForHistory', () => {
  it('returns text as-is when no attachments', () => {
    expect(describeForHistory('hi', [])).toBe('hi');
  });

  it('returns empty string when both empty', () => {
    expect(describeForHistory('', [])).toBe('');
  });

  it('returns image label when no text', () => {
    expect(describeForHistory('', [png(1024)])).toBe('[image attached]');
  });

  it('appends image count to text', () => {
    expect(describeForHistory('hi', [png(1024)])).toBe('hi [+ 1 image]');
  });

  it('appends plural images count to text', () => {
    expect(describeForHistory('hi', [png(1024), jpeg(1024)])).toBe(
      'hi [+ 2 images]'
    );
  });

  it('uses images-attached form when no text but multiple images', () => {
    expect(describeForHistory('', [png(1024), jpeg(1024)])).toBe(
      '[2 images attached]'
    );
  });
});

describe('describeAttachmentSummary', () => {
  it('returns empty string when no attachments', () => {
    expect(describeAttachmentSummary([])).toBe('');
  });

  it('returns bare "[image attached]" for a single attachment', () => {
    expect(describeAttachmentSummary([png(1024)])).toBe('[image attached]');
  });

  it('returns count for multiple attachments', () => {
    expect(describeAttachmentSummary([png(1024), jpeg(1024)])).toBe(
      '[2 images attached]'
    );
  });

  it('omits size/type metadata and Ctrl+X hint', () => {
    // Distinct from renderStatusLine: post-submit summary drops the discard
    // affordance (attachments are already in flight) and the size/type chips.
    const result = describeAttachmentSummary([png(245_000)]);
    expect(result).not.toContain('KiB');
    expect(result).not.toContain('PNG');
    expect(result).not.toContain('Ctrl+X');
  });
});
