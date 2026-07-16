import {
  loadOpenCodeSqliteCandidateMetadata,
  type OpenCodeSqliteMetadataLoadFailure
} from './session-scanner-opencode-sqlite-metadata'
import { hasReusableSessionParseCacheEntry } from './session-scanner-parse-cache'
import type { SessionFileCandidate } from './session-scanner-types'

// Why: one pass still covers the normal visible cap, while explicit callers
// with larger limits cannot make retained metadata grow without bound.
const OPENCODE_SQLITE_METADATA_FRONTIER_LIMIT = 1000

export type OpenCodeSqliteMetadataFrontier = { prefetchedThrough: number }

export function createOpenCodeSqliteMetadataFrontier(): OpenCodeSqliteMetadataFrontier {
  return { prefetchedThrough: 0 }
}

/** Prefetch only the bounded recency window the parser is about to consider. */
export function prefetchOpenCodeSqliteMetadataFrontier(args: {
  candidates: SessionFileCandidate[]
  startIndex: number
  remainingSessionSlots: number
  platform: NodeJS.Platform
  frontier: OpenCodeSqliteMetadataFrontier
}): OpenCodeSqliteMetadataLoadFailure[] {
  if (args.startIndex < args.frontier.prefetchedThrough) {
    return []
  }
  const candidateCount = Math.min(
    Math.max(args.remainingSessionSlots, 1),
    OPENCODE_SQLITE_METADATA_FRONTIER_LIMIT
  )
  const endIndex = Math.min(args.candidates.length, args.startIndex + candidateCount)
  args.frontier.prefetchedThrough = endIndex

  const pendingIndexes: number[] = []
  for (let index = args.startIndex; index < endIndex; index += 1) {
    const candidate = args.candidates[index]
    if (
      candidate?.agent === 'opencode' &&
      !candidate.opencodeSqliteMetadata &&
      !hasReusableSessionParseCacheEntry(candidate, args.platform)
    ) {
      pendingIndexes.push(index)
    }
  }
  if (pendingIndexes.length === 0) {
    return []
  }

  const loaded = loadOpenCodeSqliteCandidateMetadata(
    pendingIndexes.map((index) => args.candidates[index]).filter(Boolean)
  )
  pendingIndexes.forEach((candidateIndex, loadedIndex) => {
    const candidate = loaded.candidates[loadedIndex]
    if (candidate) {
      args.candidates[candidateIndex] = candidate
    }
  })
  return loaded.failures
}
