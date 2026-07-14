// The parcel QR encodes the public tracking URL `<origin>/p/<qr_token>`
// (ARCHITECTURE.md §7: the QR identifies, it never authorizes). Hub and
// carrier operators scan it into a text field — a hardware scanner or a
// camera app pastes the WHOLE URL, a manual operator may type the bare
// token. Both must work, so every QR field accepts either form.

/** Extracts the qr_token from a scanned/pasted value: the segment after
 *  `/p/` when the value is a tracking URL, the trimmed value otherwise. */
export function parseQrInput(raw: string): string {
  const value = raw.trim();
  const marker = value.lastIndexOf('/p/');
  if (marker === -1) return value;
  const rest = value.slice(marker + 3);
  const end = rest.search(/[/?#]/);
  return end === -1 ? rest : rest.slice(0, end);
}
