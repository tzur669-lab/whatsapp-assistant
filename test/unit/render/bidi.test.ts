import { describe, expect, it } from 'vitest';
import { FSI, LRI, PDI, isolate, isolateLtr, stripIsolates } from '../../../src/render/bidi.js';

describe('isolate', () => {
  it('wraps a run in FSI/PDI', () => {
    expect(isolate('/help')).toBe(`${FSI}/help${PDI}`);
  });

  it('leaves an empty string untouched', () => {
    expect(isolate('')).toBe('');
  });

  it('nests without losing the inner isolate', () => {
    const inner = isolate('14:00');
    expect(stripIsolates(isolate(inner))).toBe('14:00');
  });
});

describe('isolateLtr', () => {
  it('forces LTR for a run that starts with a digit', () => {
    expect(isolateLtr('14:00-15:00')).toBe(`${LRI}14:00-15:00${PDI}`);
  });

  it('leaves an empty string untouched', () => {
    expect(isolateLtr('')).toBe('');
  });
});

describe('stripIsolates', () => {
  it('removes every isolate control', () => {
    expect(stripIsolates(isolate('Yossi'))).toBe('Yossi');
    expect(stripIsolates(isolateLtr('14:00'))).toBe('14:00');
  });

  it('leaves plain Hebrew unchanged', () => {
    expect(stripIsolates('שלום עולם')).toBe('שלום עולם');
  });
});
