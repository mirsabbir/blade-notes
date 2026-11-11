---
type: reference
date: 2026-11-12
title: "Glossary"
tags: [glossary]
source: docs/glossary.md
---

# Glossary

Words used across the app, the code and these docs. Alphabetical; add a term the first time it would have made a page clearer.

| Term | Meaning |
|---|---|
| **Agenda** | Blade opened from the Library that lists every open date: date chips' events and task due dates, by space or by day. `apps/web/src/Agenda.tsx`, [03](architecture/03-dates-and-agenda.md). |
| **All-day date** | A date stored as `YYYY-MM-DD`: the same calendar day in every time zone. Compare *timed date*. |
| **Blade** | One column of the layout. Clicking a space or folder opens a blade to the right; older ones fold into *strips*. |
| **Body** | The rich text (Tiptap JSON) of a note, task or description, stored apart from its item (`BODY#<id>`) so listing a folder never loads text. |
| **Chip (date chip)** | The date shown inside a line of text, made by typing `@`. A `dateChip` node `{ id, at }` that links to an *event*. |
| **Cursor** | The highest `seq` a device has pulled; the next pull asks for everything after it. |
| **Description** | Hidden text (with its own files) behind a list item or a phrase; an item of type `description` whose parent is the note or task. |
| **Event** | An item of type `event`: one date typed with `@`, with `at`, `tz`, `status`, `private`. The chip in the text points to it. |
| **Focus** | Button that folds every blade so the open note has the whole window. |
| **Item** | Anything in the tree: space, folder, note, task, description, event (`packages/core/src/types.ts`). |
| **KMS key** | The app's own AWS key, `alias/blade-notes`, that encrypts the table, files, logs and calendar sign-ins. [02](architecture/02-security.md). |
| **Library** | The first blade: search, Agenda, spaces. |
| **Owner** | The one person who signs in to a deployment (sign-up is off). [runbooks/owner-setup.md](runbooks/owner-setup.md) lists what only they can do. |
| **Pending** | Records changed on a device that the server has not accepted yet. Safe on the device; pushed on the next sync. |
| **Recovery key** | Shown once when the vault is made; opens the vault if the passphrase is forgotten. |
| **Rejected** | Pending records the server refuses (too large); shown in the header with the reason, retried after the next edit. |
| **Secret block** | A password or PIN inside a note, encrypted in the browser by the *vault*. Shown as dots. [05](architecture/05-secret-blocks.md). |
| **seq** | The account-wide write counter; every stored record gets the next number. Sync is "give me everything after seq N". |
| **Space** | A top-level item (Personal, Work, …) with a colour and its own calendar choice. |
| **Strip** | A folded blade: a thin vertical bar with its title; click to open it again. |
| **Timed date** | A date with a time, stored as one moment with the offset where it was set (`2026-11-15T09:00:00+06:00`) and shown in the zone the device is in now. |
| **Vault** | The passphrase-protected key that encrypts Secret blocks; only its wrapped form is stored (`Settings.vault`). |
| **Work log** | One page per topic per day in `work-logs/`: what was asked, decided, done and checked. |
