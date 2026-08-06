import { describe, expect, it } from 'vitest';
import { RAW_SGR_RE, isStylingSgr } from '../scripts/audit-chalk-sgr.js';

describe('raw SGR audit classification', () => {
  it.each(['', '0', '10', '22', '23', '24', '25', '27', '28', '29', '39', '49', '50', '54', '55', '59', '65', '75'])(
    'allows reset or style-closing parameter %j',
    (params) => {
      expect(isStylingSgr(params)).toBe(false);
    },
  );

  it.each([
    '1',
    '9',
    '11',
    '21',
    '26',
    '30',
    '38;5;208',
    '40',
    '48;2;10;20;30',
    '51',
    '52',
    '53',
    '58;5;208',
    '60',
    '64',
    '73',
    '74',
    '90',
    '97',
    '100',
    '107',
    '0;53',
  ])('flags styling opener parameter %j', (params) => {
    expect(isStylingSgr(params)).toBe(true);
  });

  it.each([
    ['\\x1b[53m', '53'],
    ['\\x1B[58;5;208m', '58;5;208'],
    ['\\u001b[73m', '73'],
    ['\\u001B[74m', '74'],
    ['\\u{001b}[51m', '51'],
    ['\\e[52m', '52'],
    ['\\033[60m', '60'],
  ])('recognizes literal %s', (literal, params) => {
    RAW_SGR_RE.lastIndex = 0;
    expect(RAW_SGR_RE.exec(literal)?.[1]).toBe(params);
  });

  it.each(['\\x1b[2K', '\\x1b[1H', '/\\x1b\\[[0-9;]*m/', '\\x1b[53M'])('ignores non-emitter %s', (literal) => {
    RAW_SGR_RE.lastIndex = 0;
    expect(RAW_SGR_RE.test(literal)).toBe(false);
  });
});
