/**
 * VirtualScreen — ANSI terminal emulator for testing
 *
 * Processes byte-level ANSI escape sequences and maintains a 2D grid representing
 * the visible screen. Handles multibyte UTF-8 sequences split across writes,
 * detects broken sequences (with `\uFFFD`), and tracks cursor position, scrollback,
 * and terminal attributes.
 *
 * @module cli/_lib/testing/virtual-screen
 */

import { displayWidth } from '../../display.js';
import { dispatchCsi, type CsiHost } from './virtual-screen.csi.js';

type ParserState = 'GROUND' | 'ESC' | 'CSI' | 'OSC' | 'UTF8';

interface UTF8Accumulator {
  bytes: number[];
  needed: number;
}

/**
 * VirtualScreen — ANSI terminal interpreter
 *
 * Converts a stream of bytes (UTF-8 encoded) into a visible 2D screen grid.
 * Emulates xterm-like behavior for:
 * - Cursor positioning and wrapping
 * - Scrolling regions (DECSTBM)
 * - Erase operations (ED/EL)
 * - Basic OSC capture (e.g., OSC 9 notifications)
 * - UTF-8 multibyte handling and broken-sequence detection
 *
 * @public
 */
export class VirtualScreen {
  readonly cols: number;
  readonly rows: number;

  private grid: string[][];
  private cursorRow: number;
  private cursorCol: number;
  private pendingWrap: boolean;
  private scrollTop: number;
  private scrollBottom: number;
  private cursorHidden: boolean;
  private bellCount: number;
  private oscSequences: string[];
  private scrollback: string[];

  // Parser state machine
  private parserState: ParserState = 'GROUND';
  private csiParams: number[] = [];
  private csiPrivatePrefix: boolean = false;
  private oscBuffer: string = '';
  private utf8Accum: UTF8Accumulator | null = null;

  constructor(cols = 80, rows = 24) {
    this.cols = cols;
    this.rows = rows;
    this.grid = this.makeGrid();
    this.cursorRow = 1;
    this.cursorCol = 1;
    this.pendingWrap = false;
    this.scrollTop = 1;
    this.scrollBottom = rows;
    this.cursorHidden = false;
    this.bellCount = 0;
    this.oscSequences = [];
    this.scrollback = [];
  }

  private makeGrid(): string[][] {
    return Array.from({ length: this.rows }, () =>
      Array.from({ length: this.cols }, () => ' '),
    );
  }

  private clampRow(r: number): number {
    return Math.max(1, Math.min(r, this.rows));
  }

  private clampCol(c: number): number {
    return Math.max(1, Math.min(c, this.cols));
  }

  /**
   * Write data (string or Uint8Array) to the screen. If string, encodes via UTF-8.
   * Feeds each byte through the parser state machine.
   */
  write(data: string | Uint8Array): void {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
    for (let i = 0; i < bytes.length; i++) {
      const byte = bytes[i];
      if (byte !== undefined) {
        this.processByte(byte);
      }
    }
  }

  private processByte(byte: number): void {
    if (this.parserState === 'GROUND') {
      this.processGroundByte(byte);
    } else if (this.parserState === 'ESC') {
      this.processEscByte(byte);
    } else if (this.parserState === 'CSI') {
      this.processCsiByte(byte);
    } else if (this.parserState === 'OSC') {
      this.processOscByte(byte);
    } else if (this.parserState === 'UTF8') {
      this.processUtf8Byte(byte);
    }
  }

  private processGroundByte(byte: number): void {
    // C0 controls and single-byte characters
    if (byte === 0x1b) {
      // ESC — start escape sequence
      this.parserState = 'ESC';
    } else if (byte === 0x07) {
      // BEL
      this.bellCount++;
    } else if (byte === 0x0a) {
      // LF (line feed)
      this.lineFeed();
    } else if (byte === 0x0d) {
      // CR (carriage return)
      this.cursorCol = 1;
      this.pendingWrap = false;
    } else if (byte === 0x08) {
      // BS (backspace)
      this.cursorCol = this.clampCol(this.cursorCol - 1);
    } else if (byte === 0x09) {
      // TAB — advance to next multiple of 8
      this.cursorCol = Math.min(
        this.cols,
        Math.floor((this.cursorCol + 7) / 8) * 8 + 1,
      );
    } else if (byte >= 0x20 && byte <= 0x7e) {
      // Printable ASCII
      this.putChar(String.fromCharCode(byte));
    } else if (byte >= 0x00 && byte <= 0x1f && byte !== 0x07 && byte !== 0x08 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) {
      // Other C0 controls — ignore
    } else if (byte === 0x7f) {
      // DEL — ignore
    } else if (byte >= 0x80 && byte <= 0xbf) {
      // Stray continuation byte — emit replacement
      this.putChar('�');
    } else if (byte >= 0xc2 && byte <= 0xdf) {
      // 2-byte UTF-8 sequence
      this.parserState = 'UTF8';
      this.utf8Accum = { bytes: [byte], needed: 1 };
    } else if (byte >= 0xe0 && byte <= 0xef) {
      // 3-byte UTF-8 sequence
      this.parserState = 'UTF8';
      this.utf8Accum = { bytes: [byte], needed: 2 };
    } else if (byte >= 0xf0 && byte <= 0xf4) {
      // 4-byte UTF-8 sequence
      this.parserState = 'UTF8';
      this.utf8Accum = { bytes: [byte], needed: 3 };
    } else if (byte === 0xc0 || byte === 0xc1 || byte > 0xf4) {
      // Invalid UTF-8 start byte
      this.putChar('�');
    }
  }

