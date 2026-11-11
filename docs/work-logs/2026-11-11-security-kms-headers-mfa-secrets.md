---
type: work-log
date: 2026-11-11
status: "Live and checked. Owner: confirm the alert email, turn on two-step sign-in, create the vault."
title: "Security: KMS key at rest, headers and CSP, signed-in files, two-step sign-in, alerts, Secret blocks"
tags: [security, kms, csp, hsts, mfa, cognito, cloudtrail, secret-blocks]
---

# Security phase 1 and Secret blocks

**Asked.** The owner wants to keep confidential things, passwords included, in the app: encryption at rest with an AWS key (own key later), encryption in transit, high security, broken down layer by layer. Design: [design/security.html](../design/security.html).

## Found (deployed stack before this change)

| Layer | Before |
|---|---|
| Table | AWS-owned key: nothing to audit or switch off |
| Files bucket | SSE-S3; file links had no sign-in (a link opened the file for about an hour, cacheable) |
| Logs | CloudWatch default key |
| In transit | HTTPS only, TLS 1.2/1.3, S3 refuses HTTP: already right |
| Browser | no security headers |
| Sign-in | MFA optional, nobody enrolled; sign-out did not revoke the refresh token |
| Alerts | none; no CloudTrail trail in the account |

## Decided

[0003](../decisions/0003-kms-key-now-own-key-later.md) one KMS key now, own key material later; [0004](../decisions/0004-secret-blocks-in-the-browser.md) Secret blocks encrypted in the browser, because KMS alone does not keep a password from someone inside the AWS account. WAF skipped (cost, little gain). The account already has a monthly cost budget, so no new billing alarm.

## Done

Commit `53c69bb` and follow-ups; deployed with no replaced resources. Details: [02-security.md](../architecture/02-security.md), [05-secret-blocks.md](../architecture/05-secret-blocks.md).

- KMS key `alias/blade-notes` (yearly rotation) on the table (switched in place), the files bucket (bucket key) and both Lambda log groups.
- The 4 files already in the bucket copied onto the key in place; bytes compared with their previous versions: identical.
- CloudFront response headers: HSTS 2 years, CSP, `X-Frame-Options: DENY`, `no-referrer`, `nosniff`, Permissions-Policy.
- Files need the JWT and the owner's own `sub`; 60-second signed links fetched into blob URLs.
- Cognito client: scope `aws.cognito.signin.user.admin`, token revocation on; Settings › Security sets up TOTP and signs out everywhere; sign-out revokes.
- Trail (write-only, single region with global events) + EventBridge rules → SNS email on key disable/delete/policy change and root sign-in.
- Secret blocks (vault in the browser).

## Checked

| Check | Result |
|---|---|
| `curl -I` on the site | all six headers present; HTTP → 301 to HTTPS |
| `/api/files/...` and `/api/calendar` without a token | 401 |
| Table, bucket, log groups | SSE `KMS` with the key; bucket key on; rotation on (365 days); trail logging |
| Image pasted in a note | uploaded (presigned POST passes the CSP), stored `aws:kms`, shown from a blob URL |
| Two-step sign-in | status read from Cognito in the browser; Set up shows the QR and key; cancelled, not turned on |
| Secret block on "4821" | stored as `v1:` ciphertext; server copy of the note has no "4821"; plain-text copy shows dots; Lock, wrong passphrase refused, right one reveals |
| Clean-up | test vault removed from settings (pushed through `/api/sync`), test space trashed, test image deleted (all versions) |

## Open

- Owner: confirm the "AWS Notification - Subscription Confirmation" email; set up two-step sign-in and the vault in Settings › Security.
- Older versions of the 4 pre-switch files remain under the S3 key; delete them if version history is not needed.
