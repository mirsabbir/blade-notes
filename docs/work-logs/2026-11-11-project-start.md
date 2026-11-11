---
type: work-log
date: 2026-11-11
status: "Live. Web app, sync API, AWS stack; desktop apps released as v0.1.0 the same evening."
title: "Blade Notes: first day, from nothing to a live app"
tags: [history, web, sync, cdk, desktop, descriptions, attachments]
source: docs/work-logs/2026-11-11-project-start.md
---

# Blade Notes: first day, from nothing to a live app

**Asked.** A personal notes app built around blades (each folder opens a column to the right), open source, on the owner's own AWS, because no existing app fit.

## Done (in order)

| Commit | What |
|---|---|
| `bd106b9` | Web app (React, Vite, Tiptap), offline store in IndexedDB, sync API (one Lambda, one DynamoDB table, `seq` counter), CDK stack (S3 + CloudFront, API Gateway, Cognito with sign-up off, Route 53) |
| `c18e295` | Desktop apps: macOS (Swift/WebKit, Apple Silicon) and Windows (.NET 8/WebView2), self-update from GitHub Releases |
| `b6cef2f` | Settings (blades open, calendar per space, spaces' colours); attachments up to 50 MB through presigned S3 POST |
| `0acb35e` | Sync every 10 s while visible and on focus, so deletes on another device show quickly |
| `841277b` | Hidden descriptions behind list items and phrases (side blade, window or popup); desktop builds on every push |
| `9d00b46` | Fixed lost edits while a push was in flight (per-record edit counter); size limits in UTF-8 bytes, oversized records shown and set aside instead of a failing sync loop |
| `3fdee58` | Description header names its note |

## Decided

- One public monorepo (`apps/`, `packages/`, `services/`, `infra/`); deployment values only in a git-ignored `.env`.
- Single user per account; data partitioned by Cognito `sub`.

## Open

- ~~Push the first desktop release tag~~: done, [2026-11-11-desktop-release-v0.1.0.md](2026-11-11-desktop-release-v0.1.0.md).
- Mobile (Expo) and AI features, later.

Architecture: [01-data-and-sync.md](../architecture/01-data-and-sync.md).
