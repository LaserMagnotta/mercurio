import { describe, expect, it } from 'vitest';
import { parseQrInput } from '../qr-input';

describe('parseQrInput', () => {
  it('returns a bare token unchanged (trimmed)', () => {
    expect(parseQrInput('  abc123TOKEN ')).toBe('abc123TOKEN');
  });

  it('extracts the token from a scanned tracking URL', () => {
    expect(parseQrInput('https://mercurio.example/p/tok_42')).toBe('tok_42');
  });

  it('ignores trailing path, query and fragment', () => {
    expect(parseQrInput('http://localhost:3000/p/tok42?x=1')).toBe('tok42');
    expect(parseQrInput('http://localhost:3000/p/tok42#top')).toBe('tok42');
    expect(parseQrInput('http://localhost:3000/p/tok42/')).toBe('tok42');
  });

  it('uses the LAST /p/ segment (path prefixes cannot shadow it)', () => {
    expect(parseQrInput('https://x.example/app/p/old/p/new')).toBe('new');
  });
});
