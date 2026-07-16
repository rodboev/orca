import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../sqlite/sync-database'
import { buildOpenCodeSqliteCandidatePath } from './session-scanner-opencode-sqlite-paths'
import { listOpenCodeSqliteSessions } from './session-scanner-opencode-sqlite-discovery'
import { loadOpenCodeSqliteSessionMetadata } from './session-scanner-opencode-sqlite-metadata'
import { parseOpenCodeSqliteSession } from './session-scanner-opencode-sqlite'
import type { OpenCodeSqliteSessionMetadata } from './session-scanner-types'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'

let tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tempDirs = []
})

function createTempDb(): { db: Database.Database; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'orca-opencode-sqlite-'))
  tempDirs.push(dir)
  const path = join(dir, 'opencode.db')
  return { db: new Database(path), path }
}

function applyOpenCodeSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      parent_id TEXT,
      slug TEXT NOT NULL,
      directory TEXT NOT NULL,
      title TEXT NOT NULL,
      version TEXT NOT NULL,
      share_url TEXT,
      summary_additions INTEGER,
      summary_deletions INTEGER,
      summary_files INTEGER,
      summary_diffs TEXT,
      revert TEXT,
      permission TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      time_compacting INTEGER,
      time_archived INTEGER,
      workspace_id TEXT,
      path TEXT,
      agent TEXT,
      model TEXT,
      cost REAL DEFAULT 0 NOT NULL,
      tokens_input INTEGER DEFAULT 0 NOT NULL,
      tokens_output INTEGER DEFAULT 0 NOT NULL,
      tokens_reasoning INTEGER DEFAULT 0 NOT NULL,
      tokens_cache_read INTEGER DEFAULT 0 NOT NULL,
      tokens_cache_write INTEGER DEFAULT 0 NOT NULL,
      metadata TEXT
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE project (
      id TEXT PRIMARY KEY,
      worktree TEXT NOT NULL,
      vcs TEXT,
      name TEXT,
      icon_url TEXT,
      icon_color TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      time_initialized INTEGER,
      sandboxes TEXT NOT NULL,
      commands TEXT,
      icon_url_override TEXT
    );
  `)
}

function applyMinimalOpenCodeSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE session (
    id TEXT PRIMARY KEY,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL
  );`)
}

function insertSession(
  db: Database.Database,
  args: {
    id: string
    title?: string
    directory?: string
    timeCreated: number
    timeUpdated: number
    parentId?: string | null
    timeArchived?: number | null
    model?: string | null
    agent?: string | null
    tokensInput?: number
    tokensOutput?: number
    tokensReasoning?: number
    tokensCacheRead?: number
    cost?: number
  }
): void {
  db.prepare(
    `INSERT INTO session (id, project_id, parent_id, slug, directory, title, version,
       time_created, time_updated, time_archived, model, agent, cost,
       tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write)
     VALUES (?, 'proj-1', ?, ?, ?, ?, '1.0.0',
       ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?, 0)`
  ).run(
    args.id,
    args.parentId ?? null,
    `slug-${args.id}`,
    args.directory ?? '/tmp/opencode',
    args.title ?? 'OpenCode title',
    args.timeCreated,
    args.timeUpdated,
    args.timeArchived ?? null,
    args.model ?? JSON.stringify({ id: 'glm-5.2', providerID: 'zai-coding-plan' }),
    args.agent ?? 'build',
    args.cost ?? 0,
    args.tokensInput ?? 100,
    args.tokensOutput ?? 40,
    args.tokensReasoning ?? 10,
    args.tokensCacheRead ?? 5
  )
}

function insertMessage(
  db: Database.Database,
  args: {
    id: string
    sessionId: string
    role: 'user' | 'assistant'
    timeCreated: number
    summaryTitle?: string | null
    summaryBody?: string | null
  }
): void {
  const data = JSON.stringify({
    role: args.role,
    time: { created: args.timeCreated },
    agent: 'build',
    summary:
      args.summaryTitle || args.summaryBody
        ? { title: args.summaryTitle ?? null, body: args.summaryBody ?? null }
        : undefined
  })
  db.prepare(
    `INSERT INTO message (id, session_id, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?)`
  ).run(args.id, args.sessionId, args.timeCreated, args.timeCreated, data)
}

