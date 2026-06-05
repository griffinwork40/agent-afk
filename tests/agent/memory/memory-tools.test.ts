/**
 * Tests for memory tool schemas and handlers.
 *
 * @module tests/agent/memory/memory-tools
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { MemoryStore } from '../../../src/agent/memory/memory-store.js';
import {
  memorySearchTool,
  memoryUpdateTool,
  procedureWriteTool,
  memoryToolSchemas,
  createMemoryHandlers,
} from '../../../src/agent/memory/memory-tools.js';

describe('Memory Tool Schemas', () => {
  it('exports three tool schemas', () => {
    expect(memoryToolSchemas).toHaveLength(3);
    expect(memoryToolSchemas.map((t) => t.name)).toEqual([
      'memory_search',
      'memory_update',
      'procedure_write',
    ]);
  });

  it('memory_search schema has correct properties', () => {
    expect(memorySearchTool.name).toBe('memory_search');
    expect(memorySearchTool.description).toBeTruthy();
    expect(memorySearchTool.input_schema.properties).toHaveProperty('query');
    expect(memorySearchTool.input_schema.properties).toHaveProperty('category');
    expect(memorySearchTool.input_schema.properties).toHaveProperty('since');
    expect(memorySearchTool.input_schema.properties).toHaveProperty('limit');
    expect(memorySearchTool.input_schema.required).toContain('query');
  });

  it('memory_update schema has correct properties', () => {
    expect(memoryUpdateTool.name).toBe('memory_update');
    expect(memoryUpdateTool.description).toBeTruthy();
    expect(memoryUpdateTool.input_schema.properties).toHaveProperty('target');
    expect(memoryUpdateTool.input_schema.properties).toHaveProperty('action');
    expect(memoryUpdateTool.input_schema.properties).toHaveProperty('content');
    expect(memoryUpdateTool.input_schema.properties).toHaveProperty('category');
    expect(memoryUpdateTool.input_schema.properties).toHaveProperty('supersedes');
    expect(memoryUpdateTool.input_schema.required).toContain('target');
    expect(memoryUpdateTool.input_schema.required).toContain('action');
  });

  it('procedure_write schema has correct properties', () => {
    expect(procedureWriteTool.name).toBe('procedure_write');
    expect(procedureWriteTool.description).toBeTruthy();
    expect(procedureWriteTool.input_schema.properties).toHaveProperty('name');
    expect(procedureWriteTool.input_schema.properties).toHaveProperty('content');
    expect(procedureWriteTool.input_schema.required).toContain('name');
    expect(procedureWriteTool.input_schema.required).toContain('content');
  });
});

describe('Memory Tool Handlers', () => {
  let store: MemoryStore;
  let tempDir: string;
  const abortSignal = new AbortController().signal;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'memory-tools-test-'));
    store = new MemoryStore(tempDir);
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true });
  });

  describe('memory_search handler', () => {
    it('returns empty results for nonexistent query', async () => {
      const handlers = createMemoryHandlers(store, 'test-session', 'cli');
      const handler = handlers.get('memory_search')!;

      const result = await handler(
        { query: 'nonexistent-very-unique-search' },
        abortSignal,
      );

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content);
      expect(parsed).toEqual([]);
    });

    it('searches facts in memory', async () => {
      store.storeFact({
        session_id: 'test-session',
        category: 'preference',
        content: 'I prefer dark mode for all interfaces',
        source_surface: 'cli',
      });

      const handlers = createMemoryHandlers(store, 'test-session', 'cli');
      const handler = handlers.get('memory_search')!;

      const result = await handler(
        { query: 'dark mode' },
        abortSignal,
      );

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content);
      expect(parsed.length).toBeGreaterThan(0);
      expect(parsed[0]).toHaveProperty('content');
      expect(parsed[0]).toHaveProperty('type', 'fact');
    });

    it('filters by category', async () => {
      store.storeFact({
        session_id: 'test-session',
        category: 'preference',
        content: 'Prefer TypeScript',
        source_surface: 'cli',
      });
      store.storeFact({
        session_id: 'test-session',
        category: 'decision',
        content: 'Decided to use vitest',
        source_surface: 'cli',
      });

      const handlers = createMemoryHandlers(store, 'test-session', 'cli');
      const handler = handlers.get('memory_search')!;

      const result = await handler(
        { query: 'prefer', category: 'preference' },
        abortSignal,
      );

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content);
      expect(parsed.length).toBeGreaterThan(0);
      expect(parsed.every((r: unknown) => (r as Record<string, unknown>).category === 'preference')).toBe(
        true,
      );
    });

    it('respects limit parameter', async () => {
      for (let i = 0; i < 5; i++) {
        store.storeFact({
          session_id: 'test-session',
          category: 'learning',
          content: `Fact ${i}: test content`,
          source_surface: 'cli',
        });
      }

      const handlers = createMemoryHandlers(store, 'test-session', 'cli');
      const handler = handlers.get('memory_search')!;

      const result = await handler(
        { query: 'test', limit: 2 },
        abortSignal,
      );

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content);
      expect(parsed.length).toBeLessThanOrEqual(2);
    });

    it('handles malformed input gracefully', async () => {
      const handlers = createMemoryHandlers(store, 'test-session', 'cli');
      const handler = handlers.get('memory_search')!;

      const result = await handler(
        { query: null as unknown as string },
        abortSignal,
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain('error');
    });
  });

  describe('memory_update handler', () => {
    it('stores a fact', async () => {
      const handlers = createMemoryHandlers(store, 'test-session', 'cli');
      const handler = handlers.get('memory_update')!;

      const result = await handler(
        {
          target: 'fact',
          action: 'set',
          category: 'preference',
          content: 'Use vitest for testing',
        },
        abortSignal,
      );

      expect(result.isError).toBeFalsy();
      const output = JSON.parse(result.content);
      expect(output).toHaveProperty('id');
      expect(output.id).toBeGreaterThan(0);

      // Verify it was stored by searching
      const searchHandlers = createMemoryHandlers(store, 'test-session', 'cli');
      const searchHandler = searchHandlers.get('memory_search')!;
      const searchResult = await searchHandler({ query: 'vitest' }, abortSignal);
      const parsed = JSON.parse(searchResult.content);
      expect(parsed.length).toBeGreaterThan(0);
    });

    it('saves to hot memory', async () => {
      const handlers = createMemoryHandlers(store, 'test-session', 'cli');
      const handler = handlers.get('memory_update')!;

      const result = await handler(
        {
          target: 'hot',
          action: 'set',
          content: 'This is hot memory content',
        },
        abortSignal,
      );

      expect(result.isError).toBeFalsy();

      // Verify it was saved
      const loaded = store.loadHot();
      expect(loaded).toBe('This is hot memory content');
    });

    it('supersedes a fact', async () => {
      const id = store.storeFact({
        session_id: 'test-session',
        category: 'learning',
        content: 'Old fact',
        source_surface: 'cli',
      });

      const handlers = createMemoryHandlers(store, 'test-session', 'cli');
      const handler = handlers.get('memory_update')!;

      const result = await handler(
        {
          target: 'fact',
          action: 'supersede',
          supersedes: id,
          content: 'Updated fact',
        },
        abortSignal,
      );

      expect(result.isError).toBeFalsy();
      const output = JSON.parse(result.content);
      expect(output).toHaveProperty('id');
      expect(output.id).not.toBe(id);
    });

    it('removes a fact', async () => {
      const id = store.storeFact({
        session_id: 'test-session',
        category: 'decision',
        content: 'To be removed',
        source_surface: 'cli',
      });

      const handlers = createMemoryHandlers(store, 'test-session', 'cli');
      const handler = handlers.get('memory_update')!;

      const result = await handler(
        {
          target: 'fact',
          action: 'remove',
          id,
        },
        abortSignal,
      );

      expect(result.isError).toBeFalsy();
      const output = JSON.parse(result.content);
      expect(output).toHaveProperty('removed', true);

      // Verify it's gone
      const fact = store.getFact(id);
      expect(fact).toBeNull();
    });

    it('rejects remove action without id', async () => {
      const handlers = createMemoryHandlers(store, 'test-session', 'cli');
      const handler = handlers.get('memory_update')!;

      const result = await handler(
        {
          target: 'fact',
          action: 'remove',
        },
        abortSignal,
      );

      expect(result.isError).toBe(true);
    });

    it('rejects hot memory supersede', async () => {
      const handlers = createMemoryHandlers(store, 'test-session', 'cli');
      const handler = handlers.get('memory_update')!;

      const result = await handler(
        {
          target: 'hot',
          action: 'supersede',
          content: 'Cannot supersede hot',
        },
        abortSignal,
      );

      expect(result.isError).toBe(true);
    });

    it('handles invalid input gracefully', async () => {
      const handlers = createMemoryHandlers(store, 'test-session', 'cli');
      const handler = handlers.get('memory_update')!;

      const result = await handler(
        { target: 'invalid-target', action: 'set' },
        abortSignal,
      );

      expect(result.isError).toBe(true);
    });
  });

  describe('procedure_write handler', () => {
    it('writes a procedure', async () => {
      const handlers = createMemoryHandlers(store, 'test-session', 'cli');
      const handler = handlers.get('procedure_write')!;

      const result = await handler(
        {
          name: 'rebuild-project',
          content: '1. Run `pnpm clean`\n2. Run `pnpm build`\n3. Verify output',
        },
        abortSignal,
      );

      expect(result.isError).toBeFalsy();

      // Verify it was written
      const proc = store.loadProcedure('rebuild-project');
      expect(proc).not.toBeNull();
      expect(proc?.content).toContain('pnpm clean');
    });

    it('procedure is searchable', async () => {
      const handlers = createMemoryHandlers(store, 'test-session', 'cli');
      const writeHandler = handlers.get('procedure_write')!;

      await writeHandler(
        {
          name: 'debug-typescript',
          content: 'Tips for debugging TypeScript compilation errors',
        },
        abortSignal,
      );

      const searchHandler = handlers.get('memory_search')!;
      const searchResult = await searchHandler(
        { query: 'typescript compilation' },
        abortSignal,
      );

      expect(searchResult.isError).toBeFalsy();
      const parsed = JSON.parse(searchResult.content);
      expect(parsed.some((r: unknown) => (r as Record<string, unknown>).type === 'procedure')).toBe(true);
    });

    it('handles invalid input gracefully', async () => {
      const handlers = createMemoryHandlers(store, 'test-session', 'cli');
      const handler = handlers.get('procedure_write')!;

      const result = await handler(
        { name: null as unknown as string, content: 'test' },
        abortSignal,
      );

      expect(result.isError).toBe(true);
    });
  });

  describe('handler factory', () => {
    it('returns handlers map with correct size', () => {
      const handlers = createMemoryHandlers(store, 'test-session', 'cli');
      expect(handlers.size).toBe(3);
      expect(handlers.has('memory_search')).toBe(true);
      expect(handlers.has('memory_update')).toBe(true);
      expect(handlers.has('procedure_write')).toBe(true);
    });

    it('handlers are callable', () => {
      const handlers = createMemoryHandlers(store, 'test-session', 'cli');
      for (const handler of handlers.values()) {
        expect(typeof handler).toBe('function');
      }
    });
  });
});
