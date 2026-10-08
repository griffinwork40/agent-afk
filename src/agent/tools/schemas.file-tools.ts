/**
 * Tool schemas for file-system read/write/search built-ins:
 * read_file, view_image, extract_document, write_file, edit_file,
 * glob, grep, list_directory.
 *
 * Extracted into its own file to satisfy the 350-code-line ratchet on
 * `schemas.ts` (baselined files may shrink, never grow). Imported and
 * re-exported from `schemas.ts` so callers import from the primary module.
 *
 * @module agent/tools/schemas.file-tools
 */

import type { AnthropicToolDef } from './types.js';

export const readFileTool: AnthropicToolDef = {
  name: 'read_file',
  category: 'read',
  concurrencySafe: true,
  description:
    'Read a file from the filesystem. Returns the file content with line numbers. ' +
    'Use offset and limit to read specific sections of large files. ' +
    'When the read returns a partial view, the response ends with a `... (showing lines X-Y of Z [— pass offset=N to continue])` annotation indicating the full file size and how to continue. ' +
    'Binary files are detected and rejected — use extract_document for .docx, .pdf, .xlsx, .pptx, and .zip files. Missing files return an error.',
  input_schema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute path to the file to read.',
      },
      offset: {
        type: 'number',
        description: 'Line number to start reading from (1-based). Defaults to 1.',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of lines to read. Defaults to 2000.',
      },
    },
    required: ['file_path'],
  },
};

export const viewImageTool: AnthropicToolDef = {
  name: 'view_image',
  category: 'read',
  concurrencySafe: true,
  description:
    'Read an image file from the filesystem and return it as a viewable image attached ' +
    'to the tool result — you can see it directly. Supports .png, .jpg/.jpeg, .gif, .webp. ' +
    'Use when you need to inspect a local image: design diagrams, saved screenshots, charts, photos.\n\n' +
    'WARNING: each inline image consumes ~333K–484K context tokens (≈$1–3 at current rates ' +
    'for Anthropic models). Use for genuine visual inspection only; do not call in a loop. ' +
    'Images exceeding 8000px in either dimension or 2 MiB base64 are returned as text-only ' +
    '(imageOmitted key in the JSON result explains why). On OpenAI-compatible providers the ' +
    'image pixel data is silently dropped but text metadata is still returned.\n\n' +
    'Security: subject to the same read-root policy as read_file — paths outside the session\'s ' +
    'allowed read roots are rejected. Protected credential paths (SSH keys, etc.) are always denied.',
  input_schema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute path to the image file to view. Must be .png, .jpg, .jpeg, .gif, or .webp.',
      },
    },
    required: ['file_path'],
  },
};

export const extractDocumentTool: AnthropicToolDef = {
  name: 'extract_document',
  category: 'read',
  concurrencySafe: true,
  description:
    'Extract text from binary document formats that read_file rejects. ' +
    'Supports .docx, .xlsx, .pptx (Office/OOXML — zero external dependencies), ' +
    '.pdf (requires pdftotext from poppler-utils; emits install instructions if missing), ' +
    'and .zip (lists members and extracts text-file contents). ' +
    'Use this when read_file reports "File appears to be binary" on a document you need to read. ' +
    'Returns plain text extracted from the document. ' +
    'Security: 4 MB decompression cap, zip-slip path containment, no shell execution. ' +
    'Output is capped at 512 KB of text; larger documents are truncated with a marker.',
  input_schema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute path to the document file to extract text from.',
      },
    },
    required: ['file_path'],
  },
};

export const writeFileTool: AnthropicToolDef = {
  name: 'write_file',
  category: 'write',
  concurrencySafe: false,
  description:
    'Write content to a file, creating it if it does not exist or overwriting if it does. ' +
    'Parent directories are created automatically. ' +
    'Prefer edit_file for modifying existing files — use write_file only for new files or complete rewrites.',
  input_schema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute path to the file to write.',
      },
      content: {
        type: 'string',
        description: 'The full content to write to the file.',
      },
    },
    required: ['file_path', 'content'],
  },
};

