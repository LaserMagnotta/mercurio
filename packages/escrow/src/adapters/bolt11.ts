// Just enough BOLT11 to recover a payment_hash from an invoice string.
//
// Why we need this at all: NIP-47's `pay_invoice` result is `{ preimage,
// fees_paid }` — there is no payment_hash field (see ADR-019 §5). For a
// HOLD invoice the payer's wallet never learns the preimage (that's the
// whole point of a hold — ESCROW.md §2), so we cannot derive the hash from
// the RPC response either way. The hash IS embedded in the invoice itself
// (BOLT11 tagged field 'p'), so we decode it there instead — the one
// wallet-independent source of truth.
//
// We do NOT verify the invoice's bech32 checksum: a corrupted invoice would
// simply fail the real `pay_invoice` call downstream, and payment_hash here
// is informational (WalletConnection.payInvoice's return value is not used
// to gate any money movement — the coordinator tracks its own hash).

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const TAG_PAYMENT_HASH = CHARSET.indexOf('p');
const TIMESTAMP_WORDS = 7; // 35 bits

export function extractPaymentHash(bolt11: string): string {
  const invoice = bolt11.trim().toLowerCase();
  const sep = invoice.lastIndexOf('1');
  if (sep < 1) throw new Error('bolt11: missing bech32 separator');
  const dataPart = invoice.slice(sep + 1);
  if (dataPart.length < 6 + TIMESTAMP_WORDS) throw new Error('bolt11: data part too short');

  const words: number[] = [];
  for (const ch of dataPart.slice(0, -6)) {
    // last 6 words are the checksum, intentionally not verified (see above)
    const value = CHARSET.indexOf(ch);
    if (value === -1) throw new Error(`bolt11: invalid character '${ch}'`);
    words.push(value);
  }

  let i = TIMESTAMP_WORDS;
  while (i + 3 <= words.length) {
    const type = words[i]!;
    const dataLength = words[i + 1]! * 32 + words[i + 2]!;
    const tagWords = words.slice(i + 3, i + 3 + dataLength);
    if (type === TAG_PAYMENT_HASH && tagWords.length === 52) {
      return wordsToHex(tagWords);
    }
    i += 3 + dataLength;
  }
  throw new Error('bolt11: payment_hash (tag p) not found');
}

/** Bech32 5-bit-word -> byte regrouping (pad=true), trimming the trailing
 *  padding-only byte when the bit count isn't a multiple of 8 — the same
 *  convention BOLT11 decoders use to turn the 52-word 'p' tag into exactly
 *  32 bytes (260 padded bits, less the 4 padding bits of the last nibble). */
function wordsToHex(words: number[]): string {
  let acc = 0;
  let bits = 0;
  const bytes: number[] = [];
  for (const word of words) {
    acc = (acc << 5) | word;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
    }
  }
  if (bits > 0) bytes.push((acc << (8 - bits)) & 0xff);
  if ((words.length * 5) % 8 !== 0) bytes.pop();
  return Buffer.from(bytes).toString('hex');
}

/** The inverse regrouping (8-bit bytes -> 5-bit words, zero-padded). */
function bytesToWords(bytes: Buffer): number[] {
  let acc = 0;
  let bits = 0;
  const words: number[] = [];
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      words.push((acc >> bits) & 0x1f);
    }
  }
  if (bits > 0) words.push((acc << (5 - bits)) & 0x1f);
  return words;
}

/**
 * Builds a structurally-valid-enough BOLT11 string embedding `paymentHash`
 * in tag 'p' — NOT a real, spec-complete invoice (no real checksum, no
 * amount/description tags, fake all-zero timestamp). Exists only so the
 * in-process fake NWC wallet service (tests) has something realistic to
 * hand back from make_invoice/make_hold_invoice for `extractPaymentHash`
 * above to round-trip against. Never use outside tests.
 */
export function encodeFakeInvoiceForTests(paymentHashHex: string): string {
  const hashBytes = Buffer.from(paymentHashHex, 'hex');
  if (hashBytes.length !== 32) throw new Error('encodeFakeInvoiceForTests: hash must be 32 bytes');
  const tagWords = bytesToWords(hashBytes);
  const words = [
    ...Array<number>(TIMESTAMP_WORDS).fill(0),
    TAG_PAYMENT_HASH,
    Math.floor(tagWords.length / 32),
    tagWords.length % 32,
    ...tagWords,
  ];
  const dataChars = words.map((w) => CHARSET[w]).join('');
  return `lnfake1${dataChars}qqqqqq`; // 'qqqqqq': unchecked fake checksum
}
