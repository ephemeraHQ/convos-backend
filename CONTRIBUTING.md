# Contributing

Thank you for considering contributing to this repo! Community contributions like yours are key to the development and adoption of XMTP. Your questions, feedback, suggestions, and code contributions are welcome!

## ❔ Questions

Have a question about how to build with XMTP? Ask your question and learn with the community in the [XMTP Community Forums](https://community.xmtp.org/).

## 🐞 Bugs

Report a bug using [GitHub Issues](https://github.com/ephemeraHQ/convos-backend/issues).

## ✨ Feature Requests

Request a feature using [GitHub Issues](https://github.com/ephemeraHQ/convos-backend/issues).

## 🔀 Pull Requests

PRs are encouraged, but consider starting with a feature request to temperature-check first. If the PR involves a major change to the protocol, the work should be fleshed out as an [XMTP Improvement Proposal](https://community.xmtp.org/t/xip-0-xip-purpose-process-guidelines/475) before work begins.

After a pull request is submitted, a single approval is required to merge it.

## 🔧 Developing

### Prerequisites

#### Bun

See [Bun's documentation](https://bun.sh/docs/installation) for installation instructions.

### Useful commands

- `bun clean`: Removes `node_modules` folder and `*.db3*` files
- `bun dev`: Run the app in watch mode
- `bun format:check`: Run prettier format check
- `bun format`: Run prettier format and write changes
- `bun install`: Installs all dependencies
- `bun lint`: Lint with ESLint
- `bun run build`: Builds the app
- `bun start`: Run the app
- `bun typecheck`: Typecheck with `tsc`

### Testing

Please add unit tests when appropriate and ensure that all unit tests are passing before submitting a pull request. Note that some unit tests require a backend service to be running locally. The `./dev/up` script can be run a single time to start the service in the background using Docker.
