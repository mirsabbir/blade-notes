---
type: decision
date: 2026-11-11
status: accepted
title: "@ at the start of a word opens the date picker"
---

# 0001 · `@` at the start of a word opens the date picker

**Decision.** Typing `@` after a space or at the start of a line opens the date picker anywhere in the editor.

| Option | Problem |
|---|---|
| `@` at word start | none found: an email's `@` follows a letter |
| `#` | `# ` at a line start is already Heading 1, and `#` is wanted for tags later |
| `//` | every link has `https://`; code has `//` comments |
| `!` | ends sentences, would open constantly |

Also: the picker hides when the text after `@` has a space and reads as no date, so `@name is here` stays text without Esc.
