// On-device photo preparation (ADR-020 §2). The picked file is DECODED and
// re-drawn on a canvas before anything else: the re-encoded JPEG carries no
// EXIF (no geotag, no device serial — GDPR minimization), and only THEN is
// hashed, so bytes hashed == bytes uploaded == bytes the API will serve. The
// certified hash therefore anchors exactly what leaves the device — the
// server verifies it and refuses geotagged bytes, it never re-encodes
// (that would break the anchor).
//
// Browser-only module (canvas, createImageBitmap): the pure hashing helpers
// stay in photo-hash.ts, whose FIPS-vector tests run in node untouched.

import { sha256Hex } from './photo-hash';

/** Long-side bound of the re-encoded photo: plenty for documentary evidence
 *  of a parcel, and keeps uploads mobile-friendly (well under the API's
 *  PHOTO_MAX_BYTES). */
export const MAX_PHOTO_DIMENSION_PX = 2048;

const JPEG_QUALITY = 0.85;

/** A photo ready for certification + upload: the hash to declare to the API
 *  and the exact bytes it was computed on. */
export interface CapturedPhoto {
  sha256: string;
  blob: Blob;
}

/**
 * Decode → canvas → JPEG → sha256. `imageOrientation: 'from-image'` bakes the
 * EXIF rotation into the pixels before the metadata is dropped, so stripped
 * photos don't come out sideways. Throws when the browser cannot decode the
 * file (the caller shows per-file copy — an undecodable file must never fall
 * back to uploading original, EXIF-laden bytes).
 */
export async function capturePhoto(file: File): Promise<CapturedPhoto> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const scale = Math.min(1, MAX_PHOTO_DIMENSION_PX / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d context unavailable');
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (result) => (result ? resolve(result) : reject(new Error('jpeg encode failed'))),
        'image/jpeg',
        JPEG_QUALITY,
      );
    });
    return { sha256: await sha256Hex(await blob.arrayBuffer()), blob };
  } finally {
    bitmap.close();
  }
}
