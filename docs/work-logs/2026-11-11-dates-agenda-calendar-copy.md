---
type: work-log
date: 2026-11-11
status: "Deployed (53c69bb). In-app QA waits for a sign-in in the test browser. Google/Outlook need their OAuth apps registered (owner); iCloud works with an app-specific password."
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

## Checked

- Deployed with no replaced resources (`cdk diff`); `/api/calendar` answers 401 without a token; an unknown OAuth state redirects to `?calendar-error=…`.

## Open

- In-app QA of chips, picker, Agenda, Copy, deep link (needs a sign-in in the QA browser).
- Owner: register the Google (and, if wanted, Microsoft) OAuth app — [calendar-setup.md](../runbooks/calendar-setup.md); or connect iCloud from Settings.
- Two-way sync (moving an event in the calendar moves it here) is not built.
