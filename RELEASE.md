# Release Process

## Development

- Default branch: `otr-dev`
- PRs merged to `otr-dev` trigger automatic backend deployment via workflow

## Testnet

- Merge `otr-dev` into `otr-testnet` locally
- Push directly to `otr-testnet` - **deploys to testnet**
- **Always use fast-forward merge** to maintain identical commit history

```bash
git checkout otr-testnet
git merge --ff-only otr-dev
git push origin otr-testnet
```

## Production

- Merge `otr-testnet` into `otr-prod` locally after testnet verification
- Push directly to `otr-prod` - **deploys to production**
- **Always use fast-forward merge** to maintain identical commit history

```bash
git checkout otr-prod
git merge --ff-only otr-testnet
git push origin otr-prod
```

## Rules

- **Never push commits to `otr-prod` that aren't on `otr-dev`**
- **Never push commits to `otr-prod` that aren't on `otr-testnet`**
- All commits must exist on `otr-dev` first
- Production commits must pass through `otr-testnet` first