function insertPart(
  db: Database.Database,
  args: {
    id: string
    messageId: string
    sessionId: string
    timeCreated: number
    type?: 'text' | 'tool' | 'reasoning'
    text?: string
    data?: string
  }
): void {
  const data =
    args.data ??
    JSON.stringify({
      type: args.type ?? 'text',
      text: args.text ?? 'hello world'
    })
  db.prepare(
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(args.id, args.messageId, args.sessionId, args.timeCreated, args.timeCreated, data)
}

function metadataFor(dbPath: string, sessionId: string): OpenCodeSqliteSessionMetadata {
  return (
    loadOpenCodeSqliteSessionMetadata({ dbPath, sessionIds: [sessionId] }).get(sessionId) ?? {
      messageCount: 0,
      hasConversationMessages: false,
      previewRows: []
    }
  )
}

function legacyMetadataFor(dbPath: string, sessionId: string): OpenCodeSqliteSessionMetadata {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const count = db
      .prepare(
        `SELECT COUNT(*) AS value FROM message m
         WHERE m.session_id = ?
           AND json_extract(m.data, '$.role') IN ('user', 'assistant')`
      )
      .get(sessionId) as { value: number }
    const rows = db
      .prepare(
        `SELECT json_extract(m.data, '$.role') AS role,
                p.data AS part_data,
                p.time_created,
                json_extract(m.data, '$.summary.title') AS summary_title,
                json_extract(m.data, '$.summary.body') AS summary_body
         FROM message m
         JOIN part p ON p.message_id = m.id
         WHERE m.session_id = ?
           AND json_extract(m.data, '$.role') IN ('user', 'assistant')
           AND json_extract(p.data, '$.type') = 'text'
         ORDER BY p.time_created DESC
         LIMIT 5`
      )
      .all(sessionId) as {
      role: 'user' | 'assistant'
      part_data: string
      time_created: number
      summary_title: string | null
      summary_body: string | null
    }[]
    return {
      messageCount: count.value,
      hasConversationMessages: count.value > 0,
      previewRows: rows.toReversed().map((row) => ({
        role: row.role,
        text: (JSON.parse(row.part_data) as { text?: string }).text ?? null,
        timeCreated: row.time_created,
        summaryTitle: row.summary_title,
        summaryBody: row.summary_body
      }))
    }
  } finally {
    db.close()
  }
}
describe('listOpenCodeSqliteSessions', () => {
  it('returns candidates sorted by time_updated desc via the synthesized mtimeMs', async () => {
    const { db, path } = createTempDb()
    applyOpenCodeSchema(db)
    insertSession(db, {
      id: 'ses_old',
      title: 'Old',
      timeCreated: 1_777_634_000_000,
      timeUpdated: 1_777_634_001_000
    })
    insertSession(db, {
      id: 'ses_new',
      title: 'New',
      timeCreated: 1_777_634_002_000,
      timeUpdated: 1_777_634_003_000
    })
    db.close()

    const issues: AiVaultScanIssue[] = []
    const candidates = await listOpenCodeSqliteSessions({
      dbPaths: [path],
      limit: 10,
      issues
    })
    expect(issues).toEqual([])
    expect(candidates).toHaveLength(2)
    expect(candidates[0].agent).toBe('opencode')
    expect(candidates[0].file.mtimeMs).toBe(1_777_634_003_000)
    expect(candidates[0].file.path).toBe(buildOpenCodeSqliteCandidatePath(path, 'ses_new'))
    expect(candidates[1].file.path).toBe(buildOpenCodeSqliteCandidatePath(path, 'ses_old'))
  })

  it('discovers sessions when message content is malformed and part/event rows are noisy', async () => {
    const { db, path } = createTempDb()
    applyOpenCodeSchema(db)
    db.exec(`CREATE TABLE event (id TEXT PRIMARY KEY, data TEXT NOT NULL)`)
    insertSession(db, {
      id: 'ses_noise',
      timeCreated: 1_777_633_999_000,
      timeUpdated: 1_777_634_000_000
    })
    insertSession(db, {
      id: 'ses_clean',
      timeCreated: 1_777_634_000_000,
      timeUpdated: 1_777_634_001_000
    })
    db.prepare(
      `INSERT INTO message (id, session_id, time_created, time_updated, data)
       VALUES ('msg_malformed', 'ses_noise', 1777634000500, 1777634000500, ?)`
    ).run('malformed message JSON')
    db.prepare(`INSERT INTO event (id, data) VALUES ('event_1', ?)`).run('malformed event content')
    db.close()

    const { db: partDb, path: partPath } = createTempDb()
    applyOpenCodeSchema(partDb)
    insertSession(partDb, {
      id: 'ses_part_noise',
      timeCreated: 1_777_634_002_000,
      timeUpdated: 1_777_634_002_000
    })
    insertMessage(partDb, {
      id: 'msg_part_noise',
      sessionId: 'ses_part_noise',
      role: 'assistant',
      timeCreated: 1_777_634_002_000
    })
    insertPart(partDb, {
      id: 'part_malformed',
      messageId: 'msg_part_noise',
      sessionId: 'ses_part_noise',
      timeCreated: 1_777_634_002_000,
      data: 'malformed part JSON'
    })
    partDb.close()

    const issues: AiVaultScanIssue[] = []
    const candidates = await listOpenCodeSqliteSessions({
      dbPaths: [path, partPath],
      limit: 10,
      issues
    })

    expect(issues).toEqual([])
    expect(candidates.map((candidate) => candidate.file.path)).toEqual([
      buildOpenCodeSqliteCandidatePath(partPath, 'ses_part_noise'),
      buildOpenCodeSqliteCandidatePath(path, 'ses_clean'),
      buildOpenCodeSqliteCandidatePath(path, 'ses_noise')
    ])
    const pathMetadata = loadOpenCodeSqliteSessionMetadata({
      dbPath: path,
      sessionIds: ['ses_clean', 'ses_noise']
    })
    const cleanSession = await parseOpenCodeSqliteSession({
      dbPath: path,
      sessionId: 'ses_clean',
      platform: 'darwin',
      metadata: pathMetadata.get('ses_clean')
    })
    expect(cleanSession?.sessionId).toBe('ses_clean')
    const noisySession = await parseOpenCodeSqliteSession({
      dbPath: path,
      sessionId: 'ses_noise',
      platform: 'darwin',
      metadata: pathMetadata.get('ses_noise')
    })
    expect(noisySession?.messageCount).toBe(1)
    expect(noisySession?.hasConversationMessages).toBe(false)
    expect(noisySession?.previewMessages).toEqual([])

    const malformedPartSession = await parseOpenCodeSqliteSession({
      dbPath: partPath,
      sessionId: 'ses_part_noise',
      platform: 'darwin',
      metadata: metadataFor(partPath, 'ses_part_noise')
    })
    expect(malformedPartSession?.messageCount).toBe(1)
    expect(malformedPartSession?.previewMessages).toEqual([])
  })

  it('dedups matching session ids across databases and keeps the newest row', async () => {
    const { db: oldDb, path: oldPath } = createTempDb()
    applyOpenCodeSchema(oldDb)
    insertSession(oldDb, {
      id: 'ses_duplicate',
      title: 'Old duplicate',
      timeCreated: 1_777_634_000_000,
      timeUpdated: 1_777_634_001_000
    })
    oldDb.close()

    const { db: newDb, path: newPath } = createTempDb()
    applyOpenCodeSchema(newDb)
    insertSession(newDb, {
      id: 'ses_duplicate',
      title: 'New duplicate',
      timeCreated: 1_777_634_002_000,
      timeUpdated: 1_777_634_003_000
    })
    newDb.close()

    const candidates = await listOpenCodeSqliteSessions({
      dbPaths: [oldPath, newPath],
      limit: 10,
      issues: []
    })
    expect(candidates).toHaveLength(1)
    expect(candidates[0].file.path).toBe(buildOpenCodeSqliteCandidatePath(newPath, 'ses_duplicate'))
  })
  it('excludes archived and child sessions', async () => {
    const { db, path } = createTempDb()
    applyOpenCodeSchema(db)
    insertSession(db, {
      id: 'ses_normal',
      timeCreated: 1_777_634_000_000,
      timeUpdated: 1_777_634_001_000
    })
    insertSession(db, {
      id: 'ses_archived',
      timeCreated: 1_777_634_000_000,
      timeUpdated: 1_777_634_002_000,
      timeArchived: 1_777_634_002_500
    })
    insertSession(db, {
      id: 'ses_child',
      timeCreated: 1_777_634_000_000,
      timeUpdated: 1_777_634_003_000,
      parentId: 'ses_normal'
    })
    db.close()

    const candidates = await listOpenCodeSqliteSessions({
      dbPaths: [path],
      limit: 10,
      issues: []
    })
    expect(candidates.map((c) => c.file.path)).toEqual([
      buildOpenCodeSqliteCandidatePath(path, 'ses_normal')
    ])
  })

  it('returns [] when the session table is missing (legacy install)', async () => {
    const { db, path } = createTempDb()
    db.exec('CREATE TABLE other (id TEXT)')
    db.close()
    const candidates = await listOpenCodeSqliteSessions({
      dbPaths: [path],
      limit: 10,
      issues: []
    })
    expect(candidates).toEqual([])
  })

  it('records an issue when the DB file does not exist', async () => {
    const issues: AiVaultScanIssue[] = []
    const candidates = await listOpenCodeSqliteSessions({
      dbPaths: ['/nonexistent/opencode.db'],
      limit: 10,
      issues
    })
    expect(candidates).toEqual([])
    expect(issues).toHaveLength(1)
    expect(issues[0].agent).toBe('opencode')
    expect(issues[0].path).toBe('/nonexistent/opencode.db')
  })

  it('lists sessions from a minimal readable session table', async () => {
    const { db, path } = createTempDb()
    applyMinimalOpenCodeSchema(db)
    db.prepare(`INSERT INTO session VALUES ('ses_minimal', 1777634000000, 1777634001000)`).run()
    db.close()

    const issues: AiVaultScanIssue[] = []
    const candidates = await listOpenCodeSqliteSessions({
      dbPaths: [path],
      limit: 10,
      issues
    })
    expect(issues).toEqual([])
    expect(candidates).toHaveLength(1)
    expect(candidates[0].file.path).toBe(buildOpenCodeSqliteCandidatePath(path, 'ses_minimal'))
  })
})

