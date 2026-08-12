![Status](https://img.shields.io/badge/Deprecated-brown)

> [!CAUTION]
> This repo is no longer maintained.

Convos backend development has moved.

The documentation below is provided for historical reference only.

# Convos Backend

This is the official repository for Convos backend service.

## Contributing

See our [contribution guide](./CONTRIBUTING.md) to learn more about contributing to this project.

## 🔧 Developing

### Prerequisites

#### Node.js 24 + pnpm

Use [nvm](https://github.com/nvm-sh/nvm) (or any Node version manager) and pick
the version in `.nvmrc`:

```bash
nvm install
nvm use
```

pnpm is provisioned via [Corepack](https://nodejs.org/api/corepack.html) — the
version is pinned in `package.json#packageManager`:

```bash
corepack enable
corepack prepare pnpm@10.33.4 --activate
```

#### Docker

See [Docker's documentation](https://docs.docker.com/get-docker/) for installation instructions.

> [!NOTE]
> If you're on a Mac, you can also use [OrbStack](https://orbstack.dev/) to run Docker containers.

### Get started

#### Setup environment

Copy `.env.example` to `.env`. Every var tagged `# REQUIRED` in `.env.example`
must be set or the server will refuse to start.

For secure communication with the XMTP notification server, generate a secret:

```bash
pnpm generate:notification-secret
```

Add the generated value to your `.env` file.

For JWT authentication, generate an ECDSA P-256 key pair:

```bash
pnpm tsx dev/scripts/generateEcdsaKeys.ts
```

Add the `JWT_PRIVATE_KEY` to your backend `.env` file and share the `JWT_PUBLIC_KEY` with the gateway service.

#### Run the app locally

```bash
# Bring up the dev compose stack (Postgres + XMTP node + notification server)
./dev/up

# Install dependencies
pnpm install

# Apply migrations to the local database
pnpm migrate:deploy

# Generate Prisma client + zod schemas + protobufs
pnpm prisma:generate
pnpm buf:generate

# Run the app in watch mode
pnpm dev
```

#### Run the app locally with Docker

```bash
# Bring up the dev compose stack (Postgres + XMTP node + notification server)
./dev/up

# Build the Docker image
docker build -t "convos-api-service" .

# Run the Docker container
docker run --env-file .env -d -p 4000:4000 convos-api-service
```

Adjust the `-p 4000:4000` flag to match the port in the `.env` file. The default port is `4000`.

### Useful commands

- `pnpm clean`: Removes `node_modules` folder
- `pnpm dev`: Run the app in watch mode
- `pnpm eval:models`: Bake off generation models for agent-prompt quality, scored on Braintrust (see [`tests/evals/README.md`](tests/evals/README.md))
- `pnpm eval:prompt`: Compare the working-tree generator prompt against the default branch (prompt regression)
- `pnpm format:check`: Run prettier format check
- `pnpm format`: Run prettier format and write changes
- `pnpm generate:key`: Generate a key for XMTP database encryption
- `pnpm generate:notification-secret`: Generate a secure token for XMTP notification authentication
- `pnpm tsx dev/scripts/generateEcdsaKeys.ts`: Generate ECDSA P-256 key pair for JWT authentication
- `pnpm install`: Installs all dependencies
- `pnpm lint`: Lint with ESLint
- `pnpm migrate:dev`: Create a Prisma migration from changes in the Prisma schema, apply to the database, and generate Prisma client code
- `pnpm migrate:deploy`: Apply pending migrations to the database
- `pnpm build`: Builds the app
- `pnpm start`: Run the built app
- `pnpm test`: Run tests
- `pnpm typecheck`: Typecheck with `tsc`
- `pnpm check`: Run typecheck + format:check + lint together (CI gate)
