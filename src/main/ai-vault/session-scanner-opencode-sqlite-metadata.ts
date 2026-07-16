import SyncDatabase from '../sqlite/sync-database'
import { columnExists, tableExists } from '../opencode-usage/schema-helpers'
import { splitOpenCodeSqliteCandidate } from './session-scanner-opencode-sqlite-paths'
import {
  loadDirectOpenCodeSqlitePreviews,
  loadOpenCodeSqlitePreviewMetadata
} from './session-scanner-opencode-sqlite-preview-metadata'
import type {
  OpenCodeSqliteSessionMetadata,
  OpenCodeSqliteSessionRowMetadata,
  SessionFileCandidate
} from './session-scanner-types'
import { errorMessage } from './session-scanner-values'

const OPENCODE_SQLITE_METADATA_BATCH_LIMIT = 1000

// Why: COUNT(*) can stay on table leaf pages even when data blobs are huge;
// bounded role probes separately protect resume/hide-empty semantics.
const COUNT_QUERY = `SELECT session_id, COUNT(*) AS message_count
  FROM message
  WHERE session_id IN (SELECT value FROM json_each(?))
  GROUP BY session_id`

const DIRECT_COUNT_QUERY = `SELECT COUNT(*) AS message_count
  FROM message
  WHERE session_id = ?
    AND CASE WHEN json_valid(data) THEN json_extract(data, '$.role') END
        IN ('user', 'assistant')`

type CountRow = { session_id: string; message_count: number }

function openReadonlyDatabase(dbPath: string): SyncDatabase {
  const db = new SyncDatabase(dbPath, { readonly: true, fileMustExist: true })
  db.pragma('query_only = ON')
  // Why: paged preview rows are resolved by a stable row key in later SELECTs;
  // one read snapshot prevents a foreign writer from recycling it mid-load.
  db.exec('BEGIN')
  return db
}

function closeReadonlyDatabase(db: SyncDatabase): void {
  try {
    db.exec('ROLLBACK')
  } finally {
    db.close()
  }
}

function emptyMetadata(): OpenCodeSqliteSessionMetadata {
  return {
    sessionRow: null,
    messageCount: 0,
    hasConversationMessages: false,
    previewRows: []
  }
}

function sessionColumnSelect(db: SyncDatabase, columnName: string): string {
  return columnExists(db, 'session', columnName) ? columnName : 'NULL'
}

function sessionNumberColumnSelect(db: SyncDatabase, columnName: string): string {
  return columnExists(db, 'session', columnName) ? columnName : '0'
}

function canReadSessionRows(db: SyncDatabase): boolean {
  return (
    tableExists(db, 'session') &&
    columnExists(db, 'session', 'id') &&
    columnExists(db, 'session', 'time_created') &&
    columnExists(db, 'session', 'time_updated')
  )
}

function buildSessionSelect(db: SyncDatabase, predicate: string): string {
  return `SELECT id,
          ${sessionColumnSelect(db, 'title')} AS title,
          ${sessionColumnSelect(db, 'directory')} AS directory,
          time_created,
          time_updated,
          ${sessionColumnSelect(db, 'model')} AS model_json,
          ${sessionColumnSelect(db, 'agent')} AS agent,
          ${sessionNumberColumnSelect(db, 'tokens_input')} AS tokens_input,
          ${sessionNumberColumnSelect(db, 'tokens_output')} AS tokens_output,
          ${sessionNumberColumnSelect(db, 'tokens_reasoning')} AS tokens_reasoning,
          ${sessionNumberColumnSelect(db, 'tokens_cache_read')} AS tokens_cache_read,
          ${sessionNumberColumnSelect(db, 'cost')} AS cost
    FROM session
    WHERE ${predicate}`
}

function loadSessionRows(
  db: SyncDatabase,
  sessionIdsJson: string,
  metadata: Map<string, OpenCodeSqliteSessionMetadata>
): void {
  if (!canReadSessionRows(db)) {
    return
  }
  const rows = db
    .prepare(buildSessionSelect(db, 'id IN (SELECT value FROM json_each(?))'))
    .all(sessionIdsJson) as OpenCodeSqliteSessionRowMetadata[]
  for (const row of rows) {
    const current = metadata.get(row.id)
    if (current) {
      metadata.set(row.id, { ...current, sessionRow: row })
    }
  }
}

function loadDirectSessionRow(
  db: SyncDatabase,
  sessionId: string
): OpenCodeSqliteSessionRowMetadata | null {
  if (!canReadSessionRows(db)) {
    return null
  }
  return (
    (db.prepare(`${buildSessionSelect(db, 'id = ?')} LIMIT 1`).get(sessionId) as
      | OpenCodeSqliteSessionRowMetadata
      | undefined) ?? null
  )
}

