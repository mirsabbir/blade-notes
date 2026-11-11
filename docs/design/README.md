# Design records

Static design records from 11 Nov 2026, exported from a canvas tool. They are not deployed: the web build only ships `apps/web`.

| File | Shows |
|---|---|
| `index.html` | Entry page linking to all boards |
| `gesture.html` | Why `@` opens the date picker, what you can type after it, the keys |
| `copy.html` | How a date chip survives copy and paste; what the Copy button copies |
| `sync.html` | How a date goes from a chip to the Agenda and your calendar |
| `security.html` | Encryption at rest and in transit, what each layer stops, Secret blocks |

View: open the `.html` file in a browser (start at `index.html`).

`canvas/` holds the canvas sources (`*.dc.html`, `canvas.json`), unchanged and re-importable into the canvas tool. `Main.dc.html` (the interactive prototype) runs only there.

The Security page shows the stack as it was before phase 1; [../architecture/02-security.md](../architecture/02-security.md) describes what runs now.
