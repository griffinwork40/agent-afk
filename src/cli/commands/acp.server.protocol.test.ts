import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createSerialWriter, successResponse } from './acp.server.protocol.js';

describe('ACP serial protocol writer', () => {
  it('preserves frame order under backpressure', async () => {
    const lines: string[] = [];
    const output = new Writable({ highWaterMark: 1, write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString());
      setImmediate(callback);
    } });
    const write = createSerialWriter(output);
    await Promise.all([write(successResponse(1, {})), write(successResponse(2, {})), write(successResponse(3, {}))]);
    expect(lines.map(line => JSON.parse(line) as unknown)).toEqual([
      successResponse(1, {}), successResponse(2, {}), successResponse(3, {}),
    ]);
    expect(output.listenerCount('error')).toBe(0);
    expect(output.listenerCount('drain')).toBe(0);
  });

  it('does not send frames queued before a connection fails', async () => {
    const lines: string[] = [];
    const output = new Writable({ write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString());
      setImmediate(callback);
    } });
    let open = true;
    const write = createSerialWriter(output, () => open);
    const first = write(successResponse(1, {}));
    const second = write(successResponse(2, {}));
    // Allow the first physical write to start, then break the connection before its callback.
    await Promise.resolve();
    open = false;
    await Promise.all([first, second]);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!) as unknown).toEqual(successResponse(1, {}));
  });
});
