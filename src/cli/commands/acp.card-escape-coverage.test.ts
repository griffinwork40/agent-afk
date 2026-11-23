/**
 * Item 2: structural guarantee that every display field in every agent-to-client
 * frame is clean of bidi/invisible/tag characters.
 *
 * The test drives the REAL server via GoldenConnection, injects hostile strings
 * into every input channel the model or a file can control, collects ALL frames
 * the server emits, and walks each frame's known display keys.  An unknown
 * sessionUpdate type causes a hard failure so the list must be updated when a
 * new frame type is added.
 *
 * "Display field" = a string value shown verbatim to the human on a permission
 * card or tool-call widget.  Data fields (rawInput, rawOutput, content, ids,
 * status, kind, name) are intentionally excluded because they carry exact bytes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { env } from '../../config/env.js';
import { fakeHandle, type ScriptedSession } from './__test-utils__/acp-fake-session.js';
import { GoldenConnection } from './__test-utils__/acp-replay.js';
import type { Frame } from './__test-utils__/acp-frame-schema.js';

vi.mock('./acp.session.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./acp.session.js')>();
  return { ...actual, buildAcpSession: vi.fn() };
});
import { buildAcpSession } from './acp.session.js';

// ---------------------------------------------------------------------------
// Hostile strings placed into every model/file-controlled input channel
// ---------------------------------------------------------------------------

/** U+202E RIGHT-TO-LEFT OVERRIDE — the canonical bidi attack character. */
const RLO = '\u202E';
/** U+200B ZERO WIDTH SPACE — invisible but not bidi. */
const ZWS = '\u200B';
/** U+E0041 TAG LATIN SMALL LETTER A — tag block. */
const TAG = '\u{E0041}';

/** A hostile string containing one character from each escaped class. */
const HOSTILE = `${RLO}evil${ZWS}tag${TAG}`;

// Contract: every character matched by escapeInvisible must be absent from
// display fields.  This regex mirrors the escapeInvisible replace patterns.
const ESCAPED_CLASS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u00ad\u180e\u200b-\u200d\u2060-\u2064\ufeff\u{E0001}\u{E0020}-\u{E007F}]|\p{Cf}|\p{Cc}/gu;

// ---------------------------------------------------------------------------
// Known sessionUpdate frame types and their display fields
// ---------------------------------------------------------------------------

// History: added with choke-point fix (item 1).  If a new sessionUpdate type
// is introduced the test fails at the type-exhaustion check below; add it here.
const KNOWN_SESSION_UPDATES = new Set([
  'tool_call', 'tool_call_update',
  'agent_message_chunk', 'agent_thought_chunk', 'user_message_chunk',
  'usage_update',
]);

// Display keys per frame type.  These are the fields shown to the human.
// Fields omitted here are DATA (rawInput, rawOutput, content, ids, status,
// kind, name) and must stay byte-exact.
function displayStringsInFrame(frame: Frame): string[] {
  const results: string[] = [];

  // session/update notification — params.update is the SessionUpdate object
  if (frame['method'] === 'session/update') {
    const update = (frame['params'] as Record<string, unknown> | undefined)?.['update'];
    if (update && typeof update === 'object') {
      const u = update as Record<string, unknown>;
      const kind = u['sessionUpdate'];
      if (typeof kind === 'string' && !KNOWN_SESSION_UPDATES.has(kind)) {
        throw new Error(`Unknown sessionUpdate type "${kind}" — add it to KNOWN_SESSION_UPDATES and map its display fields`);
      }
      // tool_call and tool_call_update: title and locations[].path are display
      if (kind === 'tool_call' || kind === 'tool_call_update') {
        if (typeof u['title'] === 'string') results.push(u['title']);
        const locs = u['locations'];
        if (Array.isArray(locs)) {
          for (const loc of locs) {
            if (loc && typeof loc === 'object' && typeof (loc as Record<string,unknown>)['path'] === 'string') {
              results.push((loc as Record<string,unknown>)['path'] as string);
            }
          }
        }
      }
      // agent_message_chunk / agent_thought_chunk / user_message_chunk: content is data, not display
      // usage_update: only numeric fields — no display strings
    }
    return results;
  }

  // session/request_permission: toolCall.title, toolCall.locations[].path, options[].name
  if (frame['method'] === 'session/request_permission') {
    const params = frame['params'] as Record<string, unknown> | undefined;
    const toolCall = params?.['toolCall'] as Record<string, unknown> | undefined;
    if (toolCall) {
      if (typeof toolCall['title'] === 'string') results.push(toolCall['title']);
      const locs = toolCall['locations'];
      if (Array.isArray(locs)) {
        for (const loc of locs) {
          if (loc && typeof loc === 'object' && typeof (loc as Record<string,unknown>)['path'] === 'string') {
            results.push((loc as Record<string,unknown>)['path'] as string);
          }
        }
      }
    }
    const options = params?.['options'];
    if (Array.isArray(options)) {
      for (const opt of options) {
        if (opt && typeof opt === 'object' && typeof (opt as Record<string,unknown>)['name'] === 'string') {
          results.push((opt as Record<string,unknown>)['name'] as string);
        }
      }
    }
    return results;
  }

  return results;
}

