---
type: decision
date: 2026-11-15
status: accepted
title: "0005 · One delete is one moment; restore never brings back a sibling"
tags: [trash, data-model]
source: docs/decisions/0005-trash-moments-and-no-siblings.md
---

# 0005 · One delete is one moment; restore never brings back a sibling

**Context.** The trash must know what one delete took, so it can restore exactly that, with items nested at any depth (space, folders, notes, attachments) and things deleted at different times inside each other. The owner's rule: no sibling is ever deleted or brought back by someone else's restore.

**Decision.** Everything one delete takes shares one `deletedAt`. Restoring a trash line brings back that moment's items under it. A place above that is in the trash comes back with only its own text (descriptions, dates); its other contents stay in the trash as their own lines. Something whose place is in the trash cannot come back without that place. Deleted for good leaves a tombstone that wins over any later write. 30 days, fixed.

| Option | Why not |
|---|---|
| A `trashBatch` id per delete | Same information as the shared moment, one more field to keep in step |
| Restoring a place brings its whole delete back | Brings back siblings of what was restored: against the owner's rule |
| Restore into another place when the old one is in the trash | More choices and code; not needed now |
| Remove records from the table when deleted for good | Devices that missed it would keep or re-upload their copy |

**Trade-offs.** Restoring something from deep inside a deleted folder can leave several trash lines (its former siblings), each to restore on its own. Two separate deletes in the same millisecond would count as one. Tombstones stay in the table (a few hundred bytes each).