export const editFileTool: AnthropicToolDef = {
  name: 'edit_file',
  category: 'write',
  concurrencySafe: false,
  description:
    'Perform an exact string replacement in a file. Finds old_string and replaces it with new_string. ' +
    'The edit fails if old_string is not found or matches multiple locations (unless replace_all is true). ' +
    'Always use read_file first to verify the exact content before editing.',
  input_schema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute path to the file to edit.',
      },
      old_string: {
        type: 'string',
        description: 'The exact string to find and replace. Must match file content exactly.',
      },
      new_string: {
        type: 'string',
        description: 'The replacement string.',
      },
      replace_all: {
        type: 'boolean',
        description:
          'If true, replace all occurrences. If false (default), fail when multiple matches exist.',
      },
      expected_hash: {
        type: 'string',
        description:
          'SHA-256 hash to verify the file has not changed (format: "sha256:<hex>"). ' +
          "If the file's current hash does not match, the edit is rejected before any write occurs. " +
          'Use to guard against stale-context overwrites after a prior patch_apply modified the file. ' +
          'Only set this to a hash copied verbatim from a prior tool result ' +
          '(e.g. patch_apply `after_hash`); never compute or guess one. ' +
          'Otherwise omit it or pass an empty string (treated as no hash check).',
      },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },
};

export const globTool: AnthropicToolDef = {
  name: 'glob',
  category: 'read',
  concurrencySafe: true,
  description:
    'Find files matching a glob pattern. Returns matching file paths, capped at 500 results. ' +
    'Use for discovering files before reading them. Patterns follow standard glob syntax ' +
    '(e.g., "src/**/*.ts", "*.json"). Skips node_modules/.git/.hg/.svn by default; ' +
    'name such a directory literally in the pattern (e.g. "node_modules/**/*.js") to search it.',
  input_schema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Glob pattern to match (e.g., "src/**/*.ts").',
      },
      path: {
        type: 'string',
        description: 'Base directory to search from. Defaults to the current working directory.',
      },
    },
    required: ['pattern'],
  },
};

export const grepTool: AnthropicToolDef = {
  name: 'grep',
  category: 'read',
  concurrencySafe: true,
  description:
    'Search file contents for lines matching a pattern. Returns matches in file:line:content format. ' +
    'Runs on ripgrep: `|` `+` `?` `(` `)` `{` `}` are regex metacharacters by default (e.g. `foo|bar` ' +
    'alternates, matching either branch) — escape with a backslash for the literal character. Honors ' +
    '.gitignore (so build/dependency dirs like node_modules are skipped) but DOES search hidden ' +
    'files/dirs like .github and .env; the .git directory and binary files are skipped. ' +
    'Output is capped to a ~100KB head+tail view; if a search is truncated, narrow it (a more specific ' +
    'pattern, an `include` glob, or a subdirectory `path`) rather than re-running the same broad query. ' +
    'Use for finding symbols, strings, or patterns across the codebase.',
  input_schema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description:
          'Search pattern (ripgrep regex syntax). `|` `+` `?` `(` `)` `{` `}` are metacharacters — ' +
          'e.g. `foo|bar` matches either "foo" or "bar". Escape with a backslash (e.g. `\\|`) to match ' +
          'the literal character.',
      },
      path: {
        type: 'string',
        description: 'Directory or file to search. Defaults to current working directory.',
      },
      include: {
        type: 'string',
        description: 'File glob to restrict search (e.g., "*.ts"). Passed as -g to ripgrep.',
      },
    },
    required: ['pattern'],
  },
};

export const listDirectoryTool: AnthropicToolDef = {
  name: 'list_directory',
  category: 'read',
  concurrencySafe: true,
  description:
    'List the contents of a directory. Returns file and subdirectory names with type annotations ' +
    '(directories end with /). Use for exploring project structure.',
  input_schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute path to the directory to list.',
      },
    },
    required: ['path'],
  },
};
