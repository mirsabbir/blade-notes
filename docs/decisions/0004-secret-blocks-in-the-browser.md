---
type: decision
date: 2026-11-11
status: accepted
title: "Secret blocks are encrypted in the browser"
---

# 0004 · Secret blocks are encrypted in the browser

**Context.** The owner wants to keep passwords in notes. A KMS key protects stored data, but the app's server can decrypt everything it syncs, so anyone inside the AWS account could read a password.

**Decision.** Secrets are encrypted in the browser with a data key that is wrapped by a passphrase-derived key and by a one-time recovery key ([05](../architecture/05-secret-blocks.md)). Only the wrapped key and ciphertext are synced.

**Trade-offs.** Search does not see secrets; a forgotten passphrase and lost recovery key cannot be helped; the rest of the note stays server-readable (that is what makes sync, search and calendars work).
