#!/bin/sh
set -e
REPO=/Users/griffinlong/Projects/open_source/agent-afk

# ── P1-1: Update schemas.test.ts tool count and name list ────────────────────
sed -i '' 's/contains exactly 32 tools/contains exactly 33 tools/' "$REPO/src/agent/tools/schemas.test.ts"
sed -i '' "s/expect(builtinToolSchemas).toHaveLength(32)/expect(builtinToolSchemas).toHaveLength(33)/" "$REPO/src/agent/tools/schemas.test.ts"
# Insert json_query after list_directory in the name list
python3 - <<'PY'
import re, pathlib
p = pathlib.Path("/Users/griffinlong/Projects/open_source/agent-afk/src/agent/tools/schemas.test.ts")
src = p.read_text()
src = src.replace("      'list_directory',\n      'send_telegram',", "      'list_directory',\n      'json_query',\n      'send_telegram',")
p.write_text(src)
PY

echo "P1-1 done"

# ── P1-2: Add json_query to READ_TOOLS and READ_ONLY_PHASE_TOOLS ─────────────
python3 - <<'PY'
import pathlib
p = pathlib.Path("/Users/griffinlong/Projects/open_source/agent-afk/src/agent/tool-category.ts")
src = p.read_text()

# Add json_query to READ_TOOLS (after get_facet line)
src = src.replace(
    "  // get_facet — read-only: derives or loads the session facet sidecar; no\n  // mutation surface. Schema declares category='read'; this entry makes\n  // categorizeTool() agree so the schema-as-source-of-truth test passes.\n  'get_facet',\n]);",
    "  // get_facet — read-only: derives or loads the session facet sidecar; no\n  // mutation surface. Schema declares category='read'; this entry makes\n  // categorizeTool() agree so the schema-as-source-of-truth test passes.\n  'get_facet',\n  // json_query — read-only: reads a JSON file and evaluates a bounded query.\n  'json_query',\n]);"
)

# Add json_query to READ_ONLY_PHASE_TOOLS (after get_facet / before AWARENESS_TOOL_NAMES)
src = src.replace(
    "  // Shared workspace query — read-only poll of the ephemeral workspace.\n  // Trivially qualifies: pure read, no mutation, no side-effects.\n  'workspace_query',",
    "  // Shared workspace query — read-only poll of the ephemeral workspace.\n  // Trivially qualifies: pure read, no mutation, no side-effects.\n  'workspace_query',\n  // json_query — read-only: reads a JSON file and evaluates a bounded query.\n  'json_query',"
)
p.write_text(src)
PY

echo "P1-2 done"

# ── P1-3: Preserve array shape for singleton iteration results ────────────────
python3 - <<'PY'
import pathlib
p = pathlib.Path("/Users/griffinlong/Projects/open_source/agent-afk/src/agent/tools/handlers/json-query.ts")
src = p.read_text()

# Add helper to detect iteration queries
old_shaping_comment = "  // ---- Result shaping & caps -----------------------------------------------\n\n  let truncated = false;\n  let finalResult: unknown;\n\n  if (results.length === 1) {\n    // Single-value result: apply array-element cap if needed.\n    const val = results[0];\n    if (Array.isArray(val) && val.length > maxResults) {\n      finalResult = val.slice(0, maxResults);\n      truncated = true;\n    } else {\n      finalResult = val;\n    }\n  } else {"

new_shaping_comment = "  // ---- Result shaping & caps -----------------------------------------------\n\n  // Iteration queries (.[] or .[] | .field) always return an array, even for\n  // a single-element input, so the response shape is cardinality-independent.\n  const isIterQuery = isIterationQuery(queryToken);\n\n  let truncated = false;\n  let finalResult: unknown;\n\n  if (results.length === 1 && !isIterQuery) {\n    // Single-value result: apply array-element cap if needed.\n    const val = results[0];\n    if (Array.isArray(val) && val.length > maxResults) {\n      finalResult = val.slice(0, maxResults);\n      truncated = true;\n    } else {\n      finalResult = val;\n    }\n  } else {"

