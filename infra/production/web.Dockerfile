# syntax=docker/dockerfile:1
#
# @mercurio/web production image (ADR-024 §1). Build from the REPO ROOT:
#   docker build -f infra/production/web.Dockerfile .
# Same reason as the API image: @mercurio/shared resolves through its dist/.

FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

FROM base AS builder
WORKDIR /repo

# package.json comes along only for its `packageManager` field: without it
# corepack would pick its own bundled pnpm instead of the version CI uses.
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch

COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile --offline

# NEXT_STANDALONE asks next.config.mjs for the self-contained server bundle;
# it is opt-in so that a plain `pnpm build` on a dev machine is unaffected.
#
# No API_URL is passed here on purpose. Next bakes `rewrites()` into the build,
# so any value would freeze one deployment's API address into the image; in
# production the reverse proxy owns the `/api/*` hop instead (ADR-024 §4) and
# the rewrite is never exercised. What the server DOES read at runtime —
# API_URL for server-rendered pages — comes from the environment below.
RUN NEXT_STANDALONE=true pnpm --filter "@mercurio/web..." build

FROM base AS runtime
ENV NODE_ENV=production
# Next's standalone server binds 127.0.0.1 by default, which nothing outside
# the container could reach.
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

WORKDIR /app
# `output: 'standalone'` traces the exact files the server needs and emits a
# tree rooted at the monorepo root (outputFileTracingRoot), hence the
# apps/web/ prefix. Static assets and the public/ folder are deliberately NOT
# traced by Next and get copied separately — this app has no public/ yet.
COPY --from=builder --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=builder --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/web/server.js"]
