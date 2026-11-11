---
type: work-log
date: 2026-11-11
status: "Released. Installed apps from now on update themselves from GitHub Releases."
title: "First desktop release: v0.1.0"
tags: [release, desktop, macos, windows]
source: docs/work-logs/2026-11-11-desktop-release-v0.1.0.md
---

# First desktop release: v0.1.0

**Asked.** Push everything and make the release.

## Done

- Tag `v0.1.0` on `7e8c307` (main, everything from today included) → `release.yml` built both apps through `desktop.yml` and published [the release](https://github.com/mirsabbir/blade-notes/releases/tag/v0.1.0).

| File | Size |
|---|---|
| `BladeNotes-macOS.dmg` | 145 KB (a native window around the site) |
| `BladeNotes-Windows-x64.zip` | 75 MB (self-contained .NET 8) |

## Checked

- GitHub `releases/latest` answers `v0.1.0`, which is what the apps' updater reads; both download links answer 200.
- The DMG verifies (`hdiutil verify`), holds `Blade Notes.app` and an Applications link, version `0.1.0`.

## Next time

Steps: [release.md](../runbooks/release.md).