src = src.replace(old_shaping_comment, new_shaping_comment)

# Insert isIterationQuery helper before evalQuery
helper = '''/**
 * Return true when the query token represents an iteration or map-extract
 * query (.[] or .[] | .field). These queries ALWAYS return an array so the
 * response shape is independent of input cardinality.
 */
function isIterationQuery(token: QueryToken): boolean {
  if (token.kind === 'iter') return true;
  if (token.kind === 'pipe' && token.left.kind === 'iter') return true;
  return false;
}

'''
src = src.replace("/**\n * Evaluate a parsed query token against a JSON value.", helper + "/**\n * Evaluate a parsed query token against a JSON value.")

p.write_text(src)
PY

echo "P1-3 done"

# ── P2-1: Add json_query to path-approval-hook TYPED_FILE_TOOLS + extractCandidatePath ──
python3 - <<'PY'
import pathlib
p = pathlib.Path("/Users/griffinlong/Projects/open_source/agent-afk/src/agent/tools/hooks/path-approval-hook.ts")
src = p.read_text()

# Add json_query to TYPED_FILE_TOOLS
src = src.replace(
    "/** Tools subject to per-call path approval. Bash is gated separately. */\nconst TYPED_FILE_TOOLS = new Set([\n  'read_file',\n  'write_file',\n  'edit_file',\n  'list_directory',\n  'glob',\n  'grep',\n  'patch_apply',\n]);",
    "/** Tools subject to per-call path approval. Bash is gated separately. */\nconst TYPED_FILE_TOOLS = new Set([\n  'read_file',\n  'write_file',\n  'edit_file',\n  'list_directory',\n  'glob',\n  'grep',\n  'patch_apply',\n  'json_query',\n]);"
)

# Add json_query case in extractCandidatePath (after patch_apply block)
old_patch_block = "  if (toolName === 'patch_apply') {\n    const changes = input['changes'];\n    if (Array.isArray(changes) && changes.length > 0) {\n      const first = changes[0] as Record<string, unknown>;\n      const p = first['path'];\n      return typeof p === 'string' ? p : undefined;\n    }\n    return undefined;\n  }\n  return undefined;\n}"

new_patch_block = "  if (toolName === 'patch_apply') {\n    const changes = input['changes'];\n    if (Array.isArray(changes) && changes.length > 0) {\n      const first = changes[0] as Record<string, unknown>;\n      const p = first['path'];\n      return typeof p === 'string' ? p : undefined;\n    }\n    return undefined;\n  }\n  // json_query uses `file_path`.\n  if (toolName === 'json_query') {\n    const p = input['file_path'];\n    return typeof p === 'string' ? p : undefined;\n  }\n  return undefined;\n}"

src = src.replace(old_patch_block, new_patch_block)

p.write_text(src)
PY

echo "P2-1 done"

# ── P2-2: Enforce max_bytes correctly using Buffer boundaries ─────────────────
python3 - <<'PY'
import pathlib
p = pathlib.Path("/Users/griffinlong/Projects/open_source/agent-afk/src/agent/tools/handlers/json-query.ts")
src = p.read_text()

old_byte_cap = "  if (Buffer.byteLength(serialized, 'utf-8') > maxBytes) {\n    truncated = true;\n    // Surface a truncated string rather than a half-formed JSON structure.\n    resultPayload = serialized.slice(0, maxBytes) + '\\n… [truncated]';"

new_byte_cap = "  if (Buffer.byteLength(serialized, 'utf-8') > maxBytes) {\n    truncated = true;\n    // Surface a truncated string rather than a half-formed JSON structure.\n    // Truncate by UTF-8 byte count, not UTF-16 character count, so the\n    // advertised byte bound is respected even for multi-byte characters.\n    const buf = Buffer.from(serialized, 'utf-8');\n    resultPayload = buf.slice(0, maxBytes).toString('utf-8') + '\\n… [truncated]';"

src = src.replace(old_byte_cap, new_byte_cap)

p.write_text(src)
PY

echo "P2-2 done"
echo "All fixes applied."
