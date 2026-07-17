// ADR-021: map a getUserMedia rejection to the copy the QR scanner shows when
// it falls back to the text field. Kept as a pure function so every
// degradation path (permission denied / no camera / generic) is unit-tested
// without a DOM — the camera itself cannot run in CI. The `insecure` case (no
// https) is decided before getUserMedia is even called, so it is not mapped
// here.

export type QrScanErrorKind = 'denied' | 'notfound' | 'generic';

/** Reads the DOMException `name` a browser rejects getUserMedia with and picks
 *  the matching fallback copy. Anything unrecognised is `generic`. */
export function qrScanErrorKind(err: unknown): QrScanErrorKind {
  const name =
    typeof err === 'object' && err !== null && 'name' in err
      ? String((err as { name: unknown }).name)
      : '';
  // NotAllowedError: user or policy denied the camera. SecurityError: some
  // browsers use it for the same denial on insecure/blocked origins.
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    return 'denied';
  }
  // No camera on the device, or none matching the requested constraints.
  if (
    name === 'NotFoundError' ||
    name === 'DevicesNotFoundError' ||
    name === 'OverconstrainedError'
  ) {
    return 'notfound';
  }
  return 'generic';
}
