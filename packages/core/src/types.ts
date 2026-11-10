/** Everything in the library is one item in a single tree. Depth is unlimited. */
export type ItemType = 'space' | 'folder' | 'note' | 'task'

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
  /** Tasks only. */
  status?: TaskStatus
  /** Tasks only: ISO date (`2026-11-14`) or date-time with offset. */
  due?: string
  priority?: Priority
  createdAt: string
  updatedAt: string
  /** Set when the item is in the trash. */
  deletedAt?: string
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

export interface PullResponse {
  records: Record[]
  cursor: number
  more: boolean
}

export type Change =
  | { kind: 'item'; data: Item }
  /** `baseSeq`: the seq of the body this edit started from; 0 for a new body. */
  | { kind: 'body'; data: Body; baseSeq: number }

export interface PushRequest {
  changes: Change[]
}

export interface PushResponse {
  /** seq given to each accepted change, by id + kind. */
  accepted: { kind: Change['kind']; id: string; seq: number }[]
  /** Bodies someone else changed after `baseSeq`: the server kept its copy, the client keeps its own as a copy. */
  conflicts: { id: string; server: Body; seq: number }[]
}
