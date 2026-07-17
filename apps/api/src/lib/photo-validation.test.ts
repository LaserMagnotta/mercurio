import { describe, expect, it } from 'vitest';
import { isJpeg, jpegHasGpsExif } from './photo-validation';
import { buildJpeg, buildJpegWithExif, PNG_MAGIC } from './photo-test-fixtures';

describe('isJpeg (magic bytes, not headers)', () => {
  it('accepts SOI + marker', () => {
    expect(isJpeg(buildJpeg('x'))).toBe(true);
  });

  it('rejects PNG and truncated buffers', () => {
    expect(isJpeg(PNG_MAGIC)).toBe(false);
    expect(isJpeg(Buffer.from([0xff, 0xd8]))).toBe(false);
    expect(isJpeg(Buffer.alloc(0))).toBe(false);
  });
});

describe('jpegHasGpsExif (defensive, bounded)', () => {
  it('a plain JPEG without APP1 has no GPS', () => {
    expect(jpegHasGpsExif(buildJpeg('plain'))).toBe(false);
  });

  it('an EXIF block without a GPS IFD passes', () => {
    expect(jpegHasGpsExif(buildJpegWithExif({ gps: false }))).toBe(false);
  });

  it('detects the GPS IFD pointer in both byte orders', () => {
    expect(jpegHasGpsExif(buildJpegWithExif({ gps: true, littleEndian: true }))).toBe(true);
    expect(jpegHasGpsExif(buildJpegWithExif({ gps: true, littleEndian: false }))).toBe(true);
  });

  it('malformed segment lengths never throw, they just end the scan', () => {
    // APP1 claiming to be longer than the buffer.
    const lying = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff]),
      Buffer.from('Exif\0\0'),
    ]);
    expect(jpegHasGpsExif(lying)).toBe(false);
  });
});
