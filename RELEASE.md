# Releasing convos-backend

## Dev (automatic)

Merging a PR to `otr-dev` runs the quality gate, and on green builds the image
and deploys it to the dev environment (Terraform Cloud workspace
`convos-otr-dev`). A red gate blocks the deploy. Nothing else is required.

Every dev build is pushed to GHCR tagged `sha-<gitsha>` (immutable), `latest`
(moves with `otr-dev`), and by digest. PR builds are tagged `pr-<n>`.

## Production (reviewed, manual)

Production is a manual promotion of an already-tested image — not a branch push.
Both ways below promote an image that already passed the gate (on its PR or on
`otr-dev`), and both park on the `otr-prod` Environment reviewer gate: a required
reviewer approves (or rejects — nothing rolls on reject), and on approval the
image's digest is written to Terraform Cloud workspace `convos-otr-prod` and the
ECS service rolls. Prod deliberately may lag dev.

### A. Tag release (versioned — preferred)

Tag a commit that is already on `otr-dev`, and push the tag:

    git tag v1.4.0 <sha-on-otr-dev>
    git push origin v1.4.0

The workflow deploys the image built for that commit. The `vX.Y.Z` tag is the
release name and the audit trail of what shipped. The tagged commit must already
have been built on `otr-dev` (otherwise the run fails closed, "could not
resolve"). Never re-point a released tag — cut a new version.

### B. Dispatch (ad-hoc / rollback)

Promote any pre-gated image directly, without cutting a version tag:

    gh workflow run deploy-aws.yml -f image=pr-387

`image` accepts a `pr-<n>` tag, `latest`, a `sha-<full-sha>` tag, or a full
`...@sha256:...` digest. Use this to roll back to an older image or ship a
specific PR build.

There is no `otr-prod` branch; "what is live in prod" is the `otr-prod`
Environment deployment history plus the `convos-otr-prod` `api_image` value.