describe('loadOpenCodeSqliteSessionMetadata', () => {
  it('matches the former per-session results for multiple sessions on an unindexed DB', () => {
    const { db, path } = createTempDb()
    applyOpenCodeSchema(db)
    const sessionIds = ['ses_batch_a', 'ses_batch_b']
    for (const [sessionIndex, sessionId] of sessionIds.entries()) {
      const baseTime = 1_777_634_000_000 + sessionIndex * 10_000
      insertSession(db, {
        id: sessionId,
        timeCreated: baseTime,
        timeUpdated: baseTime + 9_000
      })
      const messageTotal = sessionIndex === 0 ? 7 : 2
      for (let index = 0; index < messageTotal; index += 1) {
        const messageId = `${sessionId}_msg_${index}`
        insertMessage(db, {
          id: messageId,
          sessionId,
          role: index % 2 === 0 ? 'user' : 'assistant',
          timeCreated: baseTime + index + 1
        })
        insertPart(db, {
          id: `${sessionId}_part_${index}`,
          messageId,
          sessionId,
          timeCreated: baseTime + index + 1,
          text: `${sessionId} preview ${index + 1}`
        })
      }
    }
    db.close()

    const batched = loadOpenCodeSqliteSessionMetadata({ dbPath: path, sessionIds })
    for (const sessionId of sessionIds) {
      const actual = batched.get(sessionId)
      expect({
        messageCount: actual?.messageCount,
        hasConversationMessages: actual?.hasConversationMessages,
        previewRows: actual?.previewRows
      }).toEqual(legacyMetadataFor(path, sessionId))
    }
    expect(batched.get('ses_batch_a')?.previewRows.map((row) => row.text)).toEqual([
      'ses_batch_a preview 3',
      'ses_batch_a preview 4',
      'ses_batch_a preview 5',
      'ses_batch_a preview 6',
      'ses_batch_a preview 7'
    ])
  })
})

