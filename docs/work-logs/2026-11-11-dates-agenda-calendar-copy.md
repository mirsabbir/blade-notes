---
type: work-log
date: 2026-11-11
status: "Live and checked in the app. Google/Outlook sync waits for their OAuth apps (owner, runbook); iCloud can be connected now."
title: "Dates while writing (@), Agenda, calendar sync, time zones, Copy"
tags: [dates, agenda, calendar, time-zones, copy, editor]
---

# Dates while writing, Agenda, calendar sync, Copy

**Asked.** While writing a task's description, put a date on any line on the fly (an easy gesture, not breaking emails); see what to do when, grouped by space, and jump to the line; sync to the calendar as events; copying text with dates must not break; a Copy button on tasks. Later the same day: the owner travels, so a time set in Dhaka must show 30 minutes earlier when the app opens in India, and redraw after the next sync without a reload.

Design canvas (5 boards) → [design/](../design/).

## Decided

| Topic | Choice | Record |
|---|---|---|
| Gesture | `@` at the start of a word | [0001](../decisions/0001-at-sign-for-dates.md) |
| Time zones | timed = moment shown in the current zone; all day = day | [0002](../decisions/0002-timed-dates-are-moments.md) |
| Model | chip in the text links to a hidden `event` item (same pattern as descriptions) | [03](../architecture/03-dates-and-agenda.md) |
| Calendar | one-way, into a "Blade Notes" calendar per account; Google scope limited to calendars the app makes | [04](../architecture/04-calendar-sync.md) |
| Paste | cut+paste in one note keeps the event; any other paste makes a new one | [06](../architecture/06-copy-and-paste.md) |

## Done

- Core: `when.ts` (stamp, local day/time, zone), event fields on `Item`, `CalendarStatus`.
- Web: `schedule.ts` (chip node, @ plugin, paste rule), `DatePicker.tsx` (suggestions + month, chip popup), `dates.ts` (parser, labels), `Agenda.tsx`, `copy.ts`, store `createEvent`/`reconcileEvents`/`checkClock`, Library Agenda row (replaces "Due today or late"), deep link `/t/<id>#<event>`, Settings › Calendars connect, Settings › How to.
- `services/calendar`: routes + stream worker, Google/Graph/CalDAV adapters.
- Tests: core 20, web 14, calendar 32, api 14 (all green). Zone tests switch `TZ` between Dhaka, Kolkata, New York, Honolulu and Berlin (DST).

## Checked (live, signed in, throwaway "QA test" space, trashed afterwards)

| Check | Result |
|---|---|
| `@sun 3pm` + Enter | picker "Sunday, 15 Nov · This Sunday · 15:00"; chip "Sun 15 Nov · 15:00"; event stored `…T15:00:00+06:00`, `tz` Asia/Dhaka |
| `@tom` | all-day chip "Tomorrow" |
| `mir@gmail.com` | no picker |
| `@team` + Esc | stays text, picker closed |
| Chip popup | time 09:30 and +1 day reach chip and item; done/undone; private toggle; Esc closes |
| Agenda | by space and by day; row opens the task and the chip flashes; ticking done strikes the chip |
| `/t/<task>#<event>` | opens the task, URL cleaned, chip flashes ~0.6 s after load |
| ⌘C of a line with a chip | plain text has "Mon 16 Nov 2026, 09:30", HTML has `<time data-event>`; pasting back makes a new event id on the same date |
| Copy button | Markdown + HTML on the clipboard, dates written out, secret as dots |
| Calendar worker | 10 invocations during QA, no errors; nothing written (no calendar connected) |
| `/api/calendar` | Google and Outlook "not registered yet", Apple ready |

Found and fixed during QA:

- **New space did not open** (old bug): opening read the item list from before the space existed. Now reads the latest state.
- **Agenda opened after the folder column**: now right after the Library, where its button is.
- **Copy button failed in web views that deny the clipboard API**: copies through the copy event first (`clipboard.ts`); also used by secrets and the recovery key.
- **Plain-text copies had stacks of blank lines** (Tiptap default): now the same Markdown as the Copy button.
- **`@sun 3p` hid the picker until the `m`**: `3p` / `9a` count.
- Calendar status said "the sign-in app is not registered": now "Blade Notes is not registered with Google".
- Chip popup widened so its buttons stay on one line; the Secret button left the toolbar (it needs selected text; it stays on the selection bubble).
- Images were missing from copied Markdown.

Not testable here: switching the device's time zone (unit tests cover Dhaka → Kolkata → New York → Honolulu → Berlin DST); connecting a real calendar.

## Open

- Owner: register the Google (and, if wanted, Microsoft) OAuth app — [calendar-setup.md](../runbooks/calendar-setup.md); or connect iCloud from Settings.
- Two-way sync (moving an event in the calendar moves it here) is not built.
