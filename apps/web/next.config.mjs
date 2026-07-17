import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./i18n/request.ts');

/**
 * The API has no CORS on purpose: the web app proxies every call through
 * same-origin rewrites (`/api/*` → the Fastify service), so the httpOnly
 * `mercurio_session` cookie flows with zero cross-origin machinery and the
 * public API surface stays exactly what third parties see (ADR-018).
 *
 * In production the same `/api/*` contract is served by the reverse proxy
 * instead (ADR-024 §4): this rewrite is baked into the build — Next freezes
 * `rewrites()` into routes-manifest.json — so it could not follow a deployed
 * container's API address anyway. Server-rendered pages read `API_URL` at
 * runtime, in both environments.
 */
const API_URL = process.env.API_URL ?? 'http://localhost:3001';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Self-contained server bundle for the production image (ADR-024 §1): Next
  // traces exactly the files it needs, so the runtime stage carries no pnpm
  // store and no build toolchain.
  //
  // Opt-in, because assembling it materialises node_modules as SYMLINKS, and
  // a Windows account without Developer Mode cannot create those: leaving it
  // always on would break `pnpm build` on a dev machine to produce an
  // artifact only the container image ever consumes. The Dockerfile sets it.
  ...(process.env.NEXT_STANDALONE === 'true' && { output: 'standalone' }),
  // Tracing must start at the monorepo root or the `@mercurio/shared` dist
  // that the app imports is left out of the bundle.
  outputFileTracingRoot: join(dirname(fileURLToPath(import.meta.url)), '../..'),
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API_URL}/:path*` }];
  },
};

export default withNextIntl(nextConfig);
