import type SyncDatabase from '../sqlite/sync-database'
import { columnExists } from '../opencode-usage/schema-helpers'
import { loadPagedOpenCodeSqliteConversationPresence } from './session-scanner-opencode-sqlite-conversation-presence'
import {
  compareOpenCodeSqliteLookupKeys,
  openCodeSqliteTableLookup,
  type OpenCodeSqliteLookupKey as LookupKey,
  type OpenCodeSqliteTableLookup as TableLookup
} from './session-scanner-opencode-sqlite-row-key'
import type { OpenCodeSqlitePreviewMetadata } from './session-scanner-types'
import { asRecord, normalizePreviewText, normalizeTitleText } from './session-scanner-values'

const PREVIEW_LIMIT = 5

type Cursor = { key: LookupKey; timeCreated: number }
type PartHeader = Cursor & { sessionId: string; messageId: string }
type MessageData = {
  role: string | null
  summaryTitle: string | null
  summaryBody: string | null
}

function isOlderThanCursor(candidate: Cursor, cursor: Cursor | undefined): boolean {
  return (
    !cursor ||
    candidate.timeCreated < cursor.timeCreated ||
    (candidate.timeCreated === cursor.timeCreated &&
      compareOpenCodeSqliteLookupKeys(candidate.key, cursor.key) < 0)
  )
}

function insertNewestHeader(headers: PartHeader[], header: PartHeader): void {
  const insertionIndex = headers.findIndex(
    (current) =>
      current.timeCreated < header.timeCreated ||
      (current.timeCreated === header.timeCreated &&
        compareOpenCodeSqliteLookupKeys(current.key, header.key) < 0)
  )
  if (insertionIndex === -1) {
    headers.push(header)
  } else {
    headers.splice(insertionIndex, 0, header)
  }
  if (headers.length > PREVIEW_LIMIT) {
    headers.pop()
  }
}

function buildPartHeaderQuery(db: SyncDatabase, lookup: TableLookup): string {
  if (columnExists(db, 'part', 'session_id')) {
    return `SELECT ${lookup.select} AS lookup_key,
                   p.session_id,
                   p.message_id,
                   p.time_created
            FROM part p
            WHERE p.session_id IN (SELECT value FROM json_each(?))`
  }
  return `SELECT ${lookup.select} AS lookup_key,
                 m.session_id,
                 p.message_id,
                 p.time_created
          FROM part p
          JOIN message m ON m.id = p.message_id
          WHERE m.session_id IN (SELECT value FROM json_each(?))`
}

function loadPartHeaderPage(args: {
  db: SyncDatabase
  sessionIds: ReadonlySet<string>
  cursors: ReadonlyMap<string, Cursor>
  lookup: TableLookup
}): Map<string, PartHeader[]> {
  const pages = new Map<string, PartHeader[]>()
  const rows = args.db
    .prepare(buildPartHeaderQuery(args.db, args.lookup))
    .iterate(JSON.stringify([...args.sessionIds]))
  for (const value of rows) {
    const row = value as {
      lookup_key: LookupKey
      session_id: string
      message_id: string
      time_created: number
    }
    const header: PartHeader = {
      key: row.lookup_key,
      sessionId: row.session_id,
      messageId: row.message_id,
      timeCreated: row.time_created
    }
    if (!isOlderThanCursor(header, args.cursors.get(row.session_id))) {
      continue
    }
    const page = pages.get(row.session_id) ?? []
    insertNewestHeader(page, header)
    pages.set(row.session_id, page)
  }
  return pages
}

function loadPartData(
  db: SyncDatabase,
  lookup: TableLookup,
  pages: ReadonlyMap<string, readonly PartHeader[]>
): Map<LookupKey, { isText: boolean; text: string | null }> {
  const keys = [...pages.values()].flatMap((page) => page.map((header) => header.key))
  if (keys.length === 0) {
    return new Map()
  }
  const result = new Map<LookupKey, { isText: boolean; text: string | null }>()
  const rows = db
    .prepare(
      `SELECT ${lookup.predicate} AS lookup_key, data
       FROM part
       WHERE ${lookup.predicate} IN (SELECT value FROM json_each(?))`
    )
    .iterate(JSON.stringify(keys))
  for (const value of rows) {
    const row = value as { lookup_key: LookupKey; data: string }
    try {
      const part = asRecord(JSON.parse(row.data) as unknown)
      result.set(row.lookup_key, {
        isText: part?.type === 'text',
        text: typeof part?.text === 'string' ? normalizePreviewText(part.text) : null
      })
    } catch {
      result.set(row.lookup_key, { isText: false, text: null })
    }
  }
  return result
}