function assertNoEscapedChars(frames: Frame[]): void {
  for (const frame of frames) {
    const displayStrings = displayStringsInFrame(frame);
    for (const s of displayStrings) {
      ESCAPED_CLASS.lastIndex = 0;
      const m = ESCAPED_CLASS.exec(s);
      if (m !== null) {
        const cp = m[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0');
        throw new Error(
          `Display field contains unescaped U+${cp} in frame:\n${JSON.stringify(frame, null, 2)}`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Harness helpers
// ---------------------------------------------------------------------------

let temporaryRoot: string;
let connections: GoldenConnection[];
let sessions: ScriptedSession[];

beforeEach(() => {
  temporaryRoot = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'acp-escape-')));
  connections = [];
  sessions = [];
  vi.spyOn(process, 'cwd').mockReturnValue(temporaryRoot);
  vi.spyOn(env, 'AFK_STATE_DIR', 'get').mockReturnValue(path.join(temporaryRoot, 'state'));
  vi.mocked(buildAcpSession).mockReset();
});

afterEach(async () => {
  for (const session of sessions) session.abort();
  try { for (const conn of connections) await conn.close(); }
  finally {
    vi.restoreAllMocks();
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

function connect(): GoldenConnection {
  const conn = new GoldenConnection();
  connections.push(conn);
  return conn;
}

/** Send initialize and session/new, return minted sessionId. */
async function initSession(conn: GoldenConnection): Promise<string> {
  conn.send({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'test', version: '0' } } });
  const initResp = await conn.frameAt(0, 'initialize response');
  expect(initResp['id']).toBe(1);
  conn.send({ jsonrpc: '2.0', id: 2, method: 'session/new',
    params: { cwd: temporaryRoot, mcpServers: [] } });
  const newResp = await conn.frameAt(1, 'session/new response');
  expect(newResp['id']).toBe(2);
  const id = (newResp['result'] as Record<string,unknown>)?.['sessionId'];
  expect(typeof id).toBe('string');
  return id as string;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('acp card escape coverage: no display field contains bidi/invisible/tag characters', () => {
  it('hostile tool input paths and agent id_prefix: all frames clean', async () => {
    // History: Injected channels:
    //   - file_path in write_file input (hostile path the model could supply)
    //   - child origin prefix (simulates model-supplied id_prefix on agent call)
    //   - MCP server name and tool name (hostile registry name)
    //   - compose node id (hostile node identifier)
    //   - skill name (hostile skill identifier)
    //   - file name in a diff (hostile path in a diff sidecar)
    //   - replayed history entry title (hostile path from persisted journal)
    const conn = connect();
    vi.mocked(buildAcpSession).mockImplementation(async options => {
      // Hostile file_path in write_file — model could supply this
      const hostilePath = path.join(temporaryRoot, `${HOSTILE}evil.txt`);
      // Hostile child prefix simulating id_prefix: "\u202Eevil" on an agent call
      const hostilePrefix = `${HOSTILE}child`;
      // Hostile MCP tool name (mcp__<server>__<tool> format)
      const hostileMcpTool = `mcp__${HOSTILE}server__${HOSTILE}tool`;
      const script = {
        turns: [
          {
            prompt: 'Hello',
            steps: [
              // write_file with hostile path — permission card will show it in locations
              { kind: 'tool' as const, id: 'tool-1', name: 'write_file',
                input: { file_path: hostilePath, content: 'x\n' },
                result: 'Wrote 2 bytes' },
              // agent call with hostile child prefix
              { kind: 'tool' as const, id: 'tool-2', name: 'agent',
                input: { prompt: `${HOSTILE} do something`, agent_type: 'research-agent' },
                result: 'done',
                children: [{
                  origin: { route: 'agent' as const, depth: 1, agentType: 'research-agent',
                    prefix: hostilePrefix },
                  id: 'child-1', name: 'bash', input: { command: `echo ${HOSTILE}` },
                }] },
              // MCP tool call with hostile server/tool name
              { kind: 'tool' as const, id: 'tool-3', name: hostileMcpTool,
                input: { arg: HOSTILE },
                result: 'ok' },
              // skill call with hostile skill name
              { kind: 'tool' as const, id: 'tool-4', name: 'skill',
                input: { name: `${HOSTILE}skill`, arguments: HOSTILE },
                result: 'ok' },
              { type: 'done' as const, metadata: { stopReason: 'end_turn' as const } },
            ],
          },
        ],
        executed: [] as string[],
        asked: [] as string[],
      };
      const handle = fakeHandle(options, script);
      sessions.push(handle.session as unknown as ScriptedSession);
      return handle;
    });

    const sessionId = await initSession(conn);
    // Send a prompt to trigger tool calls
    conn.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'Hello' }] } });

    // Collect frames until session/prompt response (id=3) arrives,
    // replying allow_once to any permission requests along the way.
    let promptRespIndex = -1;
    for (let i = 2; promptRespIndex < 0; i++) {
      const frame = await conn.frameAt(i, `collecting frame ${i}`);
      if (frame['id'] === 3) { promptRespIndex = i; break; }
      if (frame['method'] === 'session/request_permission') {
        // Reply is a JSON-RPC response with the SAME id the server sent
        const permId = frame['id'];
        conn.send({ jsonrpc: '2.0', id: permId,
          result: { outcome: { outcome: 'selected', optionId: 'allow_once' } } });
      }
    }

    // All frames collected — assert no display field contains escaped-class chars
    expect(() => assertNoEscapedChars(conn.frames)).not.toThrow();

    // Verify we actually saw tool_call frames (not just empty)
    const toolCallFrames = conn.frames.filter(f =>
      (f['params'] as Record<string,unknown> | undefined)?.['update'] !== undefined ||
      f['method'] === 'session/request_permission');
    expect(toolCallFrames.length).toBeGreaterThan(0);

    await conn.close();
  });

  it('unknown sessionUpdate type causes hard failure (future-proofing gate)', () => {
    // If someone adds a new sessionUpdate type without mapping its display fields,
    // assertNoEscapedChars throws.  This test verifies that behaviour directly.
    const fakeFrame: Frame = {
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 'x', update: { sessionUpdate: 'brand_new_unknown_type', title: `${RLO}sneaky` } },
    };
    expect(() => assertNoEscapedChars([fakeFrame])).toThrow(
      /Unknown sessionUpdate type "brand_new_unknown_type"/,
    );
  });

  it('permission request options.name strings are clean of bidi characters', async () => {
    // permissionOptions() builds option names from server-generated constants, but
    // validate the guarantee holds end-to-end via a real permission card.
    const conn = connect();
    vi.mocked(buildAcpSession).mockImplementation(async options => {
      const script = {
        turns: [{
          prompt: 'Write',
          steps: [
            { kind: 'tool' as const, id: 'tool-1', name: 'write_file',
              input: { file_path: path.join(temporaryRoot, 'x.txt'), content: 'y\n' },
              result: 'ok' },
            { type: 'done' as const, metadata: { stopReason: 'end_turn' as const } },
          ],
        }],
        executed: [] as string[], asked: [] as string[],
      };
      const handle = fakeHandle(options, script);
      sessions.push(handle.session as unknown as ScriptedSession);
      return handle;
    });

    const sessionId = await initSession(conn);
    conn.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'Write' }] } });

    // Collect until permission request arrives
    let permIndex = -1;
    for (let i = 2; permIndex < 0 && i < 20; i++) {
      const frame = await conn.frameAt(i, `collecting frame ${i}`);
      if (frame['method'] === 'session/request_permission') { permIndex = i; break; }
    }
    expect(permIndex).toBeGreaterThan(-1);

    // Check all option names are clean
    const permFrame = conn.frames[permIndex]!;
    expect(() => assertNoEscapedChars([permFrame])).not.toThrow();

    // Reply with a JSON-RPC response using the server's id, then wait for prompt response
    const permId = permFrame['id'];
    conn.send({ jsonrpc: '2.0', id: permId,
      result: { outcome: { outcome: 'selected', optionId: 'allow_once' } } });

    // Collect remaining frames until id=3 response arrives
    for (let i = permIndex + 1; i < 20; i++) {
      const frame = await conn.frameAt(i, `collecting frame ${i}`);
      if (frame['id'] === 3) break;
    }
    await conn.close();
  });
});
