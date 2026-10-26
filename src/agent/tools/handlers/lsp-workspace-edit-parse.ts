/** Structural validation and UTF-16 range conversion (no filesystem access). */
interface Position { line: number; character: number }
interface TextEdit { range: { start: Position; end: Position }; newText: string }
export interface WorkspaceDocument { uri: string; version?: number | null; edits: TextEdit[] }

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function position(value: unknown): Position {
  const p = object(value, 'Position');
  if (!Number.isSafeInteger(p['line']) || (p['line'] as number) < 0 ||
      !Number.isSafeInteger(p['character']) || (p['character'] as number) < 0) {
    throw new Error('WorkspaceEdit position must have nonnegative integer line and character');
  }
  return { line: p['line'] as number, character: p['character'] as number };
}

function textEdits(value: unknown, annotations: Record<string, unknown>): TextEdit[] {
  if (!Array.isArray(value)) throw new Error('WorkspaceEdit edits must be an array');
  return value.map((item) => {
    const edit = object(item, 'TextEdit');
    if (typeof edit['newText'] !== 'string') throw new Error('TextEdit newText must be a string');
    if ('annotationId' in edit) {
      if (typeof edit['annotationId'] !== 'string' || !Object.hasOwn(annotations, edit['annotationId'])) {
        throw new Error('TextEdit has unknown annotationId');
      }
      const annotation = object(annotations[edit['annotationId']], 'ChangeAnnotation');
      if (annotation['needsConfirmation'] !== undefined && annotation['needsConfirmation'] !== false) {
        throw new Error('WorkspaceEdit change annotation requires confirmation');
      }
    }
    const range = object(edit['range'], 'TextEdit range');
    return { range: { start: position(range['start']), end: position(range['end']) }, newText: edit['newText'] };
  });
}

/** Reject resource operations and ambiguous mixed representations before I/O. */
export function workspaceDocuments(value: unknown): WorkspaceDocument[] {
  const edit = object(value, 'WorkspaceEdit');
  if (edit['changes'] !== undefined && edit['documentChanges'] !== undefined) {
    throw new Error('WorkspaceEdit cannot contain both changes and documentChanges');
  }
  const annotations = edit['changeAnnotations'] === undefined ? {} : object(edit['changeAnnotations'], 'changeAnnotations');
  if (edit['documentChanges'] !== undefined) {
    if (!Array.isArray(edit['documentChanges'])) throw new Error('documentChanges must be an array');
    return edit['documentChanges'].map((item) => {
      const change = object(item, 'TextDocumentEdit');
      if ('kind' in change) throw new Error('WorkspaceEdit resource operations are not supported');
      const doc = object(change['textDocument'], 'textDocument');
      if (typeof doc['uri'] !== 'string') throw new Error('textDocument.uri must be a string');
      if (doc['version'] !== undefined && doc['version'] !== null && !Number.isSafeInteger(doc['version'])) {
        throw new Error('textDocument.version must be an integer or null');
      }
      return { uri: doc['uri'], version: doc['version'] as number | null | undefined, edits: textEdits(change['edits'], annotations) };
    });
  }
  if (edit['changes'] === undefined) return [];
  return Object.entries(object(edit['changes'], 'changes')).map(([uri, edits]) => ({ uri, edits: textEdits(edits, annotations) }));
}

/** JS indices are UTF-16 code units, the LSP default position encoding. */
export function applyTextEdits(text: string, edits: readonly TextEdit[]): string {
  const starts = [0];
  const ends: number[] = [];
  const breaks = /\r\n|\r|\n/g;
  for (let match; (match = breaks.exec(text));) {
    ends.push(match.index);
    starts.push(match.index + match[0].length);
  }
  ends.push(text.length);
  const offset = (p: Position): number => {
    const start = starts[p.line];
    const end = ends[p.line];
    if (start === undefined || end === undefined || p.character > end - start) {
      throw new Error('WorkspaceEdit position is outside document bounds');
    }
    const at = start + p.character;
    // A coordinate in the middle of a surrogate pair would corrupt the text.
    const previous = text.charCodeAt(at - 1);
    const current = text.charCodeAt(at);
    if (previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff) {
      throw new Error('WorkspaceEdit position splits a UTF-16 surrogate pair');
    }
    return at;
  };
  const ranges = edits.map((edit, index) => {
    const start = offset(edit.range.start);
    const end = offset(edit.range.end);
    if (end < start) throw new Error('WorkspaceEdit range end precedes start');
    return { start, end, text: edit.newText, index };
  }).sort((a, b) => a.start - b.start || a.index - b.index);
  let previousEnd = -1;
  for (const range of ranges) {
    if (range.start < previousEnd) throw new Error('WorkspaceEdit contains overlapping ranges');
    previousEnd = range.end;
  }
  // Reverse offsets avoid shifts; reversing equal-position inserts preserves
  // their array order, as required by LSP (inserts may precede a replacement).
  let result = text;
  for (let i = ranges.length - 1; i >= 0; i--) {
    const range = ranges[i]!;
    result = result.slice(0, range.start) + range.text + result.slice(range.end);
  }
  return result;
}
