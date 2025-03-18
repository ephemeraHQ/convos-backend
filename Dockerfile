FROM ubuntu:22.04 AS base
WORKDIR /usr/src/app

# install dependencies into temp directory
# this will cache them and speed up future builds
FROM base AS install

# install bun
RUN apt-get update && apt-get install -y curl unzip
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v1.2.2" && \
  ln -s $HOME/.bun/bin/bun /usr/local/bin/bun

RUN mkdir -p /temp/prod
COPY package.json bun.lock tsconfig.json /temp/prod/
RUN mkdir -p /temp/prod/src
COPY src /temp/prod/src
RUN mkdir -p /temp/prod/prisma
COPY prisma /temp/prod/prisma
RUN cd /temp/prod && bun install --frozen-lockfile --production

ENV NODE_ENV=production

# generate Prisma client
RUN cd /temp/prod && bun prisma generate

FROM base AS release

# install bun
RUN apt-get update && apt-get install -y curl unzip
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v1.2.2" && \
  ln -s $HOME/.bun/bin/bun /usr/local/bin/bun

# copy production dependencies and source into release image
COPY --from=install /temp/prod .

# run the app from source
ENTRYPOINT [ "bun", "start" ]
