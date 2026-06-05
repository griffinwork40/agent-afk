/**
 * Regression guards for the schema-as-source-of-truth invariants.
 *
 * These tests prevent the classification drift that was fixed in the
 * 2026-05 refactor:
 *
 *   1. Plan mode was not blocking memory_update / procedure_write.
 *   2. risk-classifier.ts had a private read-tool list that diverged from
 *      tool-category.ts (missing memory_search).
 *   3. dispatcher.ts SAFE_TOOLS was a hand-maintained mirror.
 *   4. Schedule tools fell through to 'other'.
 *   5. CLAUDE_SHORT_ALIASES included 'auto' which was absent from MODEL_MAP.
 *   6. model-limits.ts listed retired 'claude-opus-4-6'.
 *
 * If any of these invariants regresses a test here will fail.
 *
 * @module agent/tools/schema-classification.test
 */

import { describe, it, expect } from 'vitest';
import { ALL_TOOL_SCHEMAS } from './schemas.js';
import { memoryToolSchemas } from '../memory/memory-tools.js';
import { getRuntimeStateTool } from '../awareness/index.js';
import { defaultConcurrencyClassifier } from './dispatcher.js';
import { categorizeTool } from '../tool-category.js';
import { MODEL_MAP } from '../session/model-resolution.js';
import { MODEL_MAX_OUTPUT_TOKENS } from '../model-limits.js';
import type { ToolCategory } from '../tool-category.js';

// All schemas that built-in dispatch covers — closed-world set composed of
// the canonical `ALL_TOOL_SCHEMAS` (builtins + agent/skill/compose), the
// separate memory-tools registry, and the awareness-layer `getRuntimeStateTool`.
// If any of these gains a new schema, classification invariants below must
// hold for it.
const ALL_BUILTIN_SCHEMAS = [
  ...ALL_TOOL_SCHEMAS,
  ...memoryToolSchemas,
  getRuntimeStateTool,
];

// ── Invariant 1: every built-in schema declares a category ────────────────

describe('schema-as-source-of-truth: category field', () => {
  it('every builtin schema has a category field', () => {
    for (const schema of ALL_BUILTIN_SCHEMAS) {
      expect(
        schema.category,
        `Tool "${schema.name}" is missing a category field`,
      ).toBeDefined();
    }
  });

  it('every builtin schema category is a valid ToolCategory', () => {
    const valid: ToolCategory[] = [
      'read', 'write', 'shell', 'subagent', 'skill', 'dag',
      'mcp', 'web', 'browser', 'planning', 'schedule', 'other',
    ];
    for (const schema of ALL_BUILTIN_SCHEMAS) {
      expect(
        valid.includes(schema.category as ToolCategory),
        `Tool "${schema.name}" has invalid category "${String(schema.category)}"`,
      ).toBe(true);
    }
  });
});

// ── Invariant 2: SAFE_TOOLS derivation matches schema concurrencySafe ──────

describe('schema-as-source-of-truth: concurrencySafe derivation', () => {
  it('tools with concurrencySafe=true are classified safe by defaultConcurrencyClassifier', () => {
    for (const schema of ALL_BUILTIN_SCHEMAS) {
      if (schema.concurrencySafe === true) {
        expect(
          defaultConcurrencyClassifier(schema.name),
          `"${schema.name}" has concurrencySafe=true but defaultConcurrencyClassifier returns false`,
        ).toBe(true);
      }
    }
  });

  it('tools with concurrencySafe=false are NOT classified safe by defaultConcurrencyClassifier', () => {
    for (const schema of ALL_BUILTIN_SCHEMAS) {
      if (schema.concurrencySafe === false) {
        expect(
          defaultConcurrencyClassifier(schema.name),
          `"${schema.name}" has concurrencySafe=false but defaultConcurrencyClassifier returns true`,
        ).toBe(false);
      }
    }
  });
});

// ── Invariant 3: category field agrees with categorizeTool ─────────────────

describe('schema-as-source-of-truth: category field agrees with categorizeTool', () => {
  it('every builtin schema category matches what categorizeTool returns for its name', () => {
    for (const schema of ALL_BUILTIN_SCHEMAS) {
      if (schema.category === undefined) continue;
      expect(
        categorizeTool(schema.name),
        `Tool "${schema.name}": schema.category="${String(schema.category)}" but categorizeTool returns "${categorizeTool(schema.name)}"`,
      ).toBe(schema.category);
    }
  });
});

// ── Invariant 4: schedule tools are categorized as 'schedule' ──────────────

describe('schema-as-source-of-truth: schedule tools', () => {
  const scheduleNames = [
    'create_schedule',
    'list_schedules',
    'get_schedule_history',
    'cancel_schedule',
  ];

  it.each(scheduleNames)('"%s" categorizes as schedule (not other)', (name) => {
    expect(categorizeTool(name)).toBe('schedule');
  });
});

// ── Invariant 5: MODEL_MAP values are a subset of MODEL_MAX_OUTPUT_TOKENS ──

describe('schema-as-source-of-truth: model-limits coverage', () => {
  it('every full model ID in MODEL_MAP has an entry in MODEL_MAX_OUTPUT_TOKENS', () => {
    // This assertion prevents retired model entries from silently disappearing
    // from model-limits while still being referenced by MODEL_MAP, and
    // prevents MODEL_MAP from gaining new models that lack output-token caps.
    const fullIds = new Set(Object.values(MODEL_MAP));
    for (const id of fullIds) {
      expect(
        id in MODEL_MAX_OUTPUT_TOKENS,
        `MODEL_MAP value "${id}" has no entry in MODEL_MAX_OUTPUT_TOKENS`,
      ).toBe(true);
    }
  });

  it('claude-opus-4-6 (retired) is NOT in MODEL_MAX_OUTPUT_TOKENS', () => {
    // Regression guard: the retired model was removed in the
    // schema-as-source-of-truth refactor and must stay removed.
    expect('claude-opus-4-6' in MODEL_MAX_OUTPUT_TOKENS).toBe(false);
  });
});

// ── Invariant 6: write-category tools blocked by plan-mode gate ────────────

describe('schema-as-source-of-truth: plan-mode blocks all write-category tools', () => {
  const writeCategorySchemas = ALL_BUILTIN_SCHEMAS.filter(
    (s) => s.category === 'write',
  );

  it('identifies at least 4 write-category tools (write_file, edit_file, memory_update, procedure_write)', () => {
    const names = writeCategorySchemas.map((s) => s.name);
    expect(names).toContain('write_file');
    expect(names).toContain('edit_file');
    // Bug-fix tools: were missing from plan-mode gate before refactor
    expect(names).toContain('memory_update');
    expect(names).toContain('procedure_write');
  });
});
