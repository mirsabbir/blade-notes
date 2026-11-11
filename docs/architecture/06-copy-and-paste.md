---
type: architecture
date: 2026-11-11
title: "Copy and paste: chips, secrets and the Copy button"
tags: [editor, clipboard, copy, markdown]
---

# Copy and paste

Custom pieces in the editor (date chips, secrets) must survive leaving it.

| Piece | Plain-text copy | Rich copy (HTML) | Pasted back into Blade Notes |
|---|---|---|---|
| Date chip | `Sun 15 Nov 2026, 10:00` | `<time datetime="…" data-event="…">` with those words | a chip again: same event if cut and pasted in the same note, else a new event on that date |
| Secret | `••••••` | `<span data-secret data-data="v1:…">••••••</span>` | the secret again (ciphertext) |

Paste rule in `schedule.ts` (`claim`): deleting one pasted copy never deletes another; a cross-note cut becomes a new event (the old one is trashed when its note saves).

## Copy button

Top right of an open note or task (`copy.ts`). One click puts two formats on the clipboard:

- **HTML** for Gmail, Docs, Slack: title, details, the body (`generateHTML` with the editor's extensions), descriptions, attachment names.
- **Markdown** for the rest: `# Title`, `Path · Status · Due · Priority`, the body with dates written out, hidden descriptions as `> quote` lines under their line, secrets as dots, `Attachments: names` (files stay behind sign-in).

Tested in `apps/web/src/schedule.test.ts`.
