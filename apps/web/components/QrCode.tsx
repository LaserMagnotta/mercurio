'use client';

// Client-rendered QR (SVG). The value is a public tracking URL built from
// the parcel's qr_token: the QR identifies, it never authorizes
// (ARCHITECTURE.md §7), so rendering it client-side leaks nothing.

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

export function QrCode({ value, label }: { value: string; label: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void QRCode.toString(value, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 }).then(
      (markup) => {
        if (!cancelled) setSvg(markup);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [value]);
  if (!svg) return null;
  return (
    <div
      className="qr-box"
      role="img"
      aria-label={label}
      // Locally generated markup from the `qrcode` library, not user input.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
