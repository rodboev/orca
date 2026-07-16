import type SyncDatabase from '../sqlite/sync-database'
import {
  compareOpenCodeSqliteLookupKeys,
  openCodeSqliteTableLookup,
  type OpenCodeSqliteLookupKey,
  type OpenCodeSqliteTableLookup
} from './session-scanner-opencode-sqlite-row-key'
import { asRecord } from './session-scanner-values'

const MESSAGE_ROLE_PAGE_LIMIT = 5

type MessageHeader = { key: OpenCodeSqliteLookupKey; sessionId: string }

function messageRole(data: string): string | null {
  try {
    const message = asRecord(JSON.parse(data) as unknown)
    return typeof message?.role === 'string' ? message.role : null
  } catch {
    return null
  }
}

function loadConversationPresence(args: {
  db: SyncDatabase
  sessionIds: ReadonlySet<string>
  lookup: OpenCodeSqliteTableLookup
}): Set<string> {
  const found = new Set<string>()
  let active = new Set(args.sessionIds)
  const cursors = new Map<string, OpenCodeSqliteLookupKey>()
  while (active.size > 0) {
    const pages = new Map<string, MessageHeader[]>()
    const rows = args.db
      .prepare(
        `SELECT ${args.lookup.select} AS lookup_key, m.session_id
         FROM message m
         WHERE m.session_id IN (SELECT value FROM json_each(?))`
      )
      .iterate(JSON.stringify([...active]))
    for (const value of rows) {
      const row = value as { lookup_key: OpenCodeSqliteLookupKey; session_id: string }
      const cursor = cursors.get(row.session_id)
      if (cursor !== undefined && compareOpenCodeSqliteLookupKeys(row.lookup_key, cursor) >= 0) {
        continue
      }
      const page = pages.get(row.session_id) ?? []
      page.push({ key: row.lookup_key, sessionId: row.session_id })
      page.sort((left, right) => compareOpenCodeSqliteLookupKeys(right.key, left.key))
      if (page.length > MESSAGE_ROLE_PAGE_LIMIT) {
        page.pop()
      }
      pages.set(row.session_id, page)
    }

    const keys = [...pages.values()].flatMap((page) => page.map((header) => header.key))
    const roleByKey = new Map<OpenCodeSqliteLookupKey, string | null>()
    if (keys.length > 0) {
      const dataRows = args.db
        .prepare(
          `SELECT ${args.lookup.predicate} AS lookup_key, data
           FROM message
           WHERE ${args.lookup.predicate} IN (SELECT value FROM json_each(?))`
        )
        .iterate(JSON.stringify(keys))
      for (const value of dataRows) {
        const row = value as { lookup_key: OpenCodeSqliteLookupKey; data: string }
        roleByKey.set(row.lookup_key, messageRole(row.data))
      }
    }

    const nextActive = new Set<string>()
    for (const sessionId of active) {
      const page = pages.get(sessionId) ?? []
      if (page.some((header) => ['user', 'assistant'].includes(roleByKey.get(header.key) ?? ''))) {
        found.add(sessionId)
      } else if (page.length === MESSAGE_ROLE_PAGE_LIMIT) {
        const last = page.at(-1)
        if (last) {
          cursors.set(sessionId, last.key)
          nextActive.add(sessionId)
        }
      }
    }
    active = nextActive
  }
  return found
}

export function loadPagedOpenCodeSqliteConversationPresence(args: {
  db: SyncDatabase
  sessionIds: readonly string[]
}): ReadonlySet<string> | null {
  const messageKey = openCodeSqliteTableLookup(args.db, 'message', 'm')
  return messageKey
    ? loadConversationPresence({
        db: args.db,
        sessionIds: new Set(args.sessionIds),
        lookup: messageKey
      })
    : null
}
