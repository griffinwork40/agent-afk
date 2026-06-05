/**
 * Pure module for attachment type and helper functions.
 * @module cli/input/attachments
 */

export interface ImageAttachment {
  readonly id: string;
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  readonly bytes: Buffer;
  readonly sizeBytes: number;
}

const MEDIA_TYPE_TO_LABEL: Record<ImageAttachment['mediaType'], string> = {
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
  'image/gif': 'GIF',
  'image/webp': 'WEBP',
};

export function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const kiB = bytes / 1024;
  if (kiB < 1024) {
    return `${kiB.toFixed(1)} KiB`;
  }

  const miB = kiB / 1024;
  return `${miB.toFixed(1)} MiB`;
}

export function renderStatusLine(attachments: ImageAttachment[]): string {
  if (attachments.length === 0) {
    return '';
  }

  const totalSize = attachments.reduce((sum, att) => sum + att.sizeBytes, 0);
  const sizeStr = formatSize(totalSize);
  const imagePlural = attachments.length === 1 ? 'image' : 'images';

  const typesSet = new Set<string>();
  const typeLabels: string[] = [];
  for (const att of attachments) {
    const label = MEDIA_TYPE_TO_LABEL[att.mediaType];
    if (!typesSet.has(label)) {
      typesSet.add(label);
      typeLabels.push(label);
    }
  }

  const typesStr = typeLabels.join(', ');
  return `[${attachments.length} ${imagePlural} attached · ${sizeStr} · ${typesStr} · Ctrl+X to discard]`;
}

export function describeForHistory(text: string, attachments: ImageAttachment[]): string {
  if (attachments.length === 0) {
    return text;
  }

  if (text) {
    const imagePlural = attachments.length === 1 ? 'image' : 'images';
    return `${text} [+ ${attachments.length} ${imagePlural}]`;
  }

  if (attachments.length === 1) {
    return '[image attached]';
  }

  return `[${attachments.length} images attached]`;
}

/**
 * Render the post-submit attachment summary shown beneath the echoed user
 * message in the REPL transcript.
 *
 * Distinct from {@link renderStatusLine} (the in-input "Ctrl+X to discard"
 * hint shown during composition): once submitted, the discard affordance is
 * meaningless — the attachments are already in flight. This helper drops the
 * size/type metadata and the Ctrl+X hint, leaving only "[image attached]" or
 * "[N images attached]" so the user has a durable acknowledgment that the
 * image went with the turn.
 *
 * Returns an empty string when there are no attachments so the caller can
 * pass it through unconditionally.
 */
export function describeAttachmentSummary(attachments: ImageAttachment[]): string {
  if (attachments.length === 0) {
    return '';
  }
  if (attachments.length === 1) {
    return '[image attached]';
  }
  return `[${attachments.length} images attached]`;
}
