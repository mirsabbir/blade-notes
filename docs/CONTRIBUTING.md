---
type: reference
date: 2026-11-12
title: "Writing the docs"
tags: [docs, rules, agents]
source: docs/CONTRIBUTING.md
---

# Writing the docs

These docs are written for two readers at once: a person who opens a page cold, and an AI agent that has to act on it. The person needs the plain answer first; the agent needs exact paths, commands and links. Every page gives both.

## Where does X go?

| You have… | It goes in |
|---|---|
| How a part of the app works (data, behaviour, limits, formats) | `architecture/NN-topic.md`, one topic per file |
| How to do something (steps that work as written) | `runbooks/topic.md` |
| Why a shaping choice was made | `decisions/NNNN-title.md` (never rewritten; a new one replaces it) |
| What was asked, decided, done and checked on a day | `work-logs/YYYY-MM-DD-topic.md`, one topic per file |
| A term a newcomer would not know | a row in [glossary.md](glossary.md) |
| A design mock or board from the design canvas | `design/` (records; not kept in step with the code) |
| Rules for coding agents | [../AGENTS.md](../AGENTS.md) |

## Rules

1. **Frontmatter on every page** (the root `README.md` and `AGENTS.md` excepted: GitHub and agent tools read those as they are):
   ```yaml
   ---
   type: architecture      # architecture | runbook | decision | work-log | reference | template
   date: 2026-11-12        # ISO; for work logs the date in the file name
   status: "One line"      # work logs and decisions only, quoted
   title: "Exact H1 of the page"
   tags: [lowercase, words]
   source: docs/architecture/02-security.md   # this file's path in the repo
   ---
   ```
2. **Plain answer first.** The first paragraph says what this is and why, in words a stranger understands. Details, tables and diagrams follow.
3. **Point at the code.** Architecture pages carry a **Code:** line with the files that implement them, and name tests that prove a claim.
4. **One topic per work log.** A day with three tasks gives three logs, linked to each other. Keep the `status` line true today.
5. **Reusable facts leave the log the same day.** How something works goes to `architecture/`, how to do it to `runbooks/`; the log links there and keeps only what was decided, done and measured.
6. **Short.** Tables and mermaid diagrams over paragraphs. Check every diagram renders (`npx @mermaid-js/mermaid-cli -i x.mmd -o x.svg`).
7. **Public repo.** Never write account ids, user-pool ids, emails, tokens, secret values, or details of the owner's notes.
8. **Keep the index true.** A new page gets a row in [README.md](README.md); a new term gets a row in the glossary.
9. **Cold read before pushing.** Read what you wrote as someone with none of your context: does each link and `#anchor` resolve, is each file one topic, is every status current?

Templates: [templates/](templates/).
