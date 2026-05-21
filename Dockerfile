# syntax=docker/dockerfile:1.7

# -----------------------------------------------------------------------------
# Stage 1 — deps: full install (dev + prod) so native modules (bufferutil,
# utf-8-validate, secp256k1, keccak, sharp …) compile once with build-essential
# and python3 present. release stage copies the resulting node_modules and
# prunes dev deps, avoiding a second native compile.
# -----------------------------------------------------------------------------
FROM node:24-bookworm-slim AS deps
WORKDIR /app

# build-essential + python3 — node-gyp toolchain for native pre-build.
# openssl/ca-certificates — Prisma engine + Apple JWS verifier at runtime.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential python3 \
    openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Activate pnpm via Corepack matching the `packageManager` pin in package.json.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@10.33.4 --activate

# Cache the dep graph: copy lockfile + package.json first, then install.
COPY package.json pnpm-lock.yaml .npmrc* ./
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
  pnpm install --frozen-lockfile

# -----------------------------------------------------------------------------
# Stage 2 — builder: code-gen (buf + prisma) and tsup bundle.
# -----------------------------------------------------------------------------
FROM deps AS builder
WORKDIR /app

# Copy the rest of the source. Order chosen so changes outside src/proto/prisma
# don't invalidate earlier layers.
COPY tsconfig.json tsup.config.ts vitest.config.ts ./
COPY buf.yaml buf.gen.yaml ./
COPY proto ./proto
COPY prisma ./prisma
COPY data ./data
COPY src ./src

# Generate buf protobufs + Prisma client + zod schemas (all into src/gen and
# prisma/generated). pnpm prisma generate also pulls the platform-correct
# query engine binary into node_modules.
RUN pnpm buf:generate
RUN pnpm prisma generate

# Bundle src → dist (ESM, target node24).
RUN pnpm build

# Prune devDependencies in-place. Keeps the native pre-builds intact (no
# recompile) and shrinks node_modules to prod-only for the release copy.
RUN pnpm prune --prod

# -----------------------------------------------------------------------------
# Stage 3 — release: lean runtime image. No build tools, just node + tini +
# the pre-built dist, pruned node_modules, and the runtime support files.
# -----------------------------------------------------------------------------
FROM node:24-bookworm-slim AS release
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates tini \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --system --create-home --uid 10001 appuser

ENV NODE_ENV=production

COPY --from=builder --chown=appuser:appuser /app/node_modules ./node_modules
COPY --from=builder --chown=appuser:appuser /app/package.json ./package.json
COPY --from=builder --chown=appuser:appuser /app/dist ./dist
COPY --from=builder --chown=appuser:appuser /app/prisma ./prisma
COPY --from=builder --chown=appuser:appuser /app/data ./data

COPY --chmod=0755 --chown=appuser:appuser dev/entrypoint.sh ./entrypoint.sh

USER appuser

# tini reaps zombie children — important because the node process spawns
# prisma migrate as a subprocess on boot.
ENTRYPOINT ["/usr/bin/tini", "--", "./entrypoint.sh"]
