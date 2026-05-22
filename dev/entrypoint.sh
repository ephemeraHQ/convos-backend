#!/bin/sh
set -e

# Use the local prisma CLI directly — release image is pnpm-less.
node ./node_modules/prisma/build/index.js migrate deploy

# No --env-file flag: container env is supplied by the runtime (ECS task
# definition, docker run -e, etc). We never bake a .env into the image, so
# --env-file-if-exists=.env would only ever print "not found" noise.
exec node \
  --enable-source-maps \
  --import @opentelemetry/instrumentation/hook.mjs \
  --import file:///app/dist/instrumentation.js \
  /app/dist/index.js
