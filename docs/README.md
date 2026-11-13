---
type: reference
date: 2026-11-12
title: "Blade Notes docs"
tags: [docs]
source: docs/README.md
---

# Blade Notes docs

How Blade Notes works, how to run it, why it is built this way, and what was done when. Written for a person reading cold and for an AI agent acting on it: plain answer first, then exact files, commands and links. Nothing here is built or deployed; the site ships only `apps/web`.

| Start here if you are… | Read |
|---|---|
| The owner, after a deploy | [runbooks/owner-setup.md](runbooks/owner-setup.md): what only you can do |
| An agent about to change code | [../AGENTS.md](../AGENTS.md), then the architecture page of the area |
| Writing or updating a doc | [CONTRIBUTING.md](CONTRIBUTING.md) and [templates/](templates/) |
| Unsure what a word means | [glossary.md](glossary.md) |

## Architecture: how it works

| # | Page |
|---|---|
| [01](architecture/01-data-and-sync.md) | Data model, storage and sync |
| [02](architecture/02-security.md) | Security: at rest, in transit, sign-in and Secret blocks |
| [03](architecture/03-dates-and-agenda.md) | Dates typed with @, events and the Agenda |
| [04](architecture/04-calendar-sync.md) | Calendar sync: Google, Outlook, iCloud |
| [05](architecture/05-secret-blocks.md) | Secret blocks and the vault |
| [06](architecture/06-copy-and-paste.md) | Copy and paste: chips, secrets and the Copy button |

## Runbooks: how to do it

| Runbook | Covers |
|---|---|
| [calendar-setup](runbooks/calendar-setup.md) | Set up calendar sign-in (Google, Microsoft, iCloud) |
| [deploy](runbooks/deploy.md) | Deploy and check |
| [owner-setup](runbooks/owner-setup.md) | Owner setup: what only the account owner can do |
| [release](runbooks/release.md) | Release the desktop apps |
| [security-alerts](runbooks/security-alerts.md) | Security alerts, the KMS key, and moving to your own key |

## Decisions: why

| # | Decision | Status |
|---|---|---|
| [0001](decisions/0001-at-sign-for-dates.md) | `@` at the start of a word opens the date picker | accepted |
| [0002](decisions/0002-timed-dates-are-moments.md) | A timed date is a moment; an all-day date is a day | accepted |
| [0003](decisions/0003-kms-key-now-own-key-later.md) | One AWS-made KMS key now; own key material later | accepted |
| [0004](decisions/0004-secret-blocks-in-the-browser.md) | Secret blocks are encrypted in the browser | accepted |

## Work logs: what was done

| Date | Topic | Status |
|---|---|---|
| [2026-11-14](work-logs/2026-11-14-checklist-cursor-and-alignment.md) | Checklist: cursor on empty lines, box level with the text | Fixed and checked locally; not deployed yet. |
| [2026-11-11](work-logs/2026-11-11-close-warnings.md) | Warn before closing mid-upload; save the last keystrokes on close | Live on the web and in the desktop apps (v0.1.0). |
| [2026-11-11](work-logs/2026-11-11-dates-agenda-calendar-copy.md) | Dates while writing (@), Agenda, calendar sync, time zones, Copy | Live and checked in the app. Google/Outlook sync waits for their OAuth apps (owner, runbook); iCloud can be connected now. |
| [2026-11-11](work-logs/2026-11-11-desktop-release-v0.1.0.md) | First desktop release: v0.1.0 | Released. Installed apps from now on update themselves from GitHub Releases. |
| [2026-11-11](work-logs/2026-11-11-project-start.md) | Blade Notes: first day, from nothing to a live app | Live. Web app, sync API, AWS stack; desktop apps released as v0.1.0 the same evening. |
| [2026-11-11](work-logs/2026-11-11-security-kms-headers-mfa-secrets.md) | Security: KMS key at rest, headers and CSP, signed-in files, two-step sign-in, alerts, Secret blocks | Live and checked; alert email confirmed 2026-11-12. Owner: turn on two-step sign-in, create the vault. |

Design records from the design canvas: [design/](design/README.md) (a moment in time, not kept in step with the code).
