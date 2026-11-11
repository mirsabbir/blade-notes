---
type: decision
date: 2026-11-11
status: accepted
title: "One AWS-made KMS key now; own key material later"
---

# 0003 · One AWS-made KMS key now; own key material later

**Decision.** A single customer-managed KMS key (`alias/blade-notes`, AWS-generated material, yearly rotation) encrypts the table, files, logs and calendar sign-ins. Own key material (BYOK) can replace it later without downtime ([runbook](../runbooks/security-alerts.md#your-own-key-later)).

**Why one key.** One audit trail and one off switch; per-purpose keys add cost ($1/month each) and nothing for a one-person app.

**Cost.** About $1–2 a month. AWS WAF was left out: $6+ a month with little gain when every route needs sign-in.
