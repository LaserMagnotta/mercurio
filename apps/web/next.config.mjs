import process from 'node:process';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./i18n/request.ts');

/**
 * The API has no CORS on purpose: the web app proxies every call through
 * same-origin rewrites (`/api/*` → the Fastify service), so the httpOnly
 * `mercurio_session` cookie flows with zero cross-origin machinery and the
 * public API surface stays exactly what third parties see (ADR-018).
 */
const API_URL = process.env.API_URL ?? 'http://localhost:3001';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API_URL}/:path*` }];
  },
};

export default withNextIntl(nextConfig);
