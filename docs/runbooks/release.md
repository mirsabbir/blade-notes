---
type: runbook
date: 2026-11-12
title: "Release the desktop apps"
tags: [release, desktop, macos, windows, github]
source: docs/runbooks/release.md
---

# Release the desktop apps

Only for changes under `apps/desktop-*`: the desktop apps load the live site, so web changes need a deploy ([deploy.md](deploy.md)), not a release.

1. Everything committed on `main` and pushed; the "Desktop builds" workflow green for that commit.
2. Tag and push (versions go up: `v0.1.1`, `v0.2.0`, …):
   ```bash
   git tag -a vX.Y.Z -m "Blade Notes X.Y.Z: what changed"
   git push origin vX.Y.Z
   ```
3. `.github/workflows/release.yml` builds both apps (version from the tag, without the `v`) and publishes `BladeNotes-macOS.dmg` and `BladeNotes-Windows-x64.zip` as a GitHub Release.

## Check

- `https://api.github.com/repos/<owner>/<repo>/releases/latest` answers the new tag: the apps' updater reads exactly that.
- Both files download; the DMG verifies (`hdiutil verify`) and its app's `CFBundleShortVersionString` is the new version.

Installed apps offer the update within six hours, or at once from Settings › About & updates.
