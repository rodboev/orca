import type { AiVaultSession } from '../../shared/ai-vault-types'
import {
  addPreviewMessage,
  createAccumulator,
  finalizeSession,
  updateTimeline
} from './session-scanner-accumulator'
import { normalizeTitleText } from './session-scanner-values'
import type { OpenCodeSqliteSessionMetadata } from './session-scanner-types'
import { loadOpenCodeSqliteSessionMetadataDirect } from './session-scanner-opencode-sqlite-metadata'

// Why: OpenCode 1.17.x migrated session storage from per-session JSON files
// to a single SQLite DB at ~/.local/share/opencode/opencode.db. This module
// parses individual sessions from the DB into AiVaultSession objects. The
// discovery layer (listing candidates) lives in
// session-scanner-opencode-sqlite-discovery.ts.

function extractModelId(modelJson: string | null): string | null {
  if (!modelJson) {
    return null
  }
  try {
    const parsed = JSON.parse(modelJson) as unknown
    const record =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null
    if (!record) {
      return null
    }
    // Why: OpenCode 1.17.x stores model as {"id":"glm-5.2","providerID":"..."}.
    // Older schemas used {"modelID":"..."}; accept both.
    return (
      (typeof record.id === 'string' && record.id.trim()) ||
      (typeof record.modelID === 'string' && record.modelID.trim()) ||
      null
    )
  } catch {
    return null
  }
}

/**
 * Parse a single OpenCode session from the SQLite database into an
 * `AiVaultSession`. Reads session metadata (title, cwd, model, tokens, cost)
 * and folds in count/preview metadata loaded by the batched scanner stage.
 * A direct caller without prefetched session metadata falls back to the former
 * guarded per-session queries on a read-only database connection.
 * @param args.dbPath - Absolute path to the opencode.db file.
 * @param args.sessionId - The session ID (primary key in the `session` table).
 * @param args.platform - The platform to use for resume command generation.
 * @param args.metadata - Count and preview rows prefetched in one DB-wide batch.
 * @returns The parsed `AiVaultSession`, or `null` if the session does not exist
 *   or the database lacks the required schema.
 */
export async function parseOpenCodeSqliteSession(args: {
  dbPath: string
  sessionId: string
  platform: NodeJS.Platform
  metadata?: OpenCodeSqliteSessionMetadata
}): Promise<AiVaultSession | null> {
  const { dbPath, sessionId, platform } = args
  const metadata = args.metadata ?? loadOpenCodeSqliteSessionMetadataDirect({ dbPath, sessionId })
  if (metadata.sessionRow === null) {
    return null
  }
  const row = metadata.sessionRow
  if (!row || row.id !== sessionId) {
    return null
  }

  const mtimeMs =
    typeof row.time_updated === 'number' && row.time_updated > 0
      ? row.time_updated
      : row.time_created
  // Why: discovery uses a synthetic db#session path only for parser routing.
  // The UI's log open/reveal actions need a real filesystem path.
  const accumulator = createAccumulator({
    agent: 'opencode',
    file: {
      path: dbPath,
      mtimeMs,
      modifiedAt: new Date(mtimeMs).toISOString()
    },
    sessionId
  })
  accumulator.title = normalizeTitleText(row.title ?? '')
  accumulator.cwd = row.directory
  accumulator.model = extractModelId(row.model_json)
  accumulator.totalTokens =
    (row.tokens_input ?? 0) + (row.tokens_output ?? 0) + (row.tokens_reasoning ?? 0)
  // Why: the list indicator may use the foreign table's cheap row count;
  // resumability is carried separately so system/malformed-only rows stay empty.
  accumulator.messageCount = metadata.messageCount
  updateTimeline(accumulator, row.time_created)
  updateTimeline(accumulator, row.time_updated)

  for (const previewRow of metadata.previewRows) {
    if (!previewRow.text) {
      continue
    }
    addPreviewMessage(accumulator, {
      role: previewRow.role,
      text: previewRow.text,
      timestamp: previewRow.timeCreated
    })
    if (previewRow.role === 'user' && !accumulator.title) {
      accumulator.title =
        normalizeTitleText(previewRow.summaryTitle ?? '') ||
        normalizeTitleText(previewRow.summaryBody ?? '')
    }
  }

  const session = finalizeSession(accumulator, platform)
  return session ? { ...session, hasConversationMessages: metadata.hasConversationMessages } : null
}