describe('parseOpenCodeSqliteSession', () => {
  it('builds an AiVaultSession with title, cwd, model, tokens, and resume command', async () => {
    const { db, path } = createTempDb()
    applyOpenCodeSchema(db)
    insertSession(db, {
      id: 'ses_1',
      title: 'OpenCode title',
      directory: '/tmp/opencode',
      timeCreated: 1_777_634_000_000,
      timeUpdated: 1_777_634_001_000,
      tokensInput: 100,
      tokensOutput: 40,
      tokensReasoning: 10,
      tokensCacheRead: 5,
      cost: 0.01
    })
    insertMessage(db, {
      id: 'msg_1',
      sessionId: 'ses_1',
      role: 'user',
      timeCreated: 1_777_634_000_500,
      summaryTitle: 'OpenCode title'
    })
    insertPart(db, {
      id: 'prt_1',
      messageId: 'msg_1',
      sessionId: 'ses_1',
      timeCreated: 1_777_634_000_500,
      text: 'Plan the work'
    })
    insertMessage(db, {
      id: 'msg_2',
      sessionId: 'ses_1',
      role: 'assistant',
      timeCreated: 1_777_634_000_900
    })
    insertPart(db, {
      id: 'prt_2',
      messageId: 'msg_2',
      sessionId: 'ses_1',
      timeCreated: 1_777_634_001_000,
      text: 'Done'
    })
    db.close()

    const session = await parseOpenCodeSqliteSession({
      dbPath: path,
      sessionId: 'ses_1',
      platform: 'darwin',
      metadata: metadataFor(path, 'ses_1')
    })
    expect(session).not.toBeNull()
    expect(session!.agent).toBe('opencode')
    expect(session!.sessionId).toBe('ses_1')
    expect(session!.filePath).toBe(path)
    expect(session!.title).toBe('OpenCode title')
    expect(session!.cwd).toBe('/tmp/opencode')
    expect(session!.model).toBe('glm-5.2')
    expect(session!.totalTokens).toBe(150)
    expect(session!.messageCount).toBe(2)
    expect(session!.createdAt).toBe(new Date(1_777_634_000_000).toISOString())
    expect(session!.updatedAt).toBe(new Date(1_777_634_001_000).toISOString())
    expect(session!.resumeCommand).toBe("cd '/tmp/opencode' && opencode --session 'ses_1'")
    expect(session!.previewMessages).toHaveLength(2)
    expect(session!.previewMessages[0].text).toBe('Plan the work')
    expect(session!.previewMessages[0].role).toBe('user')
    expect(session!.previewMessages[1].text).toBe('Done')
    expect(session!.previewMessages[1].role).toBe('assistant')
  })

  it('falls back to summary.body for title when session.title is empty', async () => {
    const { db, path } = createTempDb()
    applyOpenCodeSchema(db)
    insertSession(db, {
      id: 'ses_2',
      title: '',
      timeCreated: 1_777_634_000_000,
      timeUpdated: 1_777_634_001_000
    })
    insertMessage(db, {
      id: 'msg_1',
      sessionId: 'ses_2',
      role: 'user',
      timeCreated: 1_777_634_000_500,
      summaryBody: 'fallback title from summary'
    })
    insertPart(db, {
      id: 'prt_1',
      messageId: 'msg_1',
      sessionId: 'ses_2',
      timeCreated: 1_777_634_000_500,
      text: 'hello'
    })
    db.close()

    const session = await parseOpenCodeSqliteSession({
      dbPath: path,
      sessionId: 'ses_2',
      platform: 'darwin',
      metadata: metadataFor(path, 'ses_2')
    })
    expect(session).not.toBeNull()
    expect(session!.title).toBe('fallback title from summary')
  })

  it('returns null when the session id is not found', async () => {
    const { db, path } = createTempDb()
    applyOpenCodeSchema(db)
    insertSession(db, {
      id: 'ses_real',
      timeCreated: 1_777_634_000_000,
      timeUpdated: 1_777_634_001_000
    })
    db.close()
    const session = await parseOpenCodeSqliteSession({
      dbPath: path,
      sessionId: 'ses_missing',
      platform: 'darwin'
    })
    expect(session).toBeNull()
  })

  it('returns null when the DB has no session table', async () => {
    const { db, path } = createTempDb()
    db.exec('CREATE TABLE other (id TEXT)')
    db.close()
    const session = await parseOpenCodeSqliteSession({
      dbPath: path,
      sessionId: 'ses_1',
      platform: 'darwin'
    })
    expect(session).toBeNull()
  })

  it('parses a minimal readable session table without optional columns or messages', async () => {
    const { db, path } = createTempDb()
    applyMinimalOpenCodeSchema(db)
    db.prepare(`INSERT INTO session VALUES ('ses_minimal', 1777634000000, 1777634001000)`).run()
    db.close()

    const session = await parseOpenCodeSqliteSession({
      dbPath: path,
      sessionId: 'ses_minimal',
      platform: 'darwin'
    })
    expect(session).not.toBeNull()
    expect(session!.sessionId).toBe('ses_minimal')
    expect(session!.filePath).toBe(path)
    expect(session!.title).toBe('OpenCode ses_mini')
    expect(session!.cwd).toBeNull()
    expect(session!.model).toBeNull()
    expect(session!.messageCount).toBe(0)
    expect(session!.totalTokens).toBe(0)
    expect(session!.previewMessages).toEqual([])
  })

  it('extracts model from older modelID schema', async () => {
    const { db, path } = createTempDb()
    applyOpenCodeSchema(db)
    insertSession(db, {
      id: 'ses_3',
      timeCreated: 1_777_634_000_000,
      timeUpdated: 1_777_634_001_000,
      model: JSON.stringify({ modelID: 'claude-sonnet-4-5' })
    })
    db.close()
    const session = await parseOpenCodeSqliteSession({
      dbPath: path,
      sessionId: 'ses_3',
      platform: 'darwin'
    })
    expect(session).not.toBeNull()
    expect(session!.model).toBe('claude-sonnet-4-5')
  })
})
