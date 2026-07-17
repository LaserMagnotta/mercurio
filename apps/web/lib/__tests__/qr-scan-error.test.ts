import { describe, expect, it } from 'vitest';
import { qrScanErrorKind } from '../qr-scan-error';

// The scanner cannot run a real camera in CI, so the degradation paths are
// pinned here on the DOMException names getUserMedia rejects with (ADR-021).
describe('qrScanErrorKind', () => {
  it('maps permission denials to "denied"', () => {
    expect(qrScanErrorKind({ name: 'NotAllowedError' })).toBe('denied');
    expect(qrScanErrorKind({ name: 'PermissionDeniedError' })).toBe('denied');
    expect(qrScanErrorKind({ name: 'SecurityError' })).toBe('denied');
  });

  it('maps missing/unsatisfiable cameras to "notfound"', () => {
    expect(qrScanErrorKind({ name: 'NotFoundError' })).toBe('notfound');
    expect(qrScanErrorKind({ name: 'DevicesNotFoundError' })).toBe('notfound');
    expect(qrScanErrorKind({ name: 'OverconstrainedError' })).toBe('notfound');
  });

  it('falls back to "generic" for anything unrecognised', () => {
    expect(qrScanErrorKind({ name: 'AbortError' })).toBe('generic');
    expect(qrScanErrorKind(new Error('boom'))).toBe('generic');
    expect(qrScanErrorKind('nope')).toBe('generic');
    expect(qrScanErrorKind(null)).toBe('generic');
    expect(qrScanErrorKind(undefined)).toBe('generic');
  });
});
