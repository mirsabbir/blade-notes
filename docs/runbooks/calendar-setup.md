---
type: runbook
date: 2026-11-11
title: "Set up calendar sign-in (Google, Microsoft, iCloud)"
tags: [calendar, oauth, google, microsoft, icloud, ssm]
source: docs/runbooks/calendar-setup.md
---

# Set up calendar sign-in (Google, Microsoft, iCloud)

Until a provider's OAuth app exists, Settings › Calendars says "Not available yet" for it. Redirect URI for both: `https://<NOTES_DOMAIN>/api/calendar/callback`.

## Google

1. Google Cloud console → new project → enable **Google Calendar API**.
2. OAuth consent screen: External; scopes `openid`, `email`, `.../auth/calendar.app.created`; add yourself as a test user. While in *Testing*, refresh tokens expire after 7 days; *In production* without verification works for personal use (an "unverified app" warning shows once).
3. Credentials → OAuth client ID → Web application → the redirect URI above.
4. Store it (never commit it):
   ```bash
   aws ssm put-parameter --profile <profile> --region us-east-1 --name /blade-notes/google-oauth \
     --type SecureString --key-id alias/blade-notes --value '{"clientId":"<id>","clientSecret":"<secret>"}'
   ```

## Microsoft (Outlook)

1. Microsoft Entra admin center → App registrations → New; accounts in any directory **and personal Microsoft accounts**; Web redirect URI above.
2. API permissions, Microsoft Graph, delegated: `openid`, `email`, `offline_access`, `Calendars.ReadWrite`.
3. Certificates & secrets → new client secret.
4. Same `put-parameter` with `--name /blade-notes/microsoft-oauth`.

## iCloud

Nothing to register. In Settings › Calendars › Apple › Connect, enter the Apple ID and an app-specific password (account.apple.com › Sign-In and Security › App-Specific Passwords). The server checks it over CalDAV and makes a "Blade Notes" calendar.

## Check

Settings › Calendars shows "Connected as …"; pick it for a space; type `@tom 9am` in a note there; within seconds the event is in the "Blade Notes" calendar, and its link opens the note. Errors show under the provider; the calendar Lambda's log group has details.

Replacing a secret: same command with `--overwrite`; the Lambda re-reads SSM within 5 minutes.
