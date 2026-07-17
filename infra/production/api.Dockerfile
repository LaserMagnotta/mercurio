# syntax=docker/dockerfile:1
#
# @mercurio/api production image (ADR-024 §1). Build from the REPO ROOT:
#   docker build -f infra/production/api.Dockerfile .
# The context is the whole monorepo on purpose: the workspace packages resolve
# each other through `main: ./dist/index.js`, so the API cannot be built from
# apps/api alone — @mercurio/{shared,core,db,escrow} must be compiled first.

FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
# Corepack pins pnpm to the `packageManager` field of package.json — one
# version for CI, the host and this image, with no third place to update.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

FROM base AS builder
WORKDIR /repo

# `pnpm fetch` populates the store from the lockfile ALONE, so this layer (the
# slow one) is reused across every source-only change. package.json comes with
# it only for its `packageManager` field: without it corepack would silently
# pick its own bundled pnpm instead of the version CI and the lockfile use.
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch

COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile --offline

# `@mercurio/api...` is pnpm for "the API and the workspace packages it
# depends on", built in topological order — the web app is not built here.
RUN pnpm --filter "@mercurio/api..." build

# `pnpm deploy` resolves the workspace links into a self-contained tree with
# production dependencies only: no source, no toolchain, nothing to prune by
# hand. It copies each workspace package as it is on disk, which is why it
# runs after the build (the dist/ folders must already exist) and why it
# carries packages/db's drizzle/*.sql along for the migration step.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm deploy --filter=@mercurio/api --prod /app

FROM base AS runtime
ENV NODE_ENV=production
# Photos land on a volume mounted here (ADR-020 fs driver, the default).
# Created in the image and owned by `node` so that Docker seeds the volume
# with that ownership on first run — otherwise it would be root-owned and the
# unprivileged process could not write a single blob.
ENV PHOTO_STORAGE_DIR=/var/lib/mercurio/photos
RUN mkdir -p "$PHOTO_STORAGE_DIR" && chown -R node:node /var/lib/mercurio

WORKDIR /app
COPY --from=builder --chown=node:node /app .

USER node
EXPOSE 3001

# Liveness only: it answers from the HTTP layer without touching Postgres, so
# a database blip never makes the orchestrator kill an API that is fine.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
