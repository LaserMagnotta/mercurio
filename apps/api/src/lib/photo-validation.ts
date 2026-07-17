// Server-side photo validation (ADR-020 §2-3). The server never re-encodes
// (that would break the hash anchor certified in the custody chain): it can
// only VERIFY — magic bytes for the JPEG whitelist, and a defensive scan for
// a GPS EXIF block, protecting against third-party clients (or first-party
// bugs) uploading geotagged originals. Both parsers are bounded and treat
// malformed input as "not acceptable", never as a crash.

/** MIME whitelist is decided on magic bytes, not on the request header:
 *  the first-party client always uploads canvas-re-encoded JPEG (ADR-020). */
export function isJpeg(bytes: Buffer): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/** EXIF tag 0x8825 = GPS Info IFD pointer (EXIF 2.3 §4.6.6). */
const GPS_IFD_TAG = 0x8825;

/**
 * True when the JPEG carries an EXIF block with a GPS IFD. Walks the JPEG
 * segment list to APP1/"Exif", then IFD0 of the TIFF structure inside it —
 * read-only, bounded by the buffer length, and any structural surprise
 * returns false (the upload is then judged by the other guards, and a
 * segment we cannot parse cannot hide a *standard* GPS block readers would
 * find either).
 */
export function jpegHasGpsExif(bytes: Buffer): boolean {
  if (!isJpeg(bytes)) return false;
  let offset = 2; // past SOI
  // JPEG segment walk: 0xFF marker + 2-byte big-endian length (incl. itself).
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return false; // desynchronized: stop scanning
    const marker = bytes[offset + 1]!;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2; // standalone markers carry no length
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return false; // image data / EOI: no APP1 found
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length) return false;
    if (marker === 0xe1 && bytes.subarray(offset + 4, offset + 10).toString('latin1') === 'Exif\0\0') {
      return tiffHasGpsIfd(bytes.subarray(offset + 10, offset + 2 + length));
    }
    offset += 2 + length;
  }
  return false;
}

function tiffHasGpsIfd(tiff: Buffer): boolean {
  if (tiff.length < 8) return false;
  const order = tiff.toString('latin1', 0, 2);
  const le = order === 'II';
  if (!le && order !== 'MM') return false;
  const u16 = (at: number) => (le ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
  const u32 = (at: number) => (le ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at));
  if (u16(2) !== 42) return false; // TIFF magic
  const ifd0 = u32(4);
  if (ifd0 + 2 > tiff.length) return false;
  const count = u16(ifd0);
  for (let i = 0; i < count; i++) {
    const entry = ifd0 + 2 + i * 12;
    if (entry + 12 > tiff.length) return false;
    if (u16(entry) === GPS_IFD_TAG) return true;
  }
  return false;
}
