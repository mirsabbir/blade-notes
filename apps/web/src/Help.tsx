import type { ReactNode } from 'react'

/** Settings › How to: every gesture and shortcut in one place, short. */
const TOPICS: { title: string; rows: [ReactNode, ReactNode][] }[] = [
  {
    title: 'Give anything a date',
    rows: [
      [<><kbd>@</kbd> at the start of a word</>, 'Opens the date picker anywhere you write. An email like mir@gmail.com never opens it, because its @ is inside a word.'],
      [<><kbd>@sun</kbd> <kbd>@tom 9am</kbd> <kbd>@next fri 3pm</kbd></>, 'Days, times and dates in plain words: also @today, @15 nov, @in 3 days, @3pm.'],
      [<><kbd>↑</kbd> <kbd>↓</kbd> <kbd>Enter</kbd></>, 'Pick a suggestion, or click a day in the month. The line’s text becomes the event’s title.'],
      [<kbd>Esc</kbd>, 'Close the picker and keep what you typed as plain text.'],
      ['Click a date', 'Change the day or time, mark it done, keep its text out of the calendar, or remove it.'],
      ['Schedule button', 'In the toolbar, or on selected words (they become the title).'],
      ['Travelling', 'Times are one moment in time: 9:00 set in Dhaka shows as 8:30 in India. All-day dates stay on their day everywhere.'],
    ],
  },
  {
    title: 'Agenda',
    rows: [
      ['Agenda in the Library', 'Every date from @ and every task due date, by space or by day. Click a row to open it; the date flashes in the text.'],
      ['Calendars', 'Settings › Calendars: connect Google, Outlook or iCloud and pick one per space. Dates go into a “Blade Notes” calendar there.'],
    ],
  },
  {
    title: 'Hidden descriptions',
    rows: [
      ['+ Description at the end of a line', 'Gives a bullet, numbered or checklist line its own hidden text and files.'],
      [<><kbd>⌘</kbd><kbd>⇧</kbd><kbd>D</kbd></>, 'Describe the selected words, or the line the cursor is in. Describe also sits on the bubble over selected text.'],
    ],
  },
  {
    title: 'Secret blocks',
    rows: [
      ['Select text › Secret', 'Hides it behind your vault passphrase: shown as dots, with Reveal, Copy and Edit. Set up the vault in Settings › Security.'],
      ['Copying', 'Plain copies of a note show dots. Copy on a secret puts it on the clipboard and clears it after 30 seconds.'],
    ],
  },
  {
    title: 'Copy',
    rows: [
      ['Copy (top right)', 'The whole note or task: title, details, text, dates written out, hidden descriptions, attachment names. Rich text for Gmail or Docs, Markdown for the rest.'],
      [<><kbd>⌘</kbd><kbd>C</kbd> on text with dates</>, 'Dates paste as words elsewhere and as dates again in Blade Notes. A copy makes a new date; cut and paste in the same note moves it.'],
    ],
  },
  {
    title: 'Writing',
    rows: [
      [<><kbd>#</kbd> <kbd>-</kbd> <kbd>1.</kbd> <kbd>[ ]</kbd> <kbd>&gt;</kbd> <kbd>```</kbd></>, 'At the start of a line: heading, bullet, numbered list, checklist, quote, code block.'],
      [<><kbd>⌘</kbd><kbd>B</kbd> <kbd>⌘</kbd><kbd>I</kbd> <kbd>⌘</kbd><kbd>Z</kbd></>, 'Bold, italic, undo.'],
      ['Paste or drop an image', 'Puts it in the text. Drop other files on the note to attach them (up to 50 MB each).'],
    ],
  },
  {
    title: 'Finding your way',
    rows: [
      [<><kbd>⌘</kbd><kbd>K</kbd></>, 'Search titles and text everywhere.'],
      ['Blades', 'Each folder opens a column to the right; older ones fold into strips. Click a strip to open it, or use Focus to fold them all.'],
    ],
  },
]

export function Help() {
  return (
    <div className="settings-rows help">
      {TOPICS.map((t) => (
        <section key={t.title}>
          <h4 className="settings-sub">{t.title}</h4>
          <dl className="help-list">
            {t.rows.map(([k, v], i) => (
              <div key={i} className="help-row">
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  )
}
