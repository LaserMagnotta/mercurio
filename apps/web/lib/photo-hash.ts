// Client-side photo certification (ARCHITECTURE.md §5 precisazione 12): the
// MVP API accepts sha256 hashes DECLARED by the client — no blob upload, no
// storage. The photo never leaves the device; its hash enters the custody
// chain as the tamper-evident certification of what the actor photographed.

/** Max photos per certification, mirroring `photoHashesSchema` (shared). */
export const MAX_PHOTO_HASHES = 10;

/** Lowercase hex SHA-256 of raw bytes via WebCrypto (browser and Node ≥20). */
export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  // Copy into a fresh ArrayBuffer: digest() wants a BufferSource backed by a
  // plain ArrayBuffer, and TS narrows Uint8Array to ArrayBufferLike.
  const buffer = bytes.slice().buffer;
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Hashes one picked File (photo) without uploading it anywhere. */
export async function sha256HexOfFile(file: File): Promise<string> {
  return sha256Hex(await file.arrayBuffer());
}
