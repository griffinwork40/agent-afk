/**
 * Display formatters for memory-tool handler results.
 *
 * Each formatter parses the raw JSON `content` string produced by a
 * memory tool handler (in `./memory-tools.ts`) and returns a short,
 * human-readable one-liner for the interactive tool-lane renderer.
 * Registered in `src/agent/tools/render-registry.ts` and consulted from
 * `src/agent/session/stream-consumer.ts:buildToolOutputEvent` UPSTREAM
 * of `truncateContent`, so formatters receive un-truncated content and
 * their output bypasses the 80-char truncation cap.
 *
 * Pure, deterministic. Fail open on parse error or shape mismatch
 * (return `null`) so the caller falls back to the existing preview path.
 *
 * Drift guard: the shapes parsed here mirror the happy-path returns of
 * `createMemoryHandlers` in `./memory-tools.ts`. A future handler-shape
 * change that this file doesn't track silently yields `null` and the
 * raw-preview fallback re-emerges. Tests in `memory-tool-renderers.test.ts`
 * pin the fixtures against the handler outputs.
 *
 * @module agent/memory/memory-tool-renderers
 */

/**
 * memory_search returns `JSON.stringify(MemorySearchResult[])`.
 * Rendered as `"3 results (2 facts, 1 procedure)"` / `"no results"`.
 */
export function formatMemorySearchDisplay(rawContent: string): string | null {
  try {
    const arr: unknown = JSON.parse(rawContent);
    if (!Array.isArray(arr)) return null;
    const total = arr.length;
    if (total === 0) return 'no results';
    let facts = 0;
    let procs = 0;
    for (const r of arr) {
      if (r && typeof r === 'object') {
        const t = (r as { type?: unknown }).type;
        if (t === 'fact') facts++;
        else if (t === 'procedure') procs++;
      }
    }
    const totalStr = `${total} result${total === 1 ? '' : 's'}`;
    // Forward-compat: if a future result type appears, don't mislabel —
    // fall back to total-only.
    if (facts + procs !== total) return totalStr;
    const parts: string[] = [];
    if (facts > 0) parts.push(`${facts} fact${facts === 1 ? '' : 's'}`);
    if (procs > 0) parts.push(`${procs} procedure${procs === 1 ? '' : 's'}`);
    if (parts.length === 0) return totalStr;
    return `${totalStr} (${parts.join(', ')})`;
  } catch {
    return null;
  }
}

/**
 * memory_update returns one of:
 * - `{saved, target:'hot'}`                                  → "hot memory saved"
 * - `{id, action:'set', target:'fact'}`                      → "fact #N set"
 * - `{id, action:'supersede', target:'fact', supersedes}`    → "fact #N supersedes #M"
 * - `{removed, action:'remove', target:'fact'}`              → "fact removed" / "fact not found"
 *
 * Every branch gates on `target === 'fact'` so a future hot-target remove
 * or supersede (if added) is not mislabeled.
 */
export function formatMemoryUpdateDisplay(rawContent: string): string | null {
  try {
    const parsed: unknown = JSON.parse(rawContent);
    if (!parsed || typeof parsed !== 'object') return null;
    const o = parsed as Record<string, unknown>;
    if (o['target'] === 'hot' && o['saved'] === true) return 'hot memory saved';
    if (o['target'] === 'fact') {
      if (o['action'] === 'remove') {
        return o['removed'] === true ? 'fact removed' : 'fact not found';
      }
      if (o['action'] === 'set' && typeof o['id'] === 'number') {
        return `fact #${o['id']} set`;
      }
      if (
        o['action'] === 'supersede' &&
        typeof o['id'] === 'number' &&
        typeof o['supersedes'] === 'number'
      ) {
        return `fact #${o['id']} supersedes #${o['supersedes']}`;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * procedure_write returns `{name, written:true}`. Rendered as
 * `"wrote procedure '<name>'"`. The `name` is model-controlled (it
 * originates from the tool input parser, then echoes back through the
 * handler return), so the value is bounded but not trusted — the
 * shared `sanitizeForDisplay` (src/utils/terminal-sanitize.ts) strips control chars at the
 * boundary, so this formatter does not need its own sanitization.
 */
export function formatProcedureWriteDisplay(rawContent: string): string | null {
  try {
    const parsed: unknown = JSON.parse(rawContent);
    if (!parsed || typeof parsed !== 'object') return null;
    const o = parsed as Record<string, unknown>;
    if (typeof o['name'] === 'string' && o['written'] === true) {
      return `wrote procedure '${o['name']}'`;
    }
    return null;
  } catch {
    return null;
  }
}
