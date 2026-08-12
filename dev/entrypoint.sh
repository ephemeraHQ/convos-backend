#!/bin/sh
set -e

# APP_DIR lets CI (scripts/preview-boot-check.sh) run this exact entrypoint
# outside the container. The container's WORKDIR is /app, so the default keeps
# image behaviour byte-identical.
APP_DIR="${APP_DIR:-/app}"
cd "$APP_DIR"

# Bounded connect-wait before migrating. Aurora Serverless v2 resumes from
# 0 ACU in ~15s (30s+ after a long pause) and `prisma migrate deploy` is
# fail-fast, so without this the first deploy of the day dies on P1001 into the
# ECS circuit breaker. Deliberately NOT PREVIEW-gated: it is a strict
# improvement in every environment and costs one `SELECT 1` when the database
# is already awake. Budget: DB_CONNECT_BUDGET_SECONDS (default 90).
node "$APP_DIR/dist/db-wait.js"

# Use the local prisma CLI directly — release image is pnpm-less.
# Stays fail-fast: a P3009 here (applied migrations missing from this branch,
# i.e. a rebased force-push) is the signal the deploy workflow's auto-reset
# path keys off, and must not be retried or swallowed.
node ./node_modules/prisma/build/index.js migrate deploy

# Preview bundles seed once, at database creation. `db seed` runs
# package.json#prisma.seed -> `node prisma/seed.ts`, which is itself guarded by
# PREVIEW=1 and by the RuntimeConfig 'preview_seeded' marker row; the shell
# guard here just keeps a pointless process spawn off the dev/prod boot path.
if [ "${PREVIEW:-}" = "1" ]; then
  node ./node_modules/prisma/build/index.js db seed
fi

exec node \
  --enable-source-maps \
  --import @opentelemetry/instrumentation/hook.mjs \
  --import "file://$APP_DIR/dist/instrumentation.js" \
  "$APP_DIR/dist/index.js"
