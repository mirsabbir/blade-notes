---
type: work-log
date: 2026-11-11
status: "Live on the web and in the desktop apps (v0.1.0)."
title: "Warn before closing mid-upload; save the last keystrokes on close"
tags: [sync, uploads, desktop, beforeunload]
source: docs/work-logs/2026-11-11-close-warnings.md
---

# Warn before closing mid-upload; save the last keystrokes on close

**Asked.** If the app is closed in the middle of a file upload, or while it is saving, should it not warn?

## Decided

Warn only when something would really be lost, never for changes merely waiting for the cloud (they are on the device already; a prompt on every close would train people to click through it). Table of cases: [01-data-and-sync.md › Closing the app](../architecture/01-data-and-sync.md#closing-the-app).

## Done

- `store.ts`: counts uploads and IndexedDB writes in flight; `onFlush` lets editors save pending text at once; `closeWarning()` / `uploadWarning()`.
- Web: `beforeunload` prompt when busy; pending text saved when the page hides; header shows "Uploading a file…".
- macOS: `applicationShouldTerminate` asks the page (`window.__bladeBusy()`), offers Keep Open / Quit Anyway mid-upload, waits 0.4 s for the last save.
- Windows: `FormClosing` does the same (never on Windows shutdown).

## Checked

- Unit tests: flush on close; warning while an upload is in flight, none after (`close.test.ts`).
- Both desktop apps compile (`swift build`, `dotnet build`).
- Live: the hook exists; an idle app closes without a prompt.

## Open

Nothing.
