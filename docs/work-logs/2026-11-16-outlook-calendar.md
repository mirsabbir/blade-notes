---
type: work-log
date: 2026-11-16
status: "Microsoft app registered and stored; Settings offers Outlook Connect. Not connected yet: the owner will connect later."
title: "Outlook calendar sync: Microsoft app registration"
tags: [calendar, outlook, microsoft, entra, oauth]
source: docs/work-logs/2026-11-16-outlook-calendar.md
---

# Outlook calendar sync: Microsoft app registration

**Asked.** After Google ([2026-11-15](2026-11-15-google-calendar.md)): set up Outlook the same way.

## Done

- App "Blade Notes calendar" registered through Graph in the owner's personal Entra tenant: personal and work accounts, token version 2, the calendar callback as redirect, delegated `openid`, `email`, `offline_access`, `Calendars.ReadWrite`. Steps: [calendar-setup](../runbooks/calendar-setup.md#microsoft-outlook).
- Client secret made with a 24-month end date and piped straight into SSM `/blade-notes/microsoft-oauth`; never printed.
- The personal tenant's az sign-in had expired after 90 days unused; signed in again in a throwaway az profile, deleted afterwards, so the everyday az login was never switched.

## Checked

| Check | Result |
|---|---|
| App as Graph returns it | Audience, redirect, token version 2, the four scope ids, one secret ending 2028-11-16 |
| SSM value | Client id matches the app; secret present (40 characters); read without printing |
| Settings › Calendars | Outlook shows Connect (no longer "Not available yet") |

## Open

- **Client secret expires 2028-11-16.** Renew before then (runbook).
- Owner: connect Outlook when wanted (Settings › Calendars › Outlook › Connect). A first attempt never reached the server (no connect call in the calendar log); the owner chose to connect later. After connecting, run the same test as Google: a test space set to Outlook, `@tomorrow 9am`, event appears, trash removes it.
