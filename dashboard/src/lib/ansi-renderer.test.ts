/**
 * Tests for the SGR-subset ANSI → React element renderer.
 */
import { describe, it, expect } from 'vitest';
import { renderAnsi } from './ansi-renderer';

// Helper: render and grab the children array from the outer <span>
function children(ansi: string) {
  const el = renderAnsi(ansi);
  // el is createElement('span', null, ...kids)
  const props = el.props as { children?: unknown };
  const kids = props.children;
  return Array.isArray(kids) ? kids : kids !== undefined ? [kids] : [];
}

function childProps(ansi: string, idx = 0) {
  const ch = children(ansi)[idx] as { props?: Record<string, unknown> } | undefined;
  return ch?.props ?? {};
}

// ---------------------------------------------------------------------------
// Plain text
// ---------------------------------------------------------------------------

describe('plain text', () => {
  it('returns a span with the text as child', () => {
    const el = renderAnsi('hello world');
    expect(el.type).toBe('span');
    // plain text produces a styled span wrapping the text
    const ch = children('hello world');
    const texts = ch.map((c: unknown) => {
      const node = c as { props?: { children?: unknown } };
      return node?.props?.children;
    });
    expect(texts.join('')).toBe('hello world');
  });

  it('escapes nothing — returns React elements, not HTML strings', () => {
    const el = renderAnsi('<script>&"');
    expect(el.type).toBe('span');
    // No dangerouslySetInnerHTML — just element tree
    const p = el.props as Record<string, unknown>;
    expect(p['dangerouslySetInnerHTML']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// SGR reset (0)
// ---------------------------------------------------------------------------

describe('SGR reset', () => {
  it('empty params treated as reset (SGR 0)', () => {
    // ESC[m is SGR 0
    const el = renderAnsi('\x1b[mtext');
    expect(el.type).toBe('span');
    const ch = children('\x1b[mtext');
    expect(ch.length).toBeGreaterThan(0);
  });

  it('bold then reset removes bold', () => {
    const input = '\x1b[1mbold\x1b[0mnormal';
    const ch = children(input);
    const boldNode = ch[0] as { props?: { className?: string } };
    const normalNode = ch[1] as { props?: { className?: string } };
    expect(boldNode?.props?.className).toContain('ansi-bold');
    expect(normalNode?.props?.className ?? '').not.toContain('ansi-bold');
  });
});

// ---------------------------------------------------------------------------
// SGR text decorations
// ---------------------------------------------------------------------------

describe('SGR text decorations', () => {
  it('SGR 1 → ansi-bold', () => {
    expect(childProps('\x1b[1mtext', 0).className).toContain('ansi-bold');
  });
  it('SGR 2 → ansi-dim', () => {
    expect(childProps('\x1b[2mtext', 0).className).toContain('ansi-dim');
  });
  it('SGR 3 → ansi-italic', () => {
    expect(childProps('\x1b[3mtext', 0).className).toContain('ansi-italic');
  });
  it('SGR 4 → ansi-underline', () => {
    expect(childProps('\x1b[4mtext', 0).className).toContain('ansi-underline');
  });
  it('SGR 22 removes bold+dim', () => {
    const ch = children('\x1b[1m\x1b[2m\x1b[22mnormal');
    const last = ch[ch.length - 1] as { props?: { className?: string } };
    expect(last?.props?.className ?? '').not.toContain('ansi-bold');
    expect(last?.props?.className ?? '').not.toContain('ansi-dim');
  });
  it('SGR 23 removes italic', () => {
    const ch = children('\x1b[3m\x1b[23mnormal');
    const last = ch[ch.length - 1] as { props?: { className?: string } };
    expect(last?.props?.className ?? '').not.toContain('ansi-italic');
  });
  it('SGR 24 removes underline', () => {
    const ch = children('\x1b[4m\x1b[24mnormal');
    const last = ch[ch.length - 1] as { props?: { className?: string } };
    expect(last?.props?.className ?? '').not.toContain('ansi-underline');
  });
});

// ---------------------------------------------------------------------------
// Standard foreground colors (30–37, 39, 90–97)
// ---------------------------------------------------------------------------

describe('standard foreground colors', () => {
  it('SGR 31 → ansi-fg-red class', () => {
    expect(childProps('\x1b[31mred', 0).className).toContain('ansi-fg-red');
  });
  it('SGR 32 → ansi-fg-green class', () => {
    expect(childProps('\x1b[32mgreen', 0).className).toContain('ansi-fg-green');
  });
  it('SGR 39 clears foreground', () => {
    const ch = children('\x1b[31m\x1b[39mnone');
    const last = ch[ch.length - 1] as { props?: { className?: string } };
    expect(last?.props?.className ?? '').not.toContain('ansi-fg-');
  });
  it('SGR 91 → ansi-fg-bright-red', () => {
    expect(childProps('\x1b[91mbright', 0).className).toContain('ansi-fg-bright-red');
  });
  it('SGR 97 → ansi-fg-bright-white', () => {
    expect(childProps('\x1b[97mbright', 0).className).toContain('ansi-fg-bright-white');
  });
});

// ---------------------------------------------------------------------------
// Standard background colors (40–47, 49, 100–107)
// ---------------------------------------------------------------------------

describe('standard background colors', () => {
  it('SGR 41 → ansi-bg-red', () => {
    expect(childProps('\x1b[41mbg', 0).className).toContain('ansi-bg-red');
  });
  it('SGR 49 clears background', () => {
    const ch = children('\x1b[41m\x1b[49mnone');
    const last = ch[ch.length - 1] as { props?: { className?: string } };
    expect(last?.props?.className ?? '').not.toContain('ansi-bg-');
  });
  it('SGR 101 → ansi-bg-bright-red', () => {
    expect(childProps('\x1b[101mbg', 0).className).toContain('ansi-bg-bright-red');
  });
});

// ---------------------------------------------------------------------------
// 256-color palette (38;5;n / 48;5;n)
// ---------------------------------------------------------------------------

describe('256-color palette', () => {
  it('38;5;1 → named class (index < 16)', () => {
    const cls = childProps('\x1b[38;5;1mtext', 0).className as string | undefined;
    expect(cls).toContain('ansi-fg-');
  });
  it('38;5;200 → inline rgb() color', () => {
    const style = childProps('\x1b[38;5;200mtext', 0).style as Record<string, string> | undefined;
    expect(style?.color).toMatch(/^rgb\(/);
  });
  it('38;5;235 → grayscale rgb()', () => {
    const style = childProps('\x1b[38;5;235mtext', 0).style as Record<string, string> | undefined;
    expect(style?.color).toMatch(/^rgb\(/);
  });
  it('48;5;200 → inline backgroundColor', () => {
    const style = childProps('\x1b[48;5;200mtext', 0).style as Record<string, string> | undefined;
    expect(style?.backgroundColor).toMatch(/^rgb\(/);
  });
});

// ---------------------------------------------------------------------------
// True color (38;2;r;g;b / 48;2;r;g;b)
// ---------------------------------------------------------------------------

describe('truecolor', () => {
  it('38;2;255;128;0 → color: rgb(255,128,0)', () => {
    const style = childProps('\x1b[38;2;255;128;0mtext', 0).style as Record<string, string> | undefined;
    expect(style?.color).toBe('rgb(255,128,0)');
  });
  it('48;2;0;100;200 → backgroundColor: rgb(0,100,200)', () => {
    const style = childProps('\x1b[48;2;0;100;200mtext', 0).style as Record<string, string> | undefined;
    expect(style?.backgroundColor).toBe('rgb(0,100,200)');
  });
});

// ---------------------------------------------------------------------------
// Unknown CSI / OSC sequences stripped
// ---------------------------------------------------------------------------

describe('unknown sequences stripped', () => {
  it('cursor movement ESC[2A is stripped silently', () => {
    const ch = children('\x1b[2Atext');
    const texts = ch.map((c: unknown) => {
      const node = c as { props?: { children?: unknown } };
      return String(node?.props?.children ?? '');
    });
    expect(texts.join('')).toBe('text');
  });

  it('unknown OSC stripped', () => {
    const ch = children('\x1b]0;window title\x07text');
    const texts = ch.map((c: unknown) => {
      const node = c as { props?: { children?: unknown } };
      return String(node?.props?.children ?? '');
    });
    expect(texts.join('')).toBe('text');
  });
});

// ---------------------------------------------------------------------------
// OSC 8 hyperlinks
// ---------------------------------------------------------------------------

describe('OSC 8 hyperlinks', () => {
  it('http URL → <a> with rel and target=_blank', () => {
    const ch = children('\x1b]8;;https://example.com\x07click here\x1b]8;;\x07');
    const link = ch[0] as { type?: string; props?: Record<string, string> };
    expect(link?.type).toBe('a');
    expect(link?.props?.href).toBe('https://example.com');
    expect(link?.props?.rel).toBe('noopener noreferrer');
    expect(link?.props?.target).toBe('_blank');
  });

  it('https URL → <a>', () => {
    const ch = children('\x1b]8;;https://secure.example.com\x07secure\x1b]8;;\x07');
    const link = ch[0] as { type?: string };
    expect(link?.type).toBe('a');
  });

  it('javascript: URL → plain span (not a link)', () => {
    const ch = children('\x1b]8;;javascript:alert(1)\x07xss\x1b]8;;\x07');
    const node = ch[0] as { type?: string };
    // Should NOT be an <a>; text is still rendered as a span or discarded
    if (node) {
      expect(node.type).not.toBe('a');
    }
  });

  it('empty text in OSC 8 produces no element', () => {
    const ch = children('\x1b]8;;https://example.com\x07\x1b]8;;\x07');
    // empty oscText → no element pushed
    expect(ch.length).toBe(0);
  });
});
