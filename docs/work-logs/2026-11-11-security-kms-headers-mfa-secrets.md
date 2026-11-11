---
type: work-log
date: 2026-11-11
status: "DRAFT — filled in after QA."
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

Details live in [02-security.md](../architecture/02-security.md) and [05-secret-blocks.md](../architecture/05-secret-blocks.md).
