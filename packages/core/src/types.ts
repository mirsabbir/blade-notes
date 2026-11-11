/** Everything in the library is one item in a single tree. Depth is unlimited. */
/**
 * A `description` is the hidden text behind a list item or a phrase in a note or task:
 * its parentId is that note or task, and it never shows in the blades.
 * An `event` is a date typed into a note or task with @ (a date chip): its parentId is that
 * note or task, it never shows in the blades, and the Agenda and calendars read it.
 */
export type ItemType = 'space' | 'folder' | 'note' | 'task' | 'description' | 'event'

export type TaskStatus = 'todo' | 'doing' | 'done'
export type Priority = 'none' | 'low' | 'medium' | 'high'

export interface Item {
  id: string
  type: ItemType
  /** null only for spaces, which sit at the root. */
  parentId: string | null
  /** Fractional index: sorting siblings by `rank` gives their order. */
  rank: string
  title: string
  pinned?: boolean
  /** Spaces only: a CSS colour for the space's dot. */
  color?: string
  /** Tasks, and events (`todo` or `done`). */
  status?: TaskStatus
  /** Tasks only: ISO date (`2026-11-14`) or date-time with offset. */
  due?: string
  priority?: Priority
  /**
   * Events only: when (see when.ts). `2026-11-15` is all day, the same day in every zone;
   * `2026-11-15T09:00:00+06:00` is one moment, shown in the zone the device is in now.
   */
  at?: string
  /** Events only: IANA zone of the device that set the time, e.g. `Asia/Dhaka`. */
  tz?: string
  /** Events only: the calendar gets "Blade Notes reminder" instead of the text. */
  private?: boolean
  /** Events only: the title was typed in the chip's popup, so the line's text no longer replaces it. */
  customTitle?: boolean
  /** Files attached to a task or note. */
  attachments?: Attachment[]
  createdAt: string
  updatedAt: string
  /** Set when the item is in the trash. */
  deletedAt?: string
}

export interface Attachment {
  id: string
  /** Original file name, shown and used for downloads. */
  name: string
  size: number
  type: string
  /** `/api/files/<owner>/<key>`; add `?name=` to download with the original name. */
  src: string
  addedAt: string
}

/** A note's (or a task description's) rich text, stored apart so listing a folder never loads it. */
export interface Body {
  id: string
  /** Tiptap / ProseMirror JSON document. */
  doc: unknown
  updatedAt: string
}

/** One record as the sync API sends it. `seq` grows by one with every write in the account. */
export type Record =
  | { kind: 'item'; seq: number; data: Item }
  | { kind: 'body'; seq: number; data: Body }
  | { kind: 'settings'; seq: number; data: Settings }

export type CalendarProvider = 'google' | 'outlook' | 'apple'

/** One per account (id is always "settings"), synced like everything else, last write wins. */
export interface Settings {
  id: 'settings'
  /** How many blades stay open before the oldest fold into strips. */
  bladesOpen: number
  /** The calendar every space uses unless it says otherwise. null = no calendar. */
  defaultCalendar: CalendarProvider | null
  /** Per-space choice; a space missing here follows `defaultCalendar`. null = this space has no calendar. */
  spaceCalendars: { [spaceId: string]: CalendarProvider | null }
  /** Where a description opens: a blade on the right, a window over the note, or a popup at the text. */
  descriptionView: DescriptionView
  /** Hovering described text shows the start of its description. */
  descriptionPreview: boolean
  /** Secret blocks: the data key, wrapped by the passphrase and by the recovery key. Never the key itself. */
  vault?: VaultHeader
  updatedAt: string
}

/**
 * The vault behind Secret blocks. A random AES-256 data key encrypts every secret in the browser;
 * here it is stored only wrapped (AES-GCM) by a key derived from the passphrase (PBKDF2-SHA-256)
 * and, separately, by the one-time recovery key. All values are base64.
 */
export interface VaultHeader {
  v: 1
  salt: string
  iterations: number
  /** 12-byte IV + ciphertext of the data key, under the passphrase key. */
  wrapped: string
  /** The same under the recovery key. */
  recovery: string
  createdAt: string
}

/** What `GET /api/calendar` says about each provider. */
export interface CalendarStatus {
  provider: CalendarProvider
  /** The OAuth app for this provider is set up on the server (Apple needs none). */
  configured: boolean
  connected: boolean
  /** The account it is connected to, e.g. an email address. */
  account?: string
  /** Last time an event was written, ISO. */
  lastSyncAt?: string
  /** Why the last write failed, in words; cleared by the next success. */
  lastError?: string
}

export type DescriptionView = 'panel' | 'modal' | 'popover'

export const DEFAULT_SETTINGS: Settings = {
  id: 'settings',
  bladesOpen: 3,
  defaultCalendar: null,
  spaceCalendars: {},
  descriptionView: 'panel',
  descriptionPreview: true,
  updatedAt: '1970-01-01T00:00:00.000Z',
}

export interface PullResponse {
  records: Record[]
  cursor: number
  more: boolean
}

export type Change =
  | { kind: 'item'; data: Item }
  /** `baseSeq`: the seq of the body this edit started from; 0 for a new body. */
  | { kind: 'body'; data: Body; baseSeq: number }
  | { kind: 'settings'; data: Settings }

export interface PushRequest {
  changes: Change[]
}

export interface PushResponse {
  /** seq given to each accepted change, by id + kind. */
  accepted: { kind: Change['kind']; id: string; seq: number }[]
  /** Bodies someone else changed after `baseSeq`: the server kept its copy, the client keeps its own as a copy. */
  conflicts: { id: string; server: Body; seq: number }[]
  /** Changes the server will not store (too large); everything else in the request was handled. */
  rejected?: { kind: Change['kind']; id: string; reason: string }[]
}
