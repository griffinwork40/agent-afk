/**
 * Test-only fake LSP server: writes a small Node script (spawned via
 * `process.execPath`) that speaks Content-Length framed JSON-RPC and is
 * driven by an embedded JSON config. Every received message and every spawn
 * is appended to a log file so tests can count spawns / inspect traffic.
 *
 * @module agent/lsp/__test-utils__/fake-lsp-server
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

export interface FakeServerConfig {
  /** Append-only JSONL log of spawns and received messages. */
  logFile?: string;
  /** Never answer anything, including initialize. */
  silent?: boolean;
  /** Exit with code 1 immediately at startup. */
  crashOnStart?: boolean;
  /** Exit with code 1 when a definition/references request arrives. */
  crashOnRequest?: boolean;
  /** Result for definition/references requests. */
  locations?: unknown[];
  /** Answer definition/references with a JSON-RPC error. */
  requestError?: boolean;
  /** Never answer definition/references (cancel still answered). */
  hangRequests?: boolean;
  /** Publish these diagnostics after every didOpen/didChange. */
  diagnostics?: unknown[];
  /** Include `version` in publishDiagnostics. Default true. */
  publishVersion?: boolean;
  /** After `initialized`, send workspace/configuration for these sections. */
  configurationSections?: string[];
}

/** Write the fake server script to `scriptPath`. */
export function writeFakeLspServer(scriptPath: string, config: FakeServerConfig = {}): void {
  const script = `
const fs = require('fs');
const cfg = ${JSON.stringify(config)};
const log = (o) => { if (cfg.logFile) fs.appendFileSync(cfg.logFile, JSON.stringify(o) + '\\n'); };
log({ spawn: process.pid });
if (cfg.crashOnStart) process.exit(1);
const send = (o) => {
  const body = JSON.stringify(Object.assign({ jsonrpc: '2.0' }, o));
  process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body);
};
let buf = Buffer.alloc(0);
const handle = (m) => {
  log({ msg: m });
  if (cfg.silent) return;
  if (m.method === 'initialize') return send({ id: m.id, result: { capabilities: {} } });
  if (m.method === 'initialized' && cfg.configurationSections) {
    return send({ id: 'cfg-1', method: 'workspace/configuration',
      params: { items: cfg.configurationSections.map((section) => ({ section })) } });
  }
  if (m.method === 'shutdown') return send({ id: m.id, result: null });
  if (m.method === 'exit') return process.exit(0);
  if (m.method === '$/cancelRequest') return send({ id: m.params.id, error: { code: -32800, message: 'cancelled' } });
  if (m.method === 'textDocument/didOpen' || m.method === 'textDocument/didChange') {
    if (!cfg.diagnostics) return;
    const td = m.params.textDocument;
    const params = { uri: td.uri, diagnostics: cfg.diagnostics };
    if (cfg.publishVersion !== false) params.version = td.version;
    return send({ method: 'textDocument/publishDiagnostics', params });
  }
  if (m.method === 'textDocument/definition' || m.method === 'textDocument/references') {
    if (cfg.crashOnRequest) process.exit(1);
    if (cfg.hangRequests) return;
    if (cfg.requestError) return send({ id: m.id, error: { code: -32601, message: 'nope' } });
    return send({ id: m.id, result: cfg.locations || [] });
  }
};
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const h = buf.indexOf('\\r\\n\\r\\n');
    if (h < 0) return;
    const len = parseInt(/Content-Length:\\s*(\\d+)/i.exec(buf.subarray(0, h).toString())[1], 10);
    if (buf.length < h + 4 + len) return;
    const body = buf.subarray(h + 4, h + 4 + len).toString();
    buf = buf.subarray(h + 4 + len);
    handle(JSON.parse(body));
  }
});
process.stdin.on('end', () => process.exit(0));
`;
  writeFileSync(scriptPath, script, 'utf8');
}

/** Entries of a fake server log file (empty when absent). */
export function readFakeLog(logFile: string): Array<{ spawn?: number; msg?: { id?: unknown; method?: string; params?: any; result?: unknown } }> {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** Number of times the fake server process started. */
export function spawnCount(logFile: string): number {
  return readFakeLog(logFile).filter((e) => e.spawn !== undefined).length;
}

/** Received messages with the given method. */
export function messagesWithMethod(logFile: string, method: string) {
  return readFakeLog(logFile).map((e) => e.msg).filter((m) => m?.method === method);
}

/** Server command for `writeFakeLspServer` output. */
export function fakeServerCmd(scriptPath: string): readonly string[] {
  return [process.execPath, scriptPath];
}
