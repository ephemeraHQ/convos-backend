# Release Process

## Development
- Default branch: `otr-dev`
- PRs merged to `otr-dev` trigger automatic backend deployment via workflow

## Production
- Merge `otr-dev` into `otr-prod` locally
- Push directly to `otr-prod` - **deploys to production**
- **Always use fast-forward merge** to maintain identical commit history

```bash
git checkout otr-prod
git merge --ff-only otr-dev
git push origin otr-prod
```

## Rules
- **Never push commits to `otr-prod` that aren't on `otr-dev`**
- All commits must exist on `otr-dev` first
