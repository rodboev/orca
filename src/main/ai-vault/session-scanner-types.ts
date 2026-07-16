import type { AiVaultAgent } from '../../shared/ai-vault-types'
import type {
  AiVaultScanIssue,
  AiVaultSession,
  AiVaultSessionPreviewMessage
} from '../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../shared/execution-host'

export type AiVaultScanOptions = {
  claudeProjectsDir?: string
  codexSessionsDir?: string
  additionalCodexSessionsDirs?: readonly string[]
  wslHomeDirs?: readonly string[]
  geminiSessionsDir?: string
  copilotSessionsDir?: string
  cursorProjectsDir?: string
  opencodeStorageDir?: string
  // Why: OpenCode 1.17.x stores sessions in SQLite; tests inject a temp DB
  // here so they don't depend on the real ~/.local/share/opencode.
  opencodeDbPaths?: readonly string[]
  grokSessionsDir?: string
  devinTranscriptsDir?: string
  hermesSessionsDir?: string
  rovoSessionsDir?: string
  openclawStateDir?: string
  openclawLegacyStateDir?: string
  piSessionsDir?: string
  ompSessionsDir?: string
  droidSessionsDir?: string
  droidProjectsDir?: string
  kimiSessionsDir?: string
  limit?: number
  limitPerAgent?: number
  // Active workspace/project paths whose sessions must be included regardless of
  // the recency cap (see discoverInScopeClaudeFiles).
  scopePaths?: readonly string[]
  platform?: NodeJS.Platform
  executionHostId?: ExecutionHostId
}

export type FileWithMtime = {
  path: string
  mtimeMs: number
  modifiedAt: string
  // Present when discovery statted the file; lets the parse cache detect
  // unchanged/truncated files without a second stat. Synthetic candidates
  // (OpenCode SQLite rows, remote files) omit it.
  sizeBytes?: number
}

export type SessionFileCandidate = {
  agent: AiVaultAgent
  file: FileWithMtime
  codexHome: string | null
  // SQLite message/part metadata is prefetched once per DB so parsing many
  // OpenCode rows never turns into one full-table scan per visible session.
  opencodeSqliteMetadata?: OpenCodeSqliteSessionMetadata
}

export type OpenCodeSqlitePreviewMetadata = {
  role: AiVaultSessionPreviewMessage['role']
  // Normalized before batching retains the row so large foreign JSON blobs do
  // not accumulate in memory across the visible-session frontier.
  text: string | null
  timeCreated: number
  summaryTitle: string | null
  summaryBody: string | null
}

export type OpenCodeSqliteSessionMetadata = {
  sessionRow?: OpenCodeSqliteSessionRowMetadata | null
  messageCount: number
  // Exact user/assistant evidence used for resumability when messageCount is
  // deliberately a blob-free foreign-table row-count indicator.
  hasConversationMessages: boolean
  // Chronological, matching the accumulator's preview ring-buffer contract.
  previewRows: readonly OpenCodeSqlitePreviewMetadata[]
}

export type OpenCodeSqliteSessionRowMetadata = {
  id: string
  title: string | null
  directory: string | null
  time_created: number
  time_updated: number
  model_json: string | null
  agent: string | null
  tokens_input: number
  tokens_output: number
  tokens_reasoning: number
  tokens_cache_read: number
  cost: number
}

export type SessionFileDiscovery = {
  agent: AiVaultAgent
  rootDir: string
  files: FileWithMtime[]
}

export type SessionParseResult = {
  session: AiVaultSession | null
  issue: AiVaultScanIssue | null
}

export type ResumableParseFinalizeOptions = {
  executionHostId?: ExecutionHostId
  executionHostPlatform?: NodeJS.Platform | null
}

// One in-progress parse of an append-only transcript, resumable across scans.
// The parse cache stores a state per file and feeds it only newly appended
// lines; `clone` must deep-copy anything `consumeLine` mutates so a failed
// read or a display-only trailing line can never corrupt the cached fold.
export type ResumableSessionParseState = {
  consumeLine(line: string): void
  clone(): ResumableSessionParseState
  // Refresh per-scan file metadata (mtime display string) without re-parsing.
  touchFile(file: FileWithMtime): void
  finalize(
    platform: NodeJS.Platform,
    options?: ResumableParseFinalizeOptions
  ): Promise<AiVaultSession | null> | AiVaultSession | null
}

export type SessionAccumulator = {
  agent: AiVaultAgent
  sessionId: string
  title: string | null
  fallbackTitle: string | null
  cwd: string | null
  branch: string | null
  model: string | null
  filePath: string
  createdAt: string | null
  updatedAt: string | null
  modifiedAt: string
  messageCount: number
  totalTokens: number
  previewMessages: AiVaultSessionPreviewMessage[]
  // Recoverable signal for a zero-turn transcript (see AiVaultSession).
  queuedMessageCount: number
  subagentTranscriptCount: number
  latestTimestampMs: number
}

export type CodexUsageSnapshot = {
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
}
