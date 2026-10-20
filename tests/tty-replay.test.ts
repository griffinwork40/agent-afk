/**
 * Tests for scripts/tty-replay.ts (the AFK_TTY_TRACE cast replayer).
 *
 * The script is a top-level-await ES module, so it is exercised as a child
 * process via tsx against synthetic asciinema v2 casts in a temp dir.
 *
 * Pinned regressions:
 *   - xterm's Terminal.write() is async; an unawaited write left the final
 *     snapshot blank and let a resize apply before earlier bytes were parsed.
 *   - a header of width/height 0 (recorded on a sizeless PTY) made xterm clamp
 *     to 2x1; replay must fall back to 80x24.
 */

import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve(import.meta.dirname, '../scripts/tty-replay.ts');
const TSX = path.resolve(import.meta.dirname, '../node_modules/.bin/tsx');

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-tty-replay-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeCast(header: { width: number; height: number }, events: unknown[]): string {
  const file = path.join(dir, 'test.cast');
  const lines = [JSON.stringify({ version: 2, ...header }), ...events.map((e) => JSON.stringify(e))];
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

function replay(cast: string, flags: string[] = []): string {
  return child_process.execFileSync(TSX, [SCRIPT, cast, ...flags], { encoding: 'utf8' });
}

describe('tty-replay', () => {
  it('prints parsed output on CUP-numbered visible rows (writes are awaited)', () => {
    const cast = writeCast({ width: 40, height: 6 }, [
      [0, 'o', 'first\r\n'],
      [0.1, 'o', '\u001b[4;3Hghost row'],
    ]);
    const out = replay(cast);
    expect(out).toContain('Terminal snapshot (40×6)');
    expect(out).toMatch(/^ {3}1: first$/m);
    expect(out).toMatch(/^ {3}4: {3}ghost row$/m);
  });

  it('applies resize events after the bytes recorded before them', () => {
    const cast = writeCast({ width: 40, height: 10 }, [
      [0, 'o', '\u001b[2;1Hkept'],
      [0.5, 'r', '20x5'],
      [1, 'o', '\u001b[5;1Hbottom'],
    ]);
    const out = replay(cast);
    expect(out).toContain('Terminal snapshot (20×5)');
    expect(out).toMatch(/^ {3}5: bottom$/m);
  });

  it('falls back to 80x24 when the header recorded a zero size', () => {
    const cast = writeCast({ width: 0, height: 0 }, [[0, 'o', 'hello']]);
    const out = replay(cast);
    expect(out).toContain('Terminal snapshot (80×24)');
    expect(out).toMatch(/^ {3}1: hello$/m);
  });

  it('honours --cols/--rows and --at', () => {
    const cast = writeCast({ width: 80, height: 24 }, [
      [0, 'o', 'early'],
      [5, 'o', '\r\nlate'],
    ]);
    const out = replay(cast, ['--cols', '30', '--rows', '4', '--at', '1']);
    expect(out).toContain('Terminal snapshot (30×4)');
    expect(out).toContain('early');
    expect(out).not.toContain('late');
  });
});
