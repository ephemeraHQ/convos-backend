# Convos Backend

This is the official repository for Convos backend service.

## Contributing

See our [contribution guide](./CONTRIBUTING.md) to learn more about contributing to this project.

## 🔧 Developing

### Prerequisites

#### Bun

See [Bun's documentation](https://bun.sh/docs/installation) for installation instructions.

#### Docker

See [Docker's documentation](https://docs.docker.com/get-docker/) for installation instructions.

> [!NOTE]
> If you're on a Mac, you can also use [OrbStack](https://orbstack.dev/) to run Docker containers.

### Get started

#### Setup environment

Copy `.env.example` to `.env`. The example file contains a `DATABASE_URL` value that you can use to connect to a local Postgres DB.

#### Run the app

To run the app locally, use the following commands:

```bash
# Run local Docker container
./dev/up

# Install dependencies
bun install

# Apply migrations to the local database
bun migrate:dev

# Run the app in watch mode
bun dev
```

### Useful commands

- `bun clean`: Removes `node_modules` folder and `*.db3*` files
- `bun dev`: Run the app in watch mode
- `bun format:check`: Run prettier format check
- `bun format`: Run prettier format and write changes
- `bun install`: Installs all dependencies
- `bun lint`: Lint with ESLint
- `bun migrate:dev`: Create a Prisma migration from changes in the Prisma schema, apply to the database, and generate Prisma client code
- `bun migrate:deploy`: Apply pending migrations to the database
- `bun run build`: Builds the app
- `bun start`: Run the app
- `bun test`: Run tests
- `bun typecheck`: Typecheck with `tsc`
