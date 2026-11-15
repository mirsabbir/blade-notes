---
type: decision
date: 2026-11-15
status: accepted
title: "0006 · AI agents sign in through the app, with tokens of their own"
tags: [agents, mcp, oauth, security]
source: docs/decisions/0006-agents-sign-in-through-the-app.md
---

# 0006 · AI agents sign in through the app, with tokens of their own

**Context.** The MCP server must work from Claude on the web, desktop and phone and from Claude Code, with nothing to paste but its address. Those clients expect OAuth with discovery metadata, PKCE S256, a client ID metadata document or dynamic registration, `https://claude.ai/api/mcp/auth_callback` and loopback redirects on any port. Cognito (the app's sign-in) has none of the registration methods, matches redirect ports exactly and has a different issuer host.

**Decision.** A small authorization server in the agents Lambda issues its own opaque tokens, valid only for `/mcp`. The consent step is a page of the app (`/connect/<request>`): the owner signs in there as always (two-step code included) and approves through an API route behind the app's own Cognito sign-in. Every connection is a grant the owner can see and remove.

| Option | Why not |
|---|---|
| Cognito as the authorization server | No CIMD or DCR, no port-agnostic loopback, so each client needs a hand-made Cognito client; Cognito tokens would also open the app's own API |
| Personal access tokens in a header | Claude on the web and phone cannot send custom headers for a custom connector; tokens get pasted around |
| No authentication | It is a private notebook |
| A login page served by the Lambda | A second sign-in to keep safe (passwords, two-step codes, CSRF); the app already has one |

**Trade-offs.** About 250 lines of OAuth code to keep correct (covered by `oauth.test.ts`). Revoking takes up to a minute to reach a warm Lambda. Dynamic registration is open to anyone (records expire after a year); a registered client still gets nothing without the owner's consent.
