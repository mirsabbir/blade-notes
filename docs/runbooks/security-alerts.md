---
type: runbook
date: 2026-11-11
title: "Security alerts, the KMS key, and moving to your own key"
tags: [security, kms, alerts, cloudtrail]
source: docs/runbooks/security-alerts.md
---

# Security alerts, the KMS key, and moving to your own key

| Email subject says | Do |
|---|---|
| KMS key disabled / scheduled for deletion / policy changed | If it was not you: sign in to AWS as an admin, re-enable the key (`aws kms enable-key`) or cancel deletion (`aws kms cancel-key-deletion`), restore the policy from the stack (`pnpm deploy`), rotate the AWS account's credentials, check CloudTrail for the caller. |
| Root user signed in | If it was not you: change the root password, check root MFA, look at CloudTrail event history for what it did. |

While the key is disabled the app cannot read or write anything (sync fails, files do not load); nothing is lost.

## Emergency lock

`aws kms disable-key --key-id alias/blade-notes` makes every note, file and calendar sign-in unreadable at once, for everyone including the app. `enable-key` undoes it.

## Your own key later

KMS accepts key material you make yourself ("imported key material"), or keys kept outside AWS (external key store). To switch: create that key, point `TableEncryptionV2.customerManagedKey(...)` and the files bucket at it, deploy (DynamoDB re-encrypts in place, no downtime), copy existing S3 objects onto themselves so they take the new key, keep the old key enabled until that is done. This changes who holds the server key, not who can read notes through the app; for that, Secret blocks ([05](../architecture/05-secret-blocks.md)).
