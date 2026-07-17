// Hand-built JPEG fixtures for the photo suites (ADR-020). The server never
// DECODES images — it checks magic bytes and scans EXIF structures — so a
// structurally valid segment list with unique payload bytes is a perfectly
// honest stand-in for a camera shot, and keeps the tests dependency-free.

export const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Minimal JPEG: SOI + COM segment carrying `label` (unique bytes ⇒ unique
 *  sha256) + EOI. */
export function buildJpeg(label: string): Buffer {
  const comment = Buffer.from(`mercurio-test:${label}`, 'utf8');
  const com = Buffer.alloc(4);
  com[0] = 0xff;
  com[1] = 0xfe; // COM
  com.writeUInt16BE(comment.length + 2, 2);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]), // SOI
    com,
    comment,
    Buffer.from([0xff, 0xd9]), // EOI
  ]);
}

export interface ExifJpegOptions {
  /** Include the GPS IFD pointer tag (0x8825) in IFD0. */
  gps: boolean;
  /** TIFF byte order inside the EXIF block (default little-endian, "II"). */
  littleEndian?: boolean;
  /** Extra payload to differentiate the sha256 between fixtures. */
  label?: string;
}

/** JPEG with an APP1/Exif segment whose IFD0 has exactly one entry: either
 *  the GPS IFD pointer (what the upload guard must refuse) or a harmless
 *  ImageDescription tag. */
export function buildJpegWithExif(options: ExifJpegOptions): Buffer {
  const le = options.littleEndian ?? true;
  const tiff = Buffer.alloc(26);
  tiff.write(le ? 'II' : 'MM', 0, 'latin1');
  const w16 = (value: number, at: number) =>
    le ? tiff.writeUInt16LE(value, at) : tiff.writeUInt16BE(value, at);
  const w32 = (value: number, at: number) =>
    le ? tiff.writeUInt32LE(value, at) : tiff.writeUInt32BE(value, at);
  w16(42, 2); // TIFF magic
  w32(8, 4); // IFD0 offset
  w16(1, 8); // IFD0 entry count
  w16(options.gps ? 0x8825 : 0x010e, 10); // GPS IFD pointer vs ImageDescription
  w16(4, 12); // type LONG
  w32(1, 14); // count
  w32(26, 18); // value/offset (nothing dereferences it in the scanner)
  w32(0, 22); // next IFD: none

  const exifHeader = Buffer.from('Exif\0\0', 'latin1');
  const app1 = Buffer.alloc(4);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1.writeUInt16BE(2 + exifHeader.length + tiff.length, 2);

  const comment = Buffer.from(`exif-fixture:${options.label ?? ''}`, 'utf8');
  const com = Buffer.alloc(4);
  com[0] = 0xff;
  com[1] = 0xfe;
  com.writeUInt16BE(comment.length + 2, 2);

  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    app1,
    exifHeader,
    tiff,
    com,
    comment,
    Buffer.from([0xff, 0xd9]),
  ]);
}
