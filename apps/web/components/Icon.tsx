// The app's whole icon set, hand-drawn on a 24×24 grid with one stroke
// family (1.75px, round caps/joins, currentColor): a single visual weight
// everywhere instead of platform-dependent emoji (Fase 5 de-slop). Icons are
// decorative by default (aria-hidden): every use sits next to a text label —
// icon-only actions are not a pattern this UI uses.
//
// No 'use client': pure SVG output renders in server components too.

import type { ReactNode, SVGProps } from 'react';

export type IconName =
  | 'home'
  | 'parcel'
  | 'car'
  | 'storefront'
  | 'bolt'
  | 'star'
  | 'mercury';

const PATHS: Record<IconName, ReactNode> = {
  home: (
    <>
      <path d="M4.5 10.5 12 3.5l7.5 7" />
      <path d="M6.5 9.5V20h11V9.5" />
      <path d="M10 20v-5.5h4V20" />
    </>
  ),
  parcel: (
    <>
      <path d="M12 3l8 4v10l-8 4-8-4V7l8-4z" />
      <path d="M4 7l8 4 8-4" />
      <path d="M12 11v10" />
      <path d="m8 5 8 4" />
    </>
  ),
  car: (
    <>
      <path d="M5.5 13 6.8 8.9a2 2 0 0 1 1.9-1.4h6.6a2 2 0 0 1 1.9 1.4L18.5 13" />
      <path d="M4 17.5v-2.7A1.8 1.8 0 0 1 5.8 13h12.4a1.8 1.8 0 0 1 1.8 1.8v2.7" />
      <circle cx="7.5" cy="17.5" r="1.6" />
      <circle cx="16.5" cy="17.5" r="1.6" />
    </>
  ),
  storefront: (
    <>
      <path d="M4.5 9 5.6 4.5h12.8L19.5 9" />
      <path d="M3.75 9a2.06 2.06 0 0 0 4.13 0 2.06 2.06 0 0 0 4.12 0 2.06 2.06 0 0 0 4.13 0A2.06 2.06 0 0 0 20.25 9" />
      <path d="M5.25 11V19.5h13.5V11" />
      <path d="M10 19.5v-4.75h4v4.75" />
    </>
  ),
  bolt: <path d="M13.2 2.8 6 13.2h4.8l-1.2 8 7.2-10.4H12l1.2-8z" />,
  star: (
    <path d="m12 3.2 2.9 5.85 6.45.94-4.67 4.55 1.1 6.43L12 17.93l-5.78 3.04 1.1-6.43-4.67-4.55 6.45-.94L12 3.2z" />
  ),
  mercury: (
    <>
      <path d="M8 2.5a4 4 0 0 0 8 0" />
      <circle cx="12" cy="9.5" r="4" />
      <path d="M12 13.5V21" />
      <path d="M8.5 17.25h7" />
    </>
  ),
};

export interface IconProps extends SVGProps<SVGSVGElement> {
  name: IconName;
  /** Square size in px (default 20). */
  size?: number;
  /** Fill with currentColor too (the "full" rating star). */
  filled?: boolean;
}

export function Icon({ name, size = 20, filled = false, ...rest }: IconProps) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {PATHS[name]}
    </svg>
  );
}
