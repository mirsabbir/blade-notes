---
type: architecture
date: 2026-11-11
title: "Copy and paste: chips, secrets and the Copy button"
tags: [editor, clipboard, copy, markdown]
source: docs/architecture/06-copy-and-paste.md
---

# Copy and paste: chips, secrets and the Copy button

Custom pieces in the editor (date chips, secrets) must survive leaving it.

**Code:** `apps/web/src/copy.ts` (Copy button, plain-text copies), `apps/web/src/clipboard.ts`, `apps/web/src/schedule.ts` (`claim`), `apps/web/src/secret.ts`. Tests: `schedule.test.ts`.

| Piece | Plain-text copy | Rich copy (HTML) | Pasted back into Blade Notes |
|---|---|---|---|
| Date chip | `Sun 15 Nov 2026, 10:00` | `<time datetime="…" data-event="…">` with those words | a chip again: same event if cut and pasted in the same note, else a new event on that date |
| Secret | `••••••` | `<span data-secret data-data="v1:…">••••••</span>` | the secret again (ciphertext) |

Paste rule in `schedule.ts` (`claim`): deleting one pasted copy never deletes another; a cross-note cut becomes a new event (the old one is trashed when its note saves).

Plain-text copies of a selection (⌘C) go through the editor's `clipboardTextSerializer`, which writes the same Markdown as the Copy button (`contentToText` in `copy.ts`): lists as `- `, one blank line between blocks. Tiptap's default put several blank lines between list items.

## Clipboard access

`clipboard.ts` writes through the `copy` event first (`document.execCommand('copy')` with our own data), which needs no permission, then falls back to the Clipboard API. Embedded web views often deny `clipboard-write` (the QA browser did), and the desktop apps are web views. Both paths need a recent click.

## Copy button

Top right of an open note or task (`copy.ts`). One click puts two formats on the clipboard:

- **HTML** for Gmail, Docs, Slack: title, details, the body (`generateHTML` with the editor's extensions), descriptions, attachment names.
- **Markdown** for the rest: `# Title`, `Path · Status · Due · Priority`, the body with dates written out, hidden descriptions as `> quote` lines under their line, secrets as dots, `Attachments: names` (files stay behind sign-in).

Tested in `apps/web/src/schedule.test.ts`.
