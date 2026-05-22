#!/bin/sh
set -e

# Use the local prisma CLI directly — release image is pnpm-less.
node ./node_modules/prisma/build/index.js migrate deploy

exec node \
  --enable-source-maps \
  --import @opentelemetry/instrumentation/hook.mjs \
  --import file:///app/dist/instrumentation.js \
  /app/dist/index.js
