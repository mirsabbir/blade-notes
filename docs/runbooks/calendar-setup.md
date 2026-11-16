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

Done 2026-11-15 in the owner's Google account. Check the account in the console's top-right avatar before step 1: a first-time account asks to accept the Google Cloud terms.

1. Google Cloud console → new project → enable **Google Calendar API**.
2. Google Auth Platform → Get started: app name, support and contact email, audience **External**, accept the User Data Policy.
3. Data access → Add or remove scopes → paste `openid, https://www.googleapis.com/auth/userinfo.email, https://www.googleapis.com/auth/calendar.app.created` → Update → Save. All three are *non-sensitive*: no verification, no "unverified app" warning (as long as no logo is uploaded).
4. Branding: home page `https://<NOTES_DOMAIN>`, privacy policy `https://<NOTES_DOMAIN>/privacy.html` (`apps/web/public/privacy.html`), authorised domain = the site's registrable domain. Without the privacy link, Publish stays disabled; in *Testing*, refresh tokens expire after 7 days.
5. Audience → Publish app → Confirm (**In production**).
6. Clients → Create client → Web application → the redirect URI above (leave "AI-powered agent" unticked). The secret shows once: have the prompt below waiting first.
7. Store it without the secret touching chat, history or the screen:
   ```bash
   printf 'Client ID: '; read -r CID; printf 'Secret: '; read -rs CS; echo; aws ssm put-parameter --profile <profile> --region us-east-1 --name /blade-notes/google-oauth --type SecureString --key-id alias/blade-notes --value "$(jq -nc --arg i "$CID" --arg s "$CS" '{clientId:$i,clientSecret:$s}')" >/dev/null && echo saved; unset CS
   ```
8. Settings › Calendars shows Connect within 5 minutes (it showed it at once on 2026-11-15).

Replacing the client secret: Clients → the client → Add secret, store it with `--overwrite`, then disable the old one.

## Microsoft (Outlook)

Done 2026-11-16 in the owner's personal Entra tenant (never a work tenant), by Graph API instead of the portal. **The client secret expires 2028-11-16**: before then add a new one and store it with `--overwrite`, or Outlook sync stops.

1. Sign in to the personal tenant in a throwaway az profile, so the everyday az login and its work tenants stay untouched:
   ```bash
   AZURE_CONFIG_DIR=<tmp>/az-personal az login --tenant <tenant-id> --allow-no-subscriptions
   ```
2. `POST https://graph.microsoft.com/v1.0/applications` with `signInAudience: AzureADandPersonalMicrosoftAccount`, `api.requestedAccessTokenVersion: 2` (required for personal accounts), `web.redirectUris: [the redirect URI above]` and Microsoft Graph delegated scopes `openid`, `email`, `offline_access`, `Calendars.ReadWrite` (look their ids up in the tenant: `servicePrincipals(appId='00000003-0000-0000-c000-000000000000')` → `oauth2PermissionScopes`).
3. `POST …/applications/<id>/addPassword` with an `endDateTime` 24 months out; pipe `secretText` straight into `put-parameter --name /blade-notes/microsoft-oauth` in the same command, never printed.
4. Delete the throwaway az profile.

Portal equivalent: Entra admin center → App registrations → New (any directory and personal accounts, Web redirect URI) → API permissions (the four above) → Certificates & secrets.

## iCloud

Nothing to register. In Settings › Calendars › Apple › Connect, enter the Apple ID and an app-specific password (account.apple.com › Sign-In and Security › App-Specific Passwords). The server checks it over CalDAV and makes a "Blade Notes" calendar.

## Check

Settings › Calendars shows "Connected as …"; pick it for a space; type `@tom 9am` in a note there; within seconds the event is in the "Blade Notes" calendar, and its link opens the note. Errors show under the provider; the calendar Lambda's log group has details.

Replacing a secret: same command with `--overwrite`; the Lambda re-reads SSM within 5 minutes.
