# Blade Notes docs

Everything here is documentation: none of it is built or deployed (the site ships only `apps/web`). Agents start at [../AGENTS.md](../AGENTS.md).

**What the owner still has to set up** (two-step sign-in, vault, calendars): [runbooks/owner-setup.md](runbooks/owner-setup.md).

| Folder | Holds | Rule |
|---|---|---|
| [architecture/](architecture/) | How each part works, one topic per file | Update the topic's file when behaviour changes, in the same commit |
| [runbooks/](runbooks/) | How to do something: deploy, set up calendars, answer an alert | Steps that work as written |
| [decisions/](decisions/) | Why a shaping choice was made, numbered | Never rewrite an accepted one; add a new one that replaces it |
| [work-logs/](work-logs/) | What was done each day, one topic per file | See [work-logs/README.md](work-logs/README.md) |
| [design/](design/) | Design records (static HTML from the design canvas) | Records of a moment; not kept in step with the code |

## Architecture

| # | Topic |
|---|---|
| [01](architecture/01-data-and-sync.md) | Data model, DynamoDB layout, sync protocol, sign-in, hosting |
| [02](architecture/02-security.md) | Encryption at rest and in transit, headers, sign-in, files, alerts |
| [03](architecture/03-dates-and-agenda.md) | `@` dates, events, time zones, Agenda |
| [04](architecture/04-calendar-sync.md) | Google, Outlook and iCloud sync |
| [05](architecture/05-secret-blocks.md) | Secret blocks and the vault |
| [06](architecture/06-copy-and-paste.md) | Copy and paste of chips and secrets; the Copy button |
