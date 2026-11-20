import path from 'node:path';
import type { OutputEvent } from '../../../agent/types/session-types.js';
import type { DiffPayload } from '../../../utils/diff.js';
import type { ChildToolOrigin } from '../../../agent/tools/nesting.can-use-tool.js';

/** A tool call a forked child makes while the parent's delegation tool runs (D9). */
export interface ChildCall { origin: ChildToolOrigin; id: string; name: string; input: Record<string, unknown> }
export interface ScriptedTool {
  kind: 'tool'; id: string; name: string; input: Record<string, unknown>;
  result: string; isError?: boolean; diff?: DiffPayload; children?: ChildCall[];
}
export type ScriptStep = OutputEvent | ScriptedTool | { kind: 'await-abort' };
export interface ScriptedTurn { prompt: string; steps: ScriptStep[] }
export interface GoldenScript { turns: ScriptedTurn[]; executed: string[]; asked: string[] }
export const persistedId = '11111111-1111-4111-8111-111111111111';

const done: OutputEvent = { type: 'done', metadata: { stopReason: 'end_turn' } };
function text(content: string): OutputEvent {
  // stream-consumer.ts delta.text → content, not progress.tool_start.
  return { type: 'chunk', chunk: { type: 'content', content,
    metadata: { eventType: 'delta', deltaType: 'text_delta' } } };
}
function write(root: string, id = 'tool-1', second = false): ScriptedTool {
  return { kind: 'tool', id, name: 'write_file',
    input: { file_path: path.join(root, second ? 'second.txt' : 'new.txt'), content: second ? 'next\n' : 'hello\n' },
    result: second ? 'Wrote 5 bytes' : 'Wrote 6 bytes' };
}
function delegate(child: Omit<ChildCall, 'origin'>, result: string): ScriptedTool {
  return { kind: 'tool', id: 'tool-1', name: 'agent', input: { prompt: 'Do it', agent_type: 'research-agent' }, result,
    children: [{ origin: { route: 'agent', depth: 1, agentType: 'research-agent' }, ...child }] };
}
function turn(prompt: string, ...steps: ScriptStep[]): ScriptedTurn {
  return { prompt, steps: [...steps, done] };
}

/** Independent internal-event companions; never derived from expected agent frames. */
export function scriptFor(stem: string, root: string): GoldenScript {
  let turns: ScriptedTurn[];
  switch (stem) {
    case 'text-turn':
      turns = [{ prompt: 'Hello', steps: [
        { type: 'chunk', chunk: { type: 'thinking', content: 'I will greet the user.',
          metadata: { eventType: 'delta', deltaType: 'thinking_delta' } } },
        text('Hello!'), { type: 'done', metadata: { stopReason: 'end_turn', totalCostUsd: 0.01,
          usage: { input_tokens: 1000, output_tokens: 24, context_window_tokens: 1024 } } },
      ] }];
      break;
    case 'tool-read':
      turns = [turn('Read a.txt', { kind: 'tool', id: 'tool-1', name: 'read_file',
        input: { file_path: path.join(root, 'a.txt'), offset: 1 }, result: 'old\n' })];
      break;
    case 'tool-edit-diff':
      turns = [turn('Replace old with new in a.txt', { kind: 'tool', id: 'tool-1', name: 'edit_file',
        input: { file_path: path.join(root, 'a.txt'), old_string: 'old', new_string: 'new' },
        result: 'Replaced 1 occurrence', diff: { addedLines: 1, removedLines: 1,
          hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
            lines: [{ kind: '-', text: 'old' }, { kind: '+', text: 'new' }] }] } })];
      break;
    case 'tool-bash-failed':
      turns = [turn('Run exit 1', { kind: 'tool', id: 'tool-1', name: 'bash',
        input: { command: 'exit 1' }, result: 'Command exited with code 1', isError: true })];
      break;
    case 'permission-allow-once':
    case 'permission-reject':
    case 'cancel-during-permission':
      turns = [turn('Write new.txt', write(root))];
      break;
    case 'permission-allow-always-then-skip':
      turns = [turn('Write new.txt', write(root)), turn('Write second.txt', write(root, 'tool-2', true))];
      break;
    case 'cancel-during-stream':
      turns = [turn('Say hello', text('Hello'), { kind: 'await-abort' })];
      break;
    case 'child-approval-allow':
      turns = [turn('Delegate a listing', delegate({ id: 'tool-c1', name: 'bash', input: { command: 'ls' } }, 'Listed files'))];
      break;
    case 'child-approval-reject':
      turns = [turn('Delegate a write', delegate({ id: 'tool-c1', name: 'write_file',
        input: { file_path: path.join(root, 'child.txt'), content: 'x\n' } }, 'Subagent could not write'))];
      break;
    case 'read-outside-cwd-asked':
      turns = [turn('List the parent directory', { kind: 'tool', id: 'tool-1', name: 'list_directory',
        input: { path: path.join(root, '..') }, result: 'acp-golden/' })];
      break;
    case 'resume':
    case 'load-live-session':
      turns = [turn('Continue', text('Continuing.'))];
      break;
    case 'session-cwd-outside-launch':
      turns = [turn('Hello', text('Hello from outside the launch directory.'))];
      break;
    case 'load-replay':
    case 'close-idempotent':
    case 'bad-version-negotiation':
    case 'error-session-data':
      turns = [];
      break;
    default: throw new Error(`A6 missing internal script for ${stem}`);
  }
  return { turns, executed: [], asked: [] };
}
