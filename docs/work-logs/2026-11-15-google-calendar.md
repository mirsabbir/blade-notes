---
type: work-log
date: 2026-11-15
status: "LIVE 2026-11-15. Google Calendar connected and checked end to end."
title: "Google Calendar sync: OAuth app, privacy page, first sync"
tags: [calendar, google, oauth, privacy]
source: docs/work-logs/2026-11-15-google-calendar.md
---

# Google Calendar sync: OAuth app, privacy page, first sync

**Asked.** What it takes to connect Google and Outlook calendars, then: set up Google.

## Done

- Google Cloud project with the Calendar API, Google Auth Platform (External, **In production**), one web client; steps now in [calendar-setup](../runbooks/calendar-setup.md#google).
- `apps/web/public/privacy.html`: Google will not publish an app without a privacy policy link. Every claim was checked against the code (closed sign-up, KMS encryption, sealed calendar tokens revoked on disconnect, Secret blocks never sent, no analytics). The owner approved the text.
- Client id and secret stored in SSM `/blade-notes/google-oauth` through a hidden terminal prompt; the secret never reached chat, history or a screenshot.
- The first attempt ran in another of the owner's Google accounts. Cleaned up: the unsaved consent form discarded, that project shut down (Google deletes it after 2026-12-15). Its terms acceptance stays.

## Checked

| Check | Result |
|---|---|
| Scopes `openid`, `userinfo.email`, `calendar.app.created` | Google lists all three as non-sensitive: no verification, no warning |
| Settings › Calendars after storing the secret | Connect offered at once (no 5-minute wait) |
| Owner connects | "Connected as" the owner's Gmail |
| Test space set to Google, note with `@tomorrow 9am` | Event "Google sync test", 09:00–09:30, in the new **Blade Notes** calendar; calendar Lambda logged no error |
| Test space to the trash | Event gone from Google Calendar within seconds |

## Open

- Owner: choose which spaces write to Google (Settings › Calendars: "Use for all" or by space). Today no space does.
- Outlook: app registered 2026-11-16 ([log](2026-11-16-outlook-calendar.md)).
- Test space "Calendar test" is in the trash; purged with the rest after 30 days.
