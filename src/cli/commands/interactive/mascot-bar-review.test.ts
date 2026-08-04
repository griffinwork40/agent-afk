import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderMiniMascotLines } from '../../mascot-mini.js';
import { MascotBar, MASCOT_BAR_ROWS } from './mascot-bar.js';

function fakeStream(columns = 100) {
  const writes: string[] = [];
  return {
    isTTY: true,
    rows: 40,
    columns,
    write(value: string) {
      writes.push(value);
      return true;
    },
    writes,
    text: () => writes.join(''),
    clear: () => writes.splice(0),
  } as unknown as NodeJS.WriteStream & {
    writes: string[];
    text(): string;
    clear(): void;
  };
}

const previousMascotFlag = process.env['AFK_GOBLIN_MASCOT'];

beforeEach(() => {
  process.env['AFK_GOBLIN_MASCOT'] = '1';
  delete process.env['AFK_PLAIN_OUTPUT'];
  delete process.env['AFK_BANNER_PLAIN'];
});

afterEach(() => {
  vi.useRealTimers();
  if (previousMascotFlag === undefined) delete process.env['AFK_GOBLIN_MASCOT'];
  else process.env['AFK_GOBLIN_MASCOT'] = previousMascotFlag;
});

describe('MascotBar PR #900 review regressions', () => {
  it.each([
    { columns: 15, expectedRows: 0 },
    { columns: 16, expectedRows: MASCOT_BAR_ROWS },
  ])('reserves $expectedRows rows at the $columns-column DECAWM boundary', ({ columns, expectedRows }) => {
    const stream = fakeStream(columns);
    const bar = new MascotBar({ getAdjacentRows: () => 0, stream });
    bar.start();
    bar.setState('working');
    expect(bar.getRowCount()).toBe(expectedRows);
    bar.stop();
  });

  it('writes the freshly rendered mascot frame into the reserved rows', () => {
    const stream = fakeStream();
    const bar = new MascotBar({ getAdjacentRows: () => 0, stream });
    bar.start();
    bar.setState('working');
    for (const line of renderMiniMascotLines('working', 0)) {
      expect(stream.text()).toContain(line);
    }
    bar.stop();
  });

  it('renders a different frame on the next animation tick', () => {
    vi.useFakeTimers();
    const stream = fakeStream();
    const bar = new MascotBar({ getAdjacentRows: () => 0, stream, frameMs: 100 });
    bar.start();
    bar.setState('working');
    const firstPaint = stream.text();
    stream.clear();
    vi.advanceTimersByTime(100);
    expect(stream.text()).not.toBe(firstPaint);
    expect(stream.text()).toContain(renderMiniMascotLines('working', 1)[0]);
    bar.stop();
  });

  it('uses the 220ms production frame interval by default', () => {
    vi.useFakeTimers();
    const stream = fakeStream();
    const bar = new MascotBar({ getAdjacentRows: () => 0, stream });
    bar.start();
    bar.setState('working');
    stream.clear();
    vi.advanceTimersByTime(219);
    expect(stream.writes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(stream.writes.length).toBeGreaterThan(0);
    bar.stop();
  });
});
