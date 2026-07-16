import type SyncDatabase from '../sqlite/sync-database'
import { columnExists, tableExists } from '../opencode-usage/schema-helpers'
import { loadPagedOpenCodeSqliteConversationPresence } from './session-scanner-opencode-sqlite-conversation-presence'
import { loadPagedOpenCodeSqlitePreviews } from './session-scanner-opencode-sqlite-preview-pages'
import type { OpenCodeSqlitePreviewMetadata } from './session-scanner-types'
import { asRecord, normalizePreviewText, normalizeTitleText } from './session-scanner-values'

const OPENCODE_SQLITE_PREVIEW_LIMIT = 5

const DIRECT_PREVIEW_QUERY = `SELECT
       CASE WHEN json_valid(m.data) THEN json_extract(m.data, '$.role') END AS role,
       p.data AS part_data,
       p.time_created,
       CASE WHEN json_valid(m.data) THEN json_extract(m.data, '$.summary.title') END AS summary_title,
       CASE WHEN json_valid(m.data) THEN json_extract(m.data, '$.summary.body') END AS summary_body
  FROM message m
  JOIN part p ON p.message_id = m.id
  WHERE m.session_id = ?
    AND CASE WHEN json_valid(m.data) THEN json_extract(m.data, '$.role') END
        IN ('user', 'assistant')
    AND CASE WHEN json_valid(p.data) THEN json_extract(p.data, '$.type') END = 'text'
  ORDER BY p.time_created DESC
  LIMIT ?`

const DIRECT_CONVERSATION_PRESENCE_QUERY = `SELECT 1 AS found
  FROM message
  WHERE session_id = ?
    AND CASE WHEN json_valid(data) THEN json_extract(data, '$.role') END
        IN ('user', 'assistant')
  LIMIT 1`

function canLoadPreviews(db: SyncDatabase): boolean {
  return (
    tableExists(db, 'message') &&
    columnExists(db, 'message', 'id') &&
    columnExists(db, 'message', 'session_id') &&
    columnExists(db, 'message', 'data') &&
    tableExists(db, 'part') &&
    columnExists(db, 'part', 'message_id') &&
    columnExists(db, 'part', 'time_created') &&
    columnExists(db, 'part', 'data')
  )
}

function normalizedPartText(partData: string): string | null {
  try {
    const part = asRecord(JSON.parse(partData) as unknown)
    return typeof part?.text === 'string' ? normalizePreviewText(part.text) : null
  } catch {
    return null
  }
}

function directConversationSessionIds(
  db: SyncDatabase,
  sessionIds: readonly string[]
): Set<string> {
  if (
    !tableExists(db, 'message') ||
    !columnExists(db, 'message', 'session_id') ||
    !columnExists(db, 'message', 'data')
  ) {
    return new Set()
  }
  const statement = db.prepare(DIRECT_CONVERSATION_PRESENCE_QUERY)
  return new Set(
    sessionIds.filter((sessionId) => Boolean(statement.get(sessionId) as { found?: number }))
  )
}

export function loadOpenCodeSqlitePreviewMetadata(args: {
  db: SyncDatabase
  sessionIds: readonly string[]
}): {
  previews: ReadonlyMap<string, readonly OpenCodeSqlitePreviewMetadata[]>
  conversationSessionIds: ReadonlySet<string>
} {
  if (!canLoadPreviews(args.db)) {
    const pagedPresence = loadPagedOpenCodeSqliteConversationPresence(args)
    return {
      previews: new Map(),
      conversationSessionIds:
        pagedPresence ?? directConversationSessionIds(args.db, args.sessionIds)
    }
  }
  const paged = loadPagedOpenCodeSqlitePreviews(args)
  if (paged) {
    return paged
  }

  // Why: a rare WITHOUT ROWID schema with no unique part key cannot support
  // bounded paging; preserve readable results for this compatibility fallback.
  const previews = new Map<string, readonly OpenCodeSqlitePreviewMetadata[]>()
  const conversationSessionIds = directConversationSessionIds(args.db, args.sessionIds)
  for (const sessionId of args.sessionIds) {
    const rows = loadDirectOpenCodeSqlitePreviews(args.db, sessionId)
    previews.set(sessionId, rows)
  }
  return { previews, conversationSessionIds }
}

export function loadDirectOpenCodeSqlitePreviews(
  db: SyncDatabase,
  sessionId: string
): readonly OpenCodeSqlitePreviewMetadata[] {
  if (!canLoadPreviews(db)) {
    return []
  }
  const rows = db.prepare(DIRECT_PREVIEW_QUERY).all(sessionId, OPENCODE_SQLITE_PREVIEW_LIMIT) as {
    role: string | null
    part_data: string
    time_created: number
    summary_title: string | null
    summary_body: string | null
  }[]
  return rows.toReversed().map((row) => ({
    role: row.role === 'user' || row.role === 'assistant' ? row.role : 'unknown',
    text: normalizedPartText(row.part_data),
    timeCreated: row.time_created,
    summaryTitle: normalizeTitleText(row.summary_title ?? ''),
    summaryBody: normalizeTitleText(row.summary_body ?? '')
  }))
}