  private processEscByte(byte: number): void {
    if (byte === 0x5b) {
      // ESC [ — CSI
      this.parserState = 'CSI';
      this.csiParams = [];
      this.csiPrivatePrefix = false;
    } else if (byte === 0x5d) {
      // ESC ] — OSC
      this.parserState = 'OSC';
      this.oscBuffer = '';
    } else {
      // 2-byte escape or unknown — ignore
      this.parserState = 'GROUND';
    }
  }

  private processCsiByte(byte: number): void {
    // CSI parameter byte — collect parameter digits and separators
    if (byte === 0x3f) {
      // '?' — private prefix
      this.csiPrivatePrefix = true;
    } else if (byte >= 0x30 && byte <= 0x39) {
      // '0'-'9' — digit; accumulate into the last param
      if (this.csiParams.length === 0) {
        this.csiParams.push(byte - 0x30);
      } else {
        const last = this.csiParams[this.csiParams.length - 1];
        if (last !== undefined) {
          // If last param is a number, accumulate; if it's a separator marker (-1), start new param
          if (last === -1) {
            this.csiParams[this.csiParams.length - 1] = byte - 0x30;
          } else {
            this.csiParams[this.csiParams.length - 1] = last * 10 + (byte - 0x30);
          }
        }
      }
    } else if (byte === 0x3b) {
      // ';' — param separator; mark end of current param
      this.csiParams.push(-1);
    } else if (byte >= 0x20 && byte <= 0x2f) {
      // Intermediate bytes — ignore for now
    } else if (byte >= 0x40 && byte <= 0x7e) {
      // Final byte — dispatch
      this.dispatchCsi(byte);
      this.parserState = 'GROUND';
    } else {
      // Unexpected byte — abort CSI
      this.parserState = 'GROUND';
    }
  }

  private dispatchCsi(final: number): void {
    // Cast: VirtualScreen satisfies CsiHost structurally (all required fields
    // are present at runtime) but TypeScript's `private` keyword prevents the
    // direct assignment. The cast is safe because:
    //   (1) every field CsiHost declares is present on VirtualScreen,
    //   (2) dispatchCsi reads and writes exactly those fields,
    //   (3) this cast is the only site that crosses the visibility boundary.
    dispatchCsi(this as unknown as CsiHost, final, this.csiParams, this.csiPrivatePrefix);
  }

  private processOscByte(byte: number): void {
    if (byte === 0x07) {
      // BEL — end OSC
      this.oscSequences.push(this.oscBuffer);
      this.parserState = 'GROUND';
    } else if (byte === 0x1b) {
      // ESC — might be ST (ESC \) or start of new sequence
      // Peek ahead: if next byte is '\' we consume both as ST. For now,
      // assume BEL terminates. A real impl would buffer ESC and check next.
      // Simplified: treat ESC as terminator.
      this.oscSequences.push(this.oscBuffer);
      this.parserState = 'ESC';
    } else if (byte >= 0x20 && byte <= 0x7f) {
      // Accumulate printable
      this.oscBuffer += String.fromCharCode(byte);
    }
  }

  private processUtf8Byte(byte: number): void {
    if (!this.utf8Accum) {
      return;
    }

    if (byte >= 0x80 && byte <= 0xbf) {
      // Continuation byte
      this.utf8Accum.bytes.push(byte);
      this.utf8Accum.needed--;

      if (this.utf8Accum.needed === 0) {
        // Sequence complete — decode
        const text = new TextDecoder().decode(new Uint8Array(this.utf8Accum.bytes));
        this.putChar(text);
        this.parserState = 'GROUND';
        this.utf8Accum = null;
      }
    } else {
      // NOT a continuation byte — sequence is broken
      this.putChar('�');
      this.parserState = 'GROUND';
      this.utf8Accum = null;
      // RE-FEED the current byte through GROUND
      this.processByte(byte);
    }
  }

