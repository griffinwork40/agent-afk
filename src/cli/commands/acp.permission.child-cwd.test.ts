/**
 * Red team 3b, item 2: child cwd gaps.
 *
 * Checks that every child-cwd path the brief names correctly threads the
 * working directory into the gate origin, so the gate resolves relative/
 * no-path calls against the right directory.
 *
 * These tests assert SAFE properties and pass on the current code (held).
 * A regression in any path would cause one of these to fail.
 */
import { describe, it, expect } from 'vitest';
import path from 'path';
import {
  skillChildOrigin,
  agentChildOrigin,
  composeNodeGated,
  type ChildToolOrigin,
} from '../../agent/tools/nesting.can-use-tool.js';
import { relocatesChildren, outsidePaths } from './acp.permission.paths.js';

const SESSION_CWD = '/home/user/project';
const CHILD_CWD = '/home/user/project/subdir';
const OUTER_CWD = '/home/user/other';

describe('item 2: child cwd is correctly threaded', () => {
  describe('skillChildOrigin', () => {
    it('carries the cwd when given an absolute directory', () => {
      const origin = skillChildOrigin(1, 'my-skill', CHILD_CWD);
      expect(origin.cwd).toBe(CHILD_CWD);
    });

    it('omits cwd when undefined is passed', () => {
      const origin = skillChildOrigin(1, 'my-skill', undefined);
      expect(origin.cwd).toBeUndefined();
    });

    it('omits cwd when a relative path is passed (non-absolute)', () => {
      const origin = skillChildOrigin(1, 'my-skill', 'relative/path');
      expect(origin.cwd).toBeUndefined();
    });
  });

  describe('agentChildOrigin', () => {
    it('carries the cwd when absolute', () => {
      const origin = agentChildOrigin(1, 'general-purpose', 'lbl', CHILD_CWD);
      expect(origin.cwd).toBe(CHILD_CWD);
    });
  });

  describe('relocatesChildren — continuation chain always asks', () => {
    it('continuation_chain_id arms relocatesChildren', () => {
      expect(relocatesChildren('agent', { continuation_chain_id: 'abc123' }, SESSION_CWD, path)).toBe(true);
    });

    it('isolation:worktree arms relocatesChildren', () => {
      expect(relocatesChildren('agent', { isolation: 'worktree' }, SESSION_CWD, path)).toBe(true);
    });

    it('isolation:none does NOT arm relocatesChildren', () => {
      expect(relocatesChildren('agent', { isolation: 'none' }, SESSION_CWD, path)).toBe(false);
    });
  });

  describe('outsidePaths — child cwd outside session cwd is surfaced', () => {
    it('a no-path call from a child outside session cwd shows callerCwd as outside', () => {
      // child cwd = /home/user/other (outside session /home/user/project)
      const outside = outsidePaths('read_file', {}, SESSION_CWD, OUTER_CWD, path);
      expect(outside.length).toBeGreaterThan(0);
    });

    it('a relative path from a child cwd that escapes session cwd is outside', () => {
      // child is in /home/user/project/subdir; ../../etc/passwd escapes session
      const outside = outsidePaths('read_file', { file_path: '../../etc/passwd' }, SESSION_CWD, CHILD_CWD, path);
      expect(outside.length).toBeGreaterThan(0);
    });

    it('a relative path that stays inside session cwd is NOT outside', () => {
      const outside = outsidePaths('read_file', { file_path: '../notes.txt' }, SESSION_CWD, CHILD_CWD, path);
      // /home/user/project/subdir/../notes.txt = /home/user/project/notes.txt — inside
      expect(outside).toHaveLength(0);
    });
  });

  describe('composeNodeGated — explicit cwd node carries origin.cwd', () => {
    it('a non-isolated node with explicit cwd threads cwd to the gate origin', () => {
      const capturedOrigins: Array<ChildToolOrigin> = [];
      const factory = (origin: ChildToolOrigin) => {
        capturedOrigins.push(origin);
        return undefined;
      };
      composeNodeGated({}, factory, { id: 'n1' }, 1, CHILD_CWD);
      expect(capturedOrigins).toHaveLength(1);
      expect(capturedOrigins[0]!.cwd).toBe(CHILD_CWD);
    });

    it('an isolated node passes undefined cwd (tree not yet created)', () => {
      const capturedOrigins: Array<ChildToolOrigin> = [];
      const factory = (origin: ChildToolOrigin) => {
        capturedOrigins.push(origin);
        return undefined;
      };
      // nodeCwd is undefined for isolation:'worktree' (compose-executor.node-build.ts:126)
      composeNodeGated({}, factory, { id: 'n1' }, 1, undefined);
      expect(capturedOrigins).toHaveLength(1);
      // With cwd undefined, the gate treats the child as cwd-unknown → asks.
      // This is intentional and safe (no bypass).
      expect(capturedOrigins[0]!.cwd).toBeUndefined();
    });
  });
});
