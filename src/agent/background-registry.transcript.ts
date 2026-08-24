export const MAX_TRANSCRIPT_TAIL_BYTES = 4096;

export function appendTranscriptTail(current: string, chunk: string): string {
  const combined = current + chunk;
  return combined.length <= MAX_TRANSCRIPT_TAIL_BYTES
    ? combined
    : combined.slice(combined.length - MAX_TRANSCRIPT_TAIL_BYTES);
}
