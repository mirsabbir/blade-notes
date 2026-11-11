---
type: runbook
date: 2026-11-12
title: "Owner setup: what only the account owner can do"
tags: [setup, security, mfa, vault, calendar, alerts]
---

# Owner setup

Steps that need the owner's phone, email or Google account, so no deploy or agent can do them. Status as of 2026-11-12.

| # | Step | Status |
|---|---|---|
| 1 | [Confirm the alert email](#1-alert-email) | Done 2026-11-12 |
| 2 | [Two-step sign-in](#2-two-step-sign-in) | To do: before storing passwords |
| 3 | [Vault for Secret blocks](#3-vault-for-secret-blocks) | To do: before storing passwords |
| 4 | [Calendars](#4-calendars) | Optional |
| 5 | [Clean-ups](#5-clean-ups) | Optional |

## 1. Alert email

1. Find "AWS Notification - Subscription Confirmation" from no-reply@sns.amazonaws.com (check spam).
2. Click **Confirm subscription**, not the unsubscribe link. The link works for 3 days.
3. Check: the Alerts topic's subscription shows an ARN, not `PendingConfirmation`:
   ```bash
   aws sns list-subscriptions --profile <profile> --region us-east-1 --query "Subscriptions[?contains(TopicArn,'BladeNotes')].SubscriptionArn"
   ```
4. No email, or the link expired: resend with `aws sns subscribe --topic-arn <Alerts topic ARN> --protocol email --notification-endpoint <NOTES_ALERT_EMAIL>`.

What it sends: [security-alerts.md](security-alerts.md).

## 2. Two-step sign-in

1. Install an authenticator app on the phone (Google Authenticator, 1Password, Authy).
2. Settings › Security › Two-step sign-in › **Set up**. If it says "needs a fresh sign-in", click **Sign in again** first (sessions from before 11 Nov lack the scope).
3. Scan the QR code (or type the key shown), enter the six digits, **Turn on**. The row now says "On".
4. Every sign-in from then on asks for the code.

Lost phone: an AWS admin turns it off for the user, then it is set up again on the new phone:
```bash
aws cognito-idp admin-set-user-mfa-preference --profile <profile> --region us-east-1 \
  --user-pool-id <UserPoolId> --username <user> --software-token-mfa-settings Enabled=false,PreferredMfa=false
```
An authenticator that backs up its codes (1Password, Authy) avoids this.

## 3. Vault for Secret blocks

1. Settings › Security › Secret blocks: a passphrase of 10 or more characters (a short sentence is easiest), twice, **Create the vault**.
2. The **recovery key** shows once: save it in a password manager or on paper, away from the computer; tick "I saved the recovery key"; **Done**.
3. In a note, select a password or PIN › **Secret** (on the bubble over the selection). It shows as dots; Reveal, Copy and Edit ask for the passphrase after 5 idle minutes or a reload.

Forget the passphrase: Unlock › "Use the recovery key instead", then choose a new passphrase. Lose both: nobody can open those secrets. How it works: [05-secret-blocks.md](../architecture/05-secret-blocks.md).

## 4. Calendars

- **iCloud:** Settings › Calendars › Apple › Connect, with the Apple ID and an app-specific password (account.apple.com › Sign-In and Security › App-Specific Passwords).
- **Google / Outlook:** register the app with Google or Microsoft first: [calendar-setup.md](calendar-setup.md). Then Settings › Calendars › Connect, from a web browser (Google refuses sign-in inside the desktop apps).
- Then pick a calendar per space (or a default) in the same screen. Dates go into a "Blade Notes" calendar in that account.

## 5. Clean-ups

- An earlier test session left a test task in one space (due 27 Nov 2026); trash it if it is not wanted.
- The files bucket keeps older versions of 4 files from before the KMS switch, under the S3 key. Delete those versions if version history is not needed.
