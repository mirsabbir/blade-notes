---
type: decision
date: 2026-11-11
status: accepted
title: "A timed date is a moment; an all-day date is a day"
---

# 0002 · A timed date is a moment; an all-day date is a day

**Context.** The owner travels; a date set for 9:00 in Dhaka must show as 8:30 when the app opens in India, and redraw without a reload.

**Decision.** Timed values are stored as an instant with the offset of the device that set them (`2026-11-12T09:00:00+06:00`) and always shown in the device's zone at render time; all-day values are a bare date shown as that day everywhere (as calendars treat them). The setting zone (`tz`) is kept for calendar APIs and to tell the user where a time was set. Every label is computed from the live clock; a clock check on each sync tick redraws when the day or zone changes.

**Rejected.** Floating wall times ("9:00 wherever I am") would make a meeting move by the time difference; storing UTC without the offset loses where it was set.
