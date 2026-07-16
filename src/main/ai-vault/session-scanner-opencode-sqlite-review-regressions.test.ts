import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isAiVaultSessionResumableContent } from '../../shared/ai-vault-types'
import Database from '../sqlite/sync-database'
import {
  loadOpenCodeSqliteSessionMetadata,
  loadOpenCodeSqliteSessionMetadataDirect
} from './session-scanner-opencode-sqlite-metadata'
import { parseOpenCodeSqliteSession } from './session-scanner-opencode-sqlite'

let tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tempDirs = []
})

function createDatabase(): { db: Database.Database; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'orca-opencode-review-regression-'))
  tempDirs.push(dir)
  const path = join(dir, 'opencode.db')
  const db = new Database(path)
  // Why: part.id was never part of the readable foreign-schema contract.
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      title TEXT,
      directory TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    );
    CREATE TABLE message (
      id TEXT,
      session_id TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE part (
      message_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `)
  return { db, path }
}

function insertMessage(
  db: Database.Database,
  args: { id: string; sessionId: string; data: string }
): void {
  db.prepare('INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)').run(
    args.id,
    args.sessionId,
    args.data
  )
}

function insertPart(
  db: Database.Database,
  args: { messageId: string; timeCreated: number; data: string }
): void {
  db.prepare('INSERT INTO part (message_id, time_created, data) VALUES (?, ?, ?)').run(
    args.messageId,
    args.timeCreated,
    args.data
  )
}

describe('OpenCode SQLite review regressions', () => {
  it('keeps system, tool, and malformed-only sessions non-resumable', async () => {
    const { db, path } = createDatabase()
    db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?)').run(
      'non-conversation',
      'Non-conversation',
      '/tmp/system',
      1_777_634_000_000,
      1_777_634_001_000
    )
    for (const [id, data] of [
      ['system-message', JSON.stringify({ role: 'system' })],
      ['tool-message', JSON.stringify({ role: 'tool' })],
      ['malformed-message', 'malformed JSON']
    ]) {
      insertMessage(db, { id, sessionId: 'non-conversation', data })
    }
    db.close()

    const metadata = loadOpenCodeSqliteSessionMetadata({
      dbPath: path,
      sessionIds: ['non-conversation']
    }).get('non-conversation')
    expect(metadata?.messageCount).toBe(3)
    expect(metadata?.hasConversationMessages).toBe(false)
    const session = await parseOpenCodeSqliteSession({
      dbPath: path,
      sessionId: 'non-conversation',
      platform: 'darwin',
      metadata
    })
    expect(session && isAiVaultSessionResumableContent(session)).toBe(false)
  })

  it('keeps role-aware resume counts and previews on the former minimal schema', async () => {
    const { db, path } = createDatabase()
    db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?)').run(
      'minimal-session',
      '',
      '/tmp/minimal',
      1_777_634_000_000,
      1_777_634_001_000
    )
    insertMessage(db, {
      id: 'user-message',
      sessionId: 'minimal-session',
      data: JSON.stringify({
        role: 'user',
        summary: { body: 'summary fallback' }
      })
    })
    insertPart(db, {
      messageId: 'user-message',
      timeCreated: 1_777_634_000_100,
      data: JSON.stringify({ type: 'text', text: 'user preview' })
    })
    insertMessage(db, {
      id: 'assistant-message',
      sessionId: 'minimal-session',
      data: JSON.stringify({ role: 'assistant' })
    })
    insertPart(db, {
      messageId: 'assistant-message',
      timeCreated: 1_777_634_000_200,
      data: JSON.stringify({ type: 'text', text: 'assistant preview' })
    })
    for (const [id, role] of [
      ['system-message', 'system'],
      ['tool-message', 'tool']
    ]) {
      insertMessage(db, {
        id,
        sessionId: 'minimal-session',
        data: JSON.stringify({ role })
      })
    }
    insertMessage(db, {
      id: 'malformed-message',
      sessionId: 'minimal-session',
      data: 'malformed JSON'
    })
    db.close()

    const batched = loadOpenCodeSqliteSessionMetadata({
      dbPath: path,
      sessionIds: ['minimal-session']
    }).get('minimal-session')
    const direct = loadOpenCodeSqliteSessionMetadataDirect({
      dbPath: path,
      sessionId: 'minimal-session'
    })
    expect(batched?.messageCount).toBe(5)
    expect(batched?.hasConversationMessages).toBe(true)
    expect(direct.messageCount).toBe(2)
    expect(batched?.previewRows.map((row) => row.text)).toEqual([
      'user preview',
      'assistant preview'
    ])

    // No prefetched metadata exercises the failure/direct-caller fallback seam.
    const session = await parseOpenCodeSqliteSession({
      dbPath: path,
      sessionId: 'minimal-session',
      platform: 'darwin'
    })
    expect(session?.title).toBe('summary fallback')
    expect(session?.messageCount).toBe(2)
    expect(session?.previewMessages.map((row) => row.text)).toEqual([
      'user preview',
      'assistant preview'
    ])
  })

  it('retains only five bounded normalized previews in chronological order', () => {
    const { db, path } = createDatabase()
    db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?)').run(
      'large-previews',
      'Large previews',
      '/tmp/large',
      1_777_634_000_000,
      1_777_634_001_000
    )
    for (let index = 0; index < 7; index += 1) {
      const messageId = `message-${index}`
      insertMessage(db, {
        id: messageId,
        sessionId: 'large-previews',
        data: JSON.stringify({ role: index % 2 === 0 ? 'user' : 'assistant' })
      })
      insertPart(db, {
        messageId,
        timeCreated: 1_777_634_000_100 + index,
        data: JSON.stringify({ type: 'text', text: `preview ${index + 1} ${'x'.repeat(100_000)}` })
      })
    }
    db.close()

    const batched = loadOpenCodeSqliteSessionMetadata({
      dbPath: path,
      sessionIds: ['large-previews']
    }).get('large-previews')
    const direct = loadOpenCodeSqliteSessionMetadataDirect({
      dbPath: path,
      sessionId: 'large-previews'
    })
    expect(batched).toEqual(direct)
    expect(batched?.previewRows).toHaveLength(5)
    expect(batched?.previewRows.map((row) => row.timeCreated)).toEqual([
      1_777_634_000_102, 1_777_634_000_103, 1_777_634_000_104, 1_777_634_000_105, 1_777_634_000_106
    ])
    for (const preview of batched?.previewRows ?? []) {
      expect(preview.text?.length).toBeLessThanOrEqual(220)
      expect(preview).not.toHaveProperty('partData')
    }
  })

  it('backfills older previews when newer foreign rows are ineligible or malformed', () => {
    const { db, path } = createDatabase()
    db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?)').run(
      'preview-backfill',
      'Preview backfill',
      '/tmp/backfill',
      1_777_634_000_000,
      1_777_634_001_000
    )
    for (let index = 1; index <= 5; index += 1) {
      insertMessage(db, {
        id: `eligible-${index}`,
        sessionId: 'preview-backfill',
        data: JSON.stringify({ role: index % 2 === 0 ? 'assistant' : 'user' })
      })
      insertPart(db, {
        messageId: `eligible-${index}`,
        timeCreated: index,
        data: JSON.stringify({ type: 'text', text: `eligible ${index}` })
      })
    }
    for (const row of [
      { id: 'system', message: JSON.stringify({ role: 'system' }), part: { type: 'text' } },
      { id: 'tool-part', message: JSON.stringify({ role: 'user' }), part: { type: 'tool' } },
      { id: 'bad-message', message: 'malformed JSON', part: { type: 'text' } }
    ]) {
      insertMessage(db, {
        id: row.id,
        sessionId: 'preview-backfill',
        data: row.message
      })
      insertPart(db, {
        messageId: row.id,
        timeCreated: row.id === 'system' ? 6 : row.id === 'tool-part' ? 7 : 8,
        data: JSON.stringify({ ...row.part, text: row.id })
      })
    }
    insertMessage(db, {
      id: 'bad-part',
      sessionId: 'preview-backfill',
      data: JSON.stringify({ role: 'assistant' })
    })
    insertPart(db, { messageId: 'bad-part', timeCreated: 9, data: 'malformed JSON' })
    insertMessage(db, {
      id: 'newest-valid',
      sessionId: 'preview-backfill',
      data: JSON.stringify({ role: 'assistant' })
    })
    insertPart(db, {
      messageId: 'newest-valid',
      timeCreated: 10,
      data: JSON.stringify({ type: 'text', text: 'newest valid' })
    })
    db.close()

    const batched = loadOpenCodeSqliteSessionMetadata({
      dbPath: path,
      sessionIds: ['preview-backfill']
    }).get('preview-backfill')
    const direct = loadOpenCodeSqliteSessionMetadataDirect({
      dbPath: path,
      sessionId: 'preview-backfill'
    })
    expect(batched?.previewRows).toEqual(direct.previewRows)
    expect(batched?.previewRows.map((row) => row.text)).toEqual([
      'eligible 2',
      'eligible 3',
      'eligible 4',
      'eligible 5',
      'newest valid'
    ])
  })
})