function parsedMessageData(data: string): MessageData {
  try {
    const message = asRecord(JSON.parse(data) as unknown)
    const summary = asRecord(message?.summary)
    return {
      role: typeof message?.role === 'string' ? message.role : null,
      summaryTitle: typeof summary?.title === 'string' ? normalizeTitleText(summary.title) : null,
      summaryBody: typeof summary?.body === 'string' ? normalizeTitleText(summary.body) : null
    }
  } catch {
    return { role: null, summaryTitle: null, summaryBody: null }
  }
}

function loadMessageDataById(
  db: SyncDatabase,
  messageIds: readonly string[]
): Map<string, MessageData> {
  if (messageIds.length === 0) {
    return new Map()
  }
  const result = new Map<string, MessageData>()
  const rows = db
    .prepare('SELECT id, data FROM message WHERE id IN (SELECT value FROM json_each(?))')
    .iterate(JSON.stringify([...new Set(messageIds)]))
  for (const value of rows) {
    const row = value as { id: string; data: string }
    result.set(row.id, parsedMessageData(row.data))
  }
  return result
}

export function loadPagedOpenCodeSqlitePreviews(args: {
  db: SyncDatabase
  sessionIds: readonly string[]
}): {
  previews: ReadonlyMap<string, readonly OpenCodeSqlitePreviewMetadata[]>
  conversationSessionIds: ReadonlySet<string>
} | null {
  const partKey = openCodeSqliteTableLookup(args.db, 'part', 'p')
  const messageKey = openCodeSqliteTableLookup(args.db, 'message', 'm')
  if (!partKey || !messageKey) {
    return null
  }
  const previews = new Map<string, OpenCodeSqlitePreviewMetadata[]>()
  const conversationSessionIds = new Set<string>()
  const cursors = new Map<string, Cursor>()
  let active = new Set(args.sessionIds)
  while (active.size > 0) {
    const pages = loadPartHeaderPage({ db: args.db, sessionIds: active, cursors, lookup: partKey })
    const partData = loadPartData(args.db, partKey, pages)
    const messageData = loadMessageDataById(
      args.db,
      [...pages.values()].flatMap((page) => page.map((header) => header.messageId))
    )
    const nextActive = new Set<string>()
    for (const sessionId of active) {
      const page = pages.get(sessionId) ?? []
      const selected = previews.get(sessionId) ?? []
      for (const header of page) {
        const message = messageData.get(header.messageId)
        if (message?.role === 'user' || message?.role === 'assistant') {
          conversationSessionIds.add(sessionId)
          const part = partData.get(header.key)
          if (part?.isText && selected.length < PREVIEW_LIMIT) {
            selected.push({
              role: message.role,
              text: part.text,
              timeCreated: header.timeCreated,
              summaryTitle: message.summaryTitle,
              summaryBody: message.summaryBody
            })
          }
        }
      }
      previews.set(sessionId, selected)
      if (selected.length < PREVIEW_LIMIT && page.length === PREVIEW_LIMIT) {
        const last = page.at(-1)
        if (last) {
          cursors.set(sessionId, last)
          nextActive.add(sessionId)
        }
      }
    }
    active = nextActive
  }

  const unresolved = new Set(
    args.sessionIds.filter((sessionId) => !conversationSessionIds.has(sessionId))
  )
  for (const sessionId of loadPagedOpenCodeSqliteConversationPresence({
    db: args.db,
    sessionIds: [...unresolved]
  }) ?? []) {
    conversationSessionIds.add(sessionId)
  }
  return {
    previews: new Map(
      [...previews].map(([sessionId, newestFirst]) => [sessionId, newestFirst.toReversed()])
    ),
    conversationSessionIds
  }
}
