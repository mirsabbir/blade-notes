# Agent guide

Personal notes and tasks app: React + Tiptap web app, AWS serverless backend (CDK), thin desktop wrappers. **Public repo.**

## Map

| Path | What |
|---|---|
| `apps/web/src` | Web app. `App.tsx` blades, `Editor.tsx` editor, `store.ts` offline store + sync, `schedule.ts`/`DatePicker.tsx`/`dates.ts` @-dates, `Agenda.tsx`, `copy.ts` Copy button, `secret.ts`/`vault.ts`/`VaultPanel.tsx` Secret blocks, `Settings.tsx` + `SecuritySettings.tsx` + `Help.tsx` |
| `packages/core/src` | Shared types (`types.ts`), dates and zones (`when.ts`), ranks, size limits |
| `services/api` | Lambda for `/api/sync`, `/api/uploads`, `/api/files` |
| `services/calendar` | Lambda for `/api/calendar/*` and the stream worker that writes calendars |
| `infra/lib/notes-stack.ts` | The whole AWS stack |
| `apps/desktop-*` | macOS (Swift) and Windows (.NET) windows around the site |
| `docs/` | Architecture, runbooks, decisions, work logs, design records: start at `docs/README.md` |

## Commands

```bash
pnpm install
pnpm test          # every package (vitest)
pnpm typecheck
pnpm dev           # web on :5173 against the deployed API
cd infra && AWS_PROFILE=<profile> npx cdk diff
AWS_PROFILE=<profile> pnpm deploy   # see docs/runbooks/deploy.md
```

## Rules

- **Public repo:** never commit account ids, user-pool ids, emails, tokens, secrets or `.env`. Deployment values live in `.env` (git-ignored).
- **Docs are part of done:** a change in behaviour updates its `docs/architecture/` file; a shaping choice gets a `docs/decisions/` record; each day's work gets a `docs/work-logs/` entry (one topic per file). Keep docs short; tables and mermaid over prose.
- **Less code:** simple, no abstraction without a second use, no dead code, comments say why.
- **Dates:** timed values are moments shown in the device's current zone; all-day values are days (`packages/core/src/when.ts`). Never format a date without going through it.
- **Security:** the CSP allows scripts only from the site; no inline scripts, no new third-party origins without updating the CSP in `notes-stack.ts`. Secret-block plaintext never leaves the browser, never logs, never syncs.
- **Light app:** heavy, rarely used code (like the QR library) loads with dynamic `import()`.
- **Infra:** read `cdk diff` before deploying; nothing stateful may be replaced. The table, files bucket and KMS key are retained on delete.
- Commit messages say what changed for the user; no AI attribution trailers.
