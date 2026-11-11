---
type: runbook
date: 2026-11-11
title: "Deploy and check"
tags: [deploy, cdk, aws]
---

# Deploy

```bash
pnpm install
pnpm test && pnpm typecheck
cd infra && AWS_PROFILE=<profile> npx cdk diff     # read it: nothing should be replaced or destroyed
cd .. && AWS_PROFILE=<profile> pnpm deploy         # builds apps/web, then cdk deploy
```

Settings come from `.env` (git-ignored; see `.env.example`). Never deploy from a shell signed in to another account: check `aws sts get-caller-identity --profile <profile>` first.

## After a deploy

1. Open the site, sign in, open a note: images load, Settings opens, Saved shows.
2. Response headers on `/` include `strict-transport-security` and `content-security-policy`; the browser console shows no CSP errors.
3. `GET /api/files/...` without a token answers 401.
4. With `NOTES_ALERT_EMAIL` set for the first time: confirm the "AWS Notification - Subscription Confirmation" email, or no alert arrives.

The desktop apps load the live site, so they need no release for web changes.