  private putChar(ch: string): void {
    const width = displayWidth(ch);

    // Handle pending wrap from last column
    if (this.pendingWrap) {
      this.cursorCol = 1;
      this.lineFeed();
      this.pendingWrap = false;
    }

    // Place character(s) at cursor position
    const row = this.cursorRow - 1;
    const col = this.cursorCol - 1;

    if (row >= 0 && row < this.rows && col >= 0 && col < this.cols) {
      if (width === 0) {
        // Zero-width combining — append to previous cell
        if (col > 0) {
          this.grid[row]![col - 1] = (this.grid[row]![col - 1] ?? '') + ch;
        }
      } else if (width === 1) {
        // Single-width character
        this.grid[row]![col] = ch;
        this.cursorCol++;
      } else if (width === 2) {
        // Double-width character
        if (col + 1 < this.cols) {
          this.grid[row]![col] = ch;
          this.grid[row]![col + 1] = '\x00'; // Continuation marker
          this.cursorCol += 2;
        } else {
          // Doesn't fit — wrap to next line
          this.cursorCol = this.cols;
          this.pendingWrap = true;
          return;
        }
      } else {
        // Multi-grapheme — treat as single width for now
        this.grid[row]![col] = ch;
        this.cursorCol++;
      }

      // Check if we're at the end of the line
      if (this.cursorCol > this.cols) {
        this.cursorCol = this.cols;
        this.pendingWrap = true;
      }
    }
  }

  private lineFeed(): void {
    if (this.cursorRow === this.scrollBottom) {
      this.scrollRegionUp();
    } else {
      this.cursorRow = this.clampRow(this.cursorRow + 1);
    }
    this.pendingWrap = false;
  }

  private scrollRegionUp(): void {
    // Save the top line of the region to scrollback if it's the top of screen
    if (this.scrollTop === 1) {
      const line = this.lineAt(1);
      this.scrollback.push(line);
    }

    // Shift region up
    for (let r = this.scrollTop; r < this.scrollBottom; r++) {
      const nextRow = r + 1 - 1; // 0-indexed
      const curRow = r - 1;
      if (nextRow < this.rows && curRow >= 0) {
        this.grid[curRow] = [...(this.grid[nextRow] ?? [])];
      }
    }

    // Blank the bottom line of the region
    const bottomRow = this.scrollBottom - 1;
    if (bottomRow >= 0 && bottomRow < this.rows) {
      this.grid[bottomRow] = Array.from({ length: this.cols }, () => ' ');
    }
  }

  // Erase and CSI operations are fully handled in virtual-screen.csi.ts.
  // dispatchCsi() above is the single call site.

  /**
   * Assertion API: return visible lines (1..rows), right-trimmed.
   */
  visibleLines(): string[] {
    return this.grid.map((row) => {
      let line = row.join('').replace(/\x00/g, '');
      // Right-trim
      line = line.replace(/\s+$/, '');
      return line;
    });
  }

  /**
   * Get a single visible line by row number (1-based).
   */
  lineAt(row: number): string {
    const idx = row - 1;
    if (idx < 0 || idx >= this.rows) {
      return '';
    }
    let line = this.grid[idx]!.join('').replace(/\x00/g, '');
    line = line.replace(/\s+$/, '');
    return line;
  }

  /**
   * Get all scrollback lines.
   */
  scrollbackLines(): string[] {
    return [...this.scrollback];
  }

  /**
   * Combined screen: visible + scrollback, useful for assertions.
   */
  screenText(): string {
    const lines = [...this.scrollback, ...this.visibleLines()];
    return lines.join('\n');
  }

  /**
   * Current cursor position (1-based).
   */
  get cursor(): { row: number; col: number } {
    return { row: this.cursorRow, col: this.cursorCol };
  }

  /**
   * Expose read-only properties for assertions.
   */
  isCursorHidden(): boolean {
    return this.cursorHidden;
  }

  getBellCount(): number {
    return this.bellCount;
  }

  getOscSequences(): string[] {
    return [...this.oscSequences];
  }

  /**
   * Expose pendingWrap for test assertions.
   */
  getPendingWrap(): boolean {
    return this.pendingWrap;
  }

  /**
   * Reset for reuse in tests.
   */
  reset(): void {
    this.grid = this.makeGrid();
    this.cursorRow = 1;
    this.cursorCol = 1;
    this.pendingWrap = false;
    this.scrollTop = 1;
    this.scrollBottom = this.rows;
    this.cursorHidden = false;
    this.bellCount = 0;
    this.oscSequences = [];
    this.scrollback = [];
    this.parserState = 'GROUND';
    this.csiParams = [];
    this.csiPrivatePrefix = false;
    this.oscBuffer = '';
    this.utf8Accum = null;
  }
}
