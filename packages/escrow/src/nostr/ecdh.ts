// Shared ECDH step for NIP-04 and NIP-44: nostr pubkeys are BIP-340 x-only
// (32 bytes); both NIPs derive their shared secret by lifting that x-only
// key to the even-Y compressed point (0x02 prefix) before secp256k1 ECDH,
// then keeping only the raw X-coordinate of the resulting shared point.

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { concatBytes, hexToBytes } from '@noble/hashes/utils.js';

export function sharedX(privkeyHex: string, xOnlyPubkeyHex: string): Uint8Array {
  const compressedPubkey = concatBytes(new Uint8Array([0x02]), hexToBytes(xOnlyPubkeyHex));
  const shared = secp256k1.getSharedSecret(hexToBytes(privkeyHex), compressedPubkey, true);
  return shared.subarray(1); // drop the 0x02 parity prefix -> 32-byte X
}