function canCountMessages(db: SyncDatabase): boolean {
  return (
    tableExists(db, 'message') &&
    columnExists(db, 'message', 'session_id') &&
    columnExists(db, 'message', 'data')
  )
}

/** Load bounded count and preview metadata for many sessions in fixed passes. */
export function loadOpenCodeSqliteSessionMetadata(args: {
  dbPath: string
  sessionIds: readonly string[]
}): ReadonlyMap<string, OpenCodeSqliteSessionMetadata> {
  const sessionIds = [...new Set(args.sessionIds)]
  const metadata = new Map(sessionIds.map((sessionId) => [sessionId, emptyMetadata()]))
  if (sessionIds.length === 0) {
    return metadata
  }

  const db = openReadonlyDatabase(args.dbPath)
  try {
    const sessionIdsJson = JSON.stringify(sessionIds)
    loadSessionRows(db, sessionIdsJson, metadata)
    if (canCountMessages(db)) {
      const countRows = db.prepare(COUNT_QUERY).all(sessionIdsJson) as CountRow[]
      for (const row of countRows) {
        const current = metadata.get(row.session_id)
        if (current) {
          metadata.set(row.session_id, { ...current, messageCount: row.message_count })
        }
      }
    }

    const conversation = loadOpenCodeSqlitePreviewMetadata({ db, sessionIds })
    for (const sessionId of sessionIds) {
      const current = metadata.get(sessionId)
      if (current) {
        metadata.set(sessionId, {
          ...current,
          hasConversationMessages: conversation.conversationSessionIds.has(sessionId),
          previewRows: conversation.previews.get(sessionId) ?? []
        })
      }
    }
    return metadata
  } finally {
    closeReadonlyDatabase(db)
  }
}

/** Preserve the former per-session behavior when a batch cannot be loaded. */
export function loadOpenCodeSqliteSessionMetadataDirect(args: {
  dbPath: string
  sessionId: string
}): OpenCodeSqliteSessionMetadata {
  const db = openReadonlyDatabase(args.dbPath)
  try {
    const sessionRow = loadDirectSessionRow(db, args.sessionId)
    if (!sessionRow) {
      return emptyMetadata()
    }
    let messageCount = 0
    if (canCountMessages(db)) {
      const count = db.prepare(DIRECT_COUNT_QUERY).get(args.sessionId) as {
        message_count?: number
      }
      messageCount = count.message_count ?? 0
    }
    return {
      sessionRow,
      messageCount,
      hasConversationMessages: messageCount > 0,
      previewRows: loadDirectOpenCodeSqlitePreviews(db, args.sessionId)
    }
  } finally {
    closeReadonlyDatabase(db)
  }
}

export type OpenCodeSqliteMetadataLoadFailure = { dbPath: string; message: string }

/** Attach bounded batched metadata results to synthetic SQLite candidates. */
export function loadOpenCodeSqliteCandidateMetadata(candidates: readonly SessionFileCandidate[]): {
  candidates: SessionFileCandidate[]
  failures: OpenCodeSqliteMetadataLoadFailure[]
} {
  const batches = new Map<string, { index: number; sessionId: string }[]>()
  candidates.forEach((candidate, index) => {
    if (candidate.agent !== 'opencode' || candidate.opencodeSqliteMetadata) {
      return
    }
    const parsed = splitOpenCodeSqliteCandidate(candidate.file.path)
    if (!parsed) {
      return
    }
    const batch = batches.get(parsed.dbPath) ?? []
    batch.push({ index, sessionId: parsed.sessionId })
    batches.set(parsed.dbPath, batch)
  })

  const hydrated = [...candidates]
  const failures: OpenCodeSqliteMetadataLoadFailure[] = []
  for (const [dbPath, dbBatch] of batches) {
    for (let offset = 0; offset < dbBatch.length; offset += OPENCODE_SQLITE_METADATA_BATCH_LIMIT) {
      const batch = dbBatch.slice(offset, offset + OPENCODE_SQLITE_METADATA_BATCH_LIMIT)
      let loaded: ReadonlyMap<string, OpenCodeSqliteSessionMetadata>
      try {
        loaded = loadOpenCodeSqliteSessionMetadata({
          dbPath,
          sessionIds: batch.map((item) => item.sessionId)
        })
      } catch (err) {
        if (!failures.some((failure) => failure.dbPath === dbPath)) {
          failures.push({ dbPath, message: errorMessage(err) })
        }
        continue
      }
      for (const item of batch) {
        const candidate = hydrated[item.index]
        if (candidate) {
          hydrated[item.index] = {
            ...candidate,
            opencodeSqliteMetadata: loaded.get(item.sessionId) ?? emptyMetadata()
          }
        }
      }
    }
  }
  return { candidates: hydrated, failures }
}
