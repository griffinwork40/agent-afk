/**
 * Unit tests for `normalizeCallToolResult` — the MCP image-block forwarding
 * logic added in issue #1421.
 *
 * Tests are scoped to the pure normalizer function (exported `@internal` for
 * this purpose). They verify:
 *
 *   1. Happy path: image block forwarded as `ToolResult.image` (multimodal).
 *   2. Text-only result: `image` field absent.
 *   3. Mixed text + image: both text and image forwarded correctly.
 *   4. Unsupported mime type: falls back to text placeholder, no `image` field.
 *   5. Malformed image block (missing data): falls back to text placeholder.
 *   6. Multiple image blocks: first forwarded, rest become text placeholders.
 *   7. isError propagation is unaffected by image presence.
 *   8. Empty content array produces the '(empty tool result)' sentinel.
 *
 * @module agent/mcp/client.normalize.test
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// @internal — exported for tests only
import { normalizeCallToolResult } from './client.js';

// Capture console.warn calls without polluting test output.
const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

afterEach(() => {
  warnSpy.mockClear();
});

// Minimal 1×1 PNG in base64 (valid PNG header + IDAT, widely used in tests).
const PNG_1x1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// Minimal 1×1 JPEG in base64.
const JPEG_1x1 = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AJQAB/9k=';

describe('normalizeCallToolResult — image block forwarding (#1421)', () => {
  it('forwards a valid PNG image block as ToolResult.image', () => {
    const result = normalizeCallToolResult({
      content: [{ type: 'image', mimeType: 'image/png', data: PNG_1x1 }],
    } as unknown as CallToolResult);

    expect(result.image).toBeDefined();
    expect(result.image?.mediaType).toBe('image/png');
    expect(result.image?.data).toBe(PNG_1x1);
    // Content string carries metadata for text-only providers.
    expect(result.content).toContain('[image: image/png]');
    expect(result.isError).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('forwards a valid JPEG image block as ToolResult.image', () => {
    const result = normalizeCallToolResult({
      content: [{ type: 'image', mimeType: 'image/jpeg', data: JPEG_1x1 }],
    } as unknown as CallToolResult);

    expect(result.image?.mediaType).toBe('image/jpeg');
    expect(result.image?.data).toBe(JPEG_1x1);
  });

  it('returns no image field for text-only results', () => {
    const result = normalizeCallToolResult({
      content: [{ type: 'text', text: 'hello world' }],
    } as unknown as CallToolResult);

    expect(result.image).toBeUndefined();
    expect(result.content).toBe('hello world');
  });

  it('forwards text and image together (mixed content)', () => {
    const result = normalizeCallToolResult({
      content: [
        { type: 'text', text: 'screenshot taken' },
        { type: 'image', mimeType: 'image/png', data: PNG_1x1 },
      ],
    } as unknown as CallToolResult);

    expect(result.image).toBeDefined();
    expect(result.image?.mediaType).toBe('image/png');
    // Text rides content; image metadata tag appended after.
    expect(result.content).toContain('screenshot taken');
    expect(result.content).toContain('[image: image/png]');
  });

  it('falls back to text placeholder for unsupported mime types (e.g. image/svg+xml)', () => {
    const result = normalizeCallToolResult({
      content: [{ type: 'image', mimeType: 'image/svg+xml', data: PNG_1x1 }],
    } as unknown as CallToolResult);

    expect(result.image).toBeUndefined();
    expect(result.content).toContain('image/svg+xml');
    expect(result.content).toContain('unsupported format');
    // A warning is logged.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('unsupported mimeType'),
    );
  });

  it('falls back to text placeholder for unsupported mime type "image/tiff"', () => {
    const result = normalizeCallToolResult({
      content: [{ type: 'image', mimeType: 'image/tiff', data: PNG_1x1 }],
    } as unknown as CallToolResult);

    expect(result.image).toBeUndefined();
    expect(result.content).toContain('unsupported format');
  });

  it('falls back to text placeholder when data is missing', () => {
    const result = normalizeCallToolResult({
      content: [{ type: 'image', mimeType: 'image/png', data: '' }],
    } as unknown as CallToolResult);

    expect(result.image).toBeUndefined();
    expect(result.content).toContain('malformed');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('missing mimeType or data'),
    );
  });

  it('falls back to text placeholder when mimeType is missing', () => {
    const result = normalizeCallToolResult({
      content: [{ type: 'image', mimeType: '', data: PNG_1x1 }],
    } as unknown as CallToolResult);

    expect(result.image).toBeUndefined();
    expect(result.content).toContain('malformed');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('missing mimeType or data'),
    );
  });

  it('forwards only the first image; additional images become text placeholders', () => {
    const result = normalizeCallToolResult({
      content: [
        { type: 'image', mimeType: 'image/png', data: PNG_1x1 },
        { type: 'image', mimeType: 'image/jpeg', data: JPEG_1x1 },
      ],
    } as unknown as CallToolResult);

    // Only the first image is forwarded multimodally.
    expect(result.image?.mediaType).toBe('image/png');
    // The second image appears as a text placeholder.
    expect(result.content).toContain('additional image not forwarded');
    expect(result.content).toContain('image/jpeg');
    // No warnings for the valid images.
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('propagates isError regardless of image presence', () => {
    const result = normalizeCallToolResult({
      content: [
        { type: 'text', text: 'tool failed' },
        { type: 'image', mimeType: 'image/png', data: PNG_1x1 },
      ],
      isError: true,
    } as unknown as CallToolResult);

    expect(result.isError).toBe(true);
    // Image is still forwarded even on error results.
    expect(result.image).toBeDefined();
  });

  it('returns the empty-result sentinel for an empty content array', () => {
    const result = normalizeCallToolResult({
      content: [],
    } as unknown as CallToolResult);

    expect(result.content).toBe('(empty tool result)');
    expect(result.image).toBeUndefined();
  });

  it('returns the empty-result sentinel when content is undefined', () => {
    const result = normalizeCallToolResult({} as unknown as CallToolResult);

    expect(result.content).toBe('(empty tool result)');
    expect(result.image).toBeUndefined();
  });

  it('handles resource blocks alongside images without affecting image forwarding', () => {
    const result = normalizeCallToolResult({
      content: [
        { type: 'resource', resource: { uri: 'file:///some/path' } },
        { type: 'image', mimeType: 'image/png', data: PNG_1x1 },
      ],
    } as unknown as CallToolResult);

    expect(result.image?.mediaType).toBe('image/png');
    expect(result.content).toContain('[resource block: file:///some/path]');
  });

  it('handles supported mime types: image/gif and image/webp', () => {
    for (const mediaType of ['image/gif', 'image/webp'] as const) {
      const r = normalizeCallToolResult({
        content: [{ type: 'image', mimeType: mediaType, data: PNG_1x1 }],
      } as unknown as CallToolResult);

      expect(r.image?.mediaType).toBe(mediaType);
      expect(r.image?.data).toBe(PNG_1x1);
    }
  });

  it('falls back to text placeholder when the image exceeds the 5 MiB byte cap', () => {
    // Construct a base64 string whose estimated decoded size > 5 MiB.
    // 5 MiB = 5 * 1024 * 1024 = 5_242_880 bytes.
    // base64 length needed: ceil(5_242_880 * 4 / 3) = 6_990_507 chars.
    // Use 7_000_000 chars of valid base64 alphabet to be safely over the cap.
    const oversizedData = 'A'.repeat(7_000_000);

    const result = normalizeCallToolResult({
      content: [{ type: 'image', mimeType: 'image/png', data: oversizedData }],
    } as unknown as CallToolResult);

    expect(result.image).toBeUndefined();
    expect(result.content).toContain('too large for model context');
    expect(result.content).toContain('image/png');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('using text placeholder to avoid poisoning conversation history'),
    );
  });

  it('forwards an image just at the byte cap without falling back', () => {
    // 5 MiB = 5_242_880 decoded bytes → base64 length = ceil(5_242_880 * 4 / 3) = 6_990_507
    // Use exactly 6_990_507 'A' chars → estimatedBytes = ceil(6_990_507 * 3 / 4) = 5_242_881 > limit
    // So use 6_990_504 chars → estimatedBytes = ceil(6_990_504 * 3 / 4) = 5_242_878 < limit ✓
    const atCapData = 'A'.repeat(6_990_504);

    const result = normalizeCallToolResult({
      content: [{ type: 'image', mimeType: 'image/png', data: atCapData }],
    } as unknown as CallToolResult);

    expect(result.image).toBeDefined();
    expect(result.image?.mediaType).toBe('image/png');
    expect(result.image?.data).toBe(atCapData);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
