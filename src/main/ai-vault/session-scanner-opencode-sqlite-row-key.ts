import type SyncDatabase from '../sqlite/sync-database'

export type OpenCodeSqliteLookupKey = string | number
export type OpenCodeSqliteTableLookup = { select: string; predicate: string }

export function openCodeSqliteTableLookup(
  db: SyncDatabase,
  tableName: 'message' | 'part',
  alias: 'm' | 'p'
): OpenCodeSqliteTableLookup | null {
  try {
    db.prepare(`SELECT rowid FROM ${tableName} LIMIT 0`)
    return { select: `${alias}.rowid`, predicate: 'rowid' }
  } catch {
    // WITHOUT ROWID tables may still expose a single-column primary key.
  }
  const primaryKeyColumns = db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all()
    .filter((value) => (value as { pk?: number }).pk)
  if (
    primaryKeyColumns.length === 1 &&
    (primaryKeyColumns[0] as { name?: string } | undefined)?.name === 'id'
  ) {
    return { select: `${alias}.id`, predicate: 'id' }
  }
  return null
}

export function compareOpenCodeSqliteLookupKeys(
  left: OpenCodeSqliteLookupKey,
  right: OpenCodeSqliteLookupKey
): number {
  if (typeof left === 'number' && typeof right === 'number') {
    return left - right
  }
  return String(left).localeCompare(String(right))
}
