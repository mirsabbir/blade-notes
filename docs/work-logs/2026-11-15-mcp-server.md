---
type: work-log
date: 2026-11-15
status: "LIVE 2026-11-15. Checked end to end on the site: Claude Code's sign-in flow, every tool on the real library, disconnect."
title: "MCP server: AI agents read and change the library"
tags: [agents, mcp, oauth]
source: docs/work-logs/2026-11-15-mcp-server.md
---

# MCP server: AI agents read and change the library

**Asked.** An MCP server for Blade Notes, with sign-in and a good knowledge base, so Claude (or any agent) can list spaces and folders, count and query notes, read and change them efficiently. The owner was unsure how authentication should work.

## Decided

| Topic | Choice | Record |
|---|---|---|
| Authentication | Own OAuth server for agents; consent and sign-in happen in the app; one revocable grant per app; read only or read and change | [0006](../decisions/0006-agents-sign-in-through-the-app.md) |
| Protocol | MCP 2026-07-28, stateless, with 2025-era clients served too (`@modelcontextprotocol/server` 2.4) | [08](../architecture/08-agents-mcp.md) |
| Tools | 9: overview, browse, search (with counts), agenda, read, create, update, edit, trash | [08](../architecture/08-agents-mcp.md#tools) |
| Note text | Markdown with app links for dates, descriptions, secrets, pictures; untouched blocks kept node for node | [08](../architecture/08-agents-mcp.md#text-as-markdown) |
| Speed | Warm in-memory copy of the account, caught up with the sync protocol (one query per call); compact text answers | [08](../architecture/08-agents-mcp.md#fast-and-light) |
| Out of scope | Deleting for good, making Secret blocks, file contents | here |

## Done

- `services/api/src/mcp/` (index, oauth, tools, library, markdown + tests); `services/api/src/sync.ts` split out of `handler.ts` so the agents Lambda does not bundle S3 (1.1 MB instead of 1.3 MB).
- `packages/core/src/events.ts`: the date-chip rule (`eventChanges`, `chipsIn`) moved from the web store, now shared with the server.
- `apps/web/src/Agents.tsx`: consent page (`/connect/<request>`) and Settings › Connected apps; sign-in now returns to the page it started on; How to has an "AI assistants" entry.
- `infra/lib/notes-stack.ts`: `Agents` Lambda (1 GB, 30 s), public routes `/mcp`, `/oauth/*`, `/.well-known/oauth-*`, app routes `/api/oauth/requests/{id}`, `/api/connections`; CloudFront sends those paths to the API.
- Docs: architecture 08, decision 0006, runbook connect-an-ai-agent, glossary, index.
- Deployed with `pnpm deploy` (personal profile); `cdk diff` showed only additions (Agents Lambda, role, log group, 14 routes, 3 CloudFront paths) and new code for Api, Purge, Calendar.
- After the live check: "24 entrys in the trash" → "items", count answers say "5 found" (not "5 match"); Connected apps shows the Claude Code command whole, with `--scope user`, selected on one click. Unit tests now speak protocol 2026-07-28 for real (`versionNegotiation`); before, the 2.4 client's default was the 2025 handshake for both "eras".

## Checked

| Check | Result |
|---|---|
| `markdown.test.ts`: every node and mark, dates, descriptions, secrets; 20,000 random strings; 5,000 random mark mixes | Round trip unchanged |
| `tools.test.ts`: real MCP client, both protocol eras, in-memory sync store | Create, read, search, counts, agenda, edit with version guard, date move and removal, update, move, trash, restore, error advice |
| `oauth.test.ts`: discovery, DCR and CIMD clients, loopback any port, single-use code, PKCE, refresh rotation, disconnect, bad redirect → page | Pass |
| Independent adversarial review (Opus, max effort) | No auth bypass. 12 findings, all fixed (regression tests for the edit, race, table, zone, id, scope, move and internal-address cases): checklists merging with the next list and boxes read as text on edit; an edit racing the app trashed descriptions before its text was refused; a list in a table cell erased on edit; own writes missed while the index lagged; a hex-looking title read as an id; offsets taken as zones; edited-date filters in UTC; unknown scopes granted write; client-metadata fetch errors, size and internal addresses; moves after itself; parent loops; listen streams hanging |
| `pnpm -r typecheck`, all package tests | Pass |
| Live discovery | `/mcp` without a token → 401 with `resource_metadata`; both metadata documents correct through CloudFront |
| Live sign-in, Claude Code's client id (CIMD) and a loopback port, owner signs in and allows in the browser | Consent page names "Claude Code"; sign-in returns to it; `state` and `iss` match; token with both scopes; the same code again → `invalid_grant`; refresh rotates (old refresh → `invalid_grant`) |
| Live tools, real library, client on protocol 2025-11-25 and 2026-07-28 | All 9. Create (space, folder, note with a date and a description in Markdown, task), read with version, search finds hidden text, agenda shows the date and the due task, edit, stale version refused, update, unknown item → advice, trash, search in trash. Test space "MCP live check" left in the trash |
| Server time per call (CloudWatch `ms`) | Read tools 8–17 ms warm; first call 109 ms (reads the account); writes 40–180 ms. The ~300–700 ms a client sees is the network to us-east-1 |
| Disconnect in Settings › Connected apps | Grant gone; refresh → `invalid_grant`, access token → 401 at once |

## Open

- Owner: connect Claude on claude.ai and in Claude Code (runbook [connect-an-ai-agent](../runbooks/connect-an-ai-agent.md)).
- The test space "MCP live check" is in the trash; it is purged with the rest after 30 days.
