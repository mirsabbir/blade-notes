---
type: runbook
date: 2026-11-15
title: "Connect an AI agent (Claude, Claude Code, others)"
tags: [agents, mcp, owner]
source: docs/runbooks/connect-an-ai-agent.md
---

# Connect an AI agent (Claude, Claude Code, others)

Gives an AI assistant your notes through the MCP server. You need the site address (Settings › Connected apps shows the server address, `https://<site>/mcp`) and to be able to sign in to the app.

1. **Claude on the web, desktop or phone** (one connection serves all three): claude.ai › Settings › Connectors › Add custom connector. Name `Blade Notes`, URL `https://<site>/mcp`, leave the advanced settings empty. Click Connect.
2. **Claude Code:**
   ```bash
   claude mcp add --transport http --scope user blade-notes https://<site>/mcp
   ```
   Then in Claude Code type `/mcp`, pick `blade-notes`, and sign in.
3. **Another agent:** give it the same URL. It finds the sign-in by itself (OAuth discovery, client metadata document or dynamic registration).
4. A Blade Notes page opens: sign in if asked, check the app name and where it sends you back to, tick **Change** only if the agent may edit, and press **Allow**.

## Check

- Ask the agent: "What spaces do I have in Blade Notes?" It calls `overview`.
- Settings › Connected apps lists the app with "connected" and, after the first call, "last used".

## Disconnect

Settings › Connected apps › Disconnect. The agent loses access within a minute; it has to connect again (and you to approve again) to come back.

## When it goes wrong

| Symptom | Do |
|---|---|
| Claude says it couldn't reach the server | Open `https://<site>/.well-known/oauth-authorization-server` in a browser: it must show JSON. If not, deploy ([deploy.md](deploy.md)) |
| "This connection request has expired" | The approval page lives 10 minutes; start connecting again from the agent |
| The agent connected but cannot edit | It was allowed read only. Disconnect, connect again and tick Change |
| Times are an hour or a zone off | Tell the agent your zone; `agenda` takes `timezone`. The default is the zone of the device that last set a date |
| Agent says a Secret block cannot be made | By design: secrets are encrypted in your browser; add them in the app |
| Logs | CloudWatch log group of the `Agents` function: one line per call (route, tool, status, ms), never note text |
