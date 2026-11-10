# Architecture

## Data model

Everything is an `Item` in one tree (`packages/core/src/types.ts`): `space` (root level), `folder`, `note`, `task`. Each has a `parentId` and a fractional `rank` for its position among siblings, so moving one item rewrites only that item. Depth is unlimited. Deleting sets `deletedAt` (trash) on the item and everything under it.

A note's text, and a task's description, is a separate `Body` (Tiptap JSON), so listing a folder never loads note text.

## Storage (DynamoDB, one table)

| pk | sk | holds |
|---|---|---|
| `USER#<sub>` | `ITEM#<id>` | an item |
| `USER#<sub>` | `BODY#<id>` | a body |
| `USER#<sub>` | `META#counter` | the account's write counter |

Every write takes the next number from the counter as its `seq`. The `bySeq` index (`pk`, `seq`) answers "what changed after N" — that is the whole sync protocol. Point-in-time recovery is on (35 days). Images live in S3 under `users/<sub>/`.

## Sync

```mermaid
sequenceDiagram
  participant D as Device (IndexedDB)
  participant A as /api/sync
  D->>D: edit: change local state, mark record pending
  D->>A: POST pending items and bodies (body carries baseSeq)
  A-->>D: accepted seq per record, or conflict + server copy
  D->>A: GET ?since=cursor
  A-->>D: records with seq > cursor
```

- Items are last-write-wins.
- A body is only written if the stored one is still the version the edit started from (`baseSeq`). Otherwise the server keeps its copy and the device saves its own text as a sibling note named "… (conflict copy)". Nothing is lost.
- While a record is pending on a device, pulled versions of it are skipped until the push lands.

## Sign-in

Cognito user pool with sign-up off. The web app uses the authorization-code flow with PKCE (`apps/web/src/auth.ts`). The HTTP API checks the access token's JWT. `/api/files/<owner>/<uuid>.<ext>` is the one route without a token, because `<img>` cannot send one; the random UUID is the key.

## Hosting

CloudFront serves the web app from S3 and forwards `/api/*` to the HTTP API, so the app and API share one origin (no CORS). `config.json` (region, client id, sign-in URL) is written at deploy time, so the build holds no account-specific values. Deployment-specific settings come from `.env`, never from code.
