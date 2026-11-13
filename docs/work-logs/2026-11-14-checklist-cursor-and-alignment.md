---
type: work-log
date: 2026-11-14
status: "Fixed and checked locally; not deployed yet."
title: "Checklist: cursor on empty lines, box level with the text"
tags: [editor, checklist, css, webkit]
source: docs/work-logs/2026-11-14-checklist-cursor-and-alignment.md
---

# Checklist: cursor on empty lines, box level with the text

**Asked.** In a checklist the cursor doesn't show, and the text sits a little higher than its box.

## Found

- **Cursor.** A checklist line is a flex row (box, then text), but the text column had no `flex: 1`, so it was only as wide as its text: 0 px on an empty line. Chrome still drew the cursor there; Safari, and so the macOS app (WKWebView), is where it went missing. Bullet lines never had this: their text spans the line.
- **Alignment.** The box was pushed down twice: `margin-top: 0.25em` on the label plus the browser's own 3 px checkbox margin. Chrome: box middle ~2 px below the middle of capital letters; Safari: clearly lower. The label was also taller than a text line, so checklist rows were ~4 px taller than other lines.

## Done

`apps/web/src/styles.css`: the text column takes the rest of the row (`flex: 1; min-width: 0`); the label is one text line tall (`height: 1lh`) with the box centred in it and no browser margin.

## Checked

On a local editor with the app's real CSS and extensions:

- Chrome: box middle = capital-letter middle (0 px off) on single, wrapped and nested lines; empty line's text column full width (was 0 px); rows now exactly one line tall; cursor shows on a clicked empty line and on the new line after Enter; ticking a box still works.
- Safari: box level with the text. The cursor itself could not be watched there (Safari would not come to the front during the test).
- `apps/web` build and tests pass.

Side effect, same as bullet lines already had: hovering anywhere on a checklist line now shows the "+ Description" button.

## Open

- Deploy, then check the cursor in the macOS app.
- Not changed: a checked item strikes through its unchecked children too (`li[data-checked='true'] > div` covers nested lists).
