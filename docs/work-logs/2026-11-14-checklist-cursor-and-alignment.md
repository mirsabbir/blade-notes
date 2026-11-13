---
type: work-log
date: 2026-11-14
status: "Live (7af1fab, 1a602f1). Cursor in the macOS app still to be checked by the owner."
title: "Checklist: cursor on empty lines, box level with the text, sub-items not crossed out"
tags: [editor, checklist, css, webkit]
source: docs/work-logs/2026-11-14-checklist-cursor-and-alignment.md
---

# Checklist: cursor on empty lines, box level with the text, sub-items not crossed out

**Asked.** In a checklist the cursor doesn't show, and the text sits a little higher than its box.

## Found

- **Cursor.** A checklist line is a flex row (box, then text), but the text column had no `flex: 1`, so it was only as wide as its text: 0 px on an empty line. Chrome still drew the cursor there; Safari, and so the macOS app (WKWebView), is where it went missing. Bullet lines never had this: their text spans the line.
- **Alignment.** The box was pushed down twice: `margin-top: 0.25em` on the label plus the browser's own 3 px checkbox margin. Chrome: box middle ~2 px below the middle of capital letters; Safari: clearly lower. The label was also taller than a text line, so checklist rows were ~4 px taller than other lines.

## Done

`apps/web/src/styles.css`: the text column takes the rest of the row (`flex: 1; min-width: 0`); the label is one text line tall (`height: 1lh`) with the box centred in it and no browser margin. Commit `7af1fab`, deployed 2026-11-14 (`cdk diff`: only the site's files changed).

Then, on request: a ticked item crossed out its unticked sub-items too, because the line-through sat on the whole text column, nested lists included (a line-through can't be undone by a child). It now covers only the item's own blocks (`> div > :not(ul, ol)`). Commit `1a602f1`, deployed the same day.

## Checked

On a local editor with the app's real CSS and extensions:

- Chrome: box middle = capital-letter middle (0 px off) on single, wrapped and nested lines; empty line's text column full width (was 0 px); rows now exactly one line tall; cursor shows on a clicked empty line and on the new line after Enter; ticking a box still works.
- Safari: box level with the text. The cursor itself could not be watched there (Safari would not come to the front during the test).
- All tests and typecheck pass.
- After the deploy, the live stylesheet carries the three new rules; HSTS and CSP headers still answer.
- Sub-items (Chrome, on screen): under a ticked item, unticked children and grandchildren read normally and ticked ones are crossed out; a ticked child under an unticked parent is crossed out; ticking a sub-item updates at once. The live stylesheet carries the new rule after the second deploy.

Side effect, same as bullet lines already had: hovering anywhere on a checklist line now shows the "+ Description" button.

## Open

- Owner: reload the macOS app (⌘R) and check the cursor on an empty checklist line.
