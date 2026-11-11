import type { CalendarProvider } from '@blade-notes/core'
import type { Entry } from '../entries'
import { apple } from './apple'
import { google } from './google'
import { microsoft } from './microsoft'

/** `auth` is the whole Authorization header: `Bearer …` for Google and Microsoft, `Basic …` for iCloud. */
export interface CalendarApi {
  /** Writes the entry and returns the id the calendar knows it by. */
  upsert(auth: string, calendarId: string, entry: Entry, externalId?: string): Promise<string>
  remove(auth: string, calendarId: string, externalId: string): Promise<void>
}

/** Providers signed in with OAuth also make (or find again) their "Blade Notes" calendar. */
export interface OAuthCalendarApi extends CalendarApi {
  calendar(auth: string, previousId?: string): Promise<string>
}

export const APIS: { [p in CalendarProvider]: CalendarApi } = { google, outlook: microsoft, apple }
export const OAUTH_APIS = { google, outlook: microsoft }
