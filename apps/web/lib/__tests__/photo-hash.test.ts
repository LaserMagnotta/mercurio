// Known-answer tests (FIPS 180-4 vectors): the declared hash IS the custody
// certification, so the hex encoding must be exactly what the API expects
// (lowercase, 64 chars — shared `sha256String`).

import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../photo-hash';

describe('sha256Hex', () => {
  it('hashes the empty input to the well-known digest', async () => {
    await expect(sha256Hex(new Uint8Array())).resolves.toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('hashes "abc" to the FIPS vector', async () => {
    await expect(sha256Hex(new TextEncoder().encode('abc'))).resolves.toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('accepts an ArrayBuffer as produced by File#arrayBuffer()', async () => {
    const bytes = new TextEncoder().encode('abc');
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    await expect(sha256Hex(buffer)).resolves.toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
