import { createHash, randomUUID } from 'node:crypto'
import { desc, eq, lt } from 'drizzle-orm'
import { getDb, type WriteTransaction } from '../db'
import { commandHistory, workspaceGuard } from '../db/schema'
import type { Command } from './workspace'
import type { CommandResult } from '../../shared/planning-types'
import type { CommandHistoryPage } from '../../shared/command-history'
import { syncGoals } from './goals'
import { syncCreditCards } from './credit'

export async function finishCommand(
  db: WriteTransaction,
  command: Command,
  result: CommandResult,
  revisionBefore: string,
) {
  await syncCreditCards(db, revisionBefore)
  await syncGoals(db, revisionBefore)
  let base = BigInt(revisionBefore)
  if (command.op === 'workspace.restore')
    for (const entry of command.backup.commandHistory)
      if (BigInt(entry.revision) > base) base = BigInt(entry.revision)
  const revision = (base + 1n).toString()
  const { op, ...payload } = command
  let data: Record<string, unknown> = payload
  if (command.op === 'workspace.restore') {
    const { backup } = command
    data = {
      expectedRevision: command.expectedRevision,
      backup: {
        version: backup.version,
        exportedAt: backup.exportedAt,
        sha256: createHash('sha256').update(JSON.stringify(backup)).digest('hex'),
        counts: Object.fromEntries(
          Object.entries(backup)
            .filter(([, value]) => Array.isArray(value))
            .map(([key, value]) => [key, (value as unknown[]).length]),
        ),
      },
    }
  } else if (command.op === 'workspace.reset') data = {}
  await db.update(workspaceGuard).set({ revision }).where(eq(workspaceGuard.id, 1))
  await db.insert(commandHistory).values({
    id: randomUUID(),
    revision,
    createdAt: new Date().toISOString(),
    operation: op,
    payload: JSON.parse(JSON.stringify(data)),
    result: JSON.parse(JSON.stringify(result)),
  })
  return result
}

export async function readCommandHistory(before?: string, limit = 20): Promise<CommandHistoryPage> {
  const db = await getDb()
  const entries = await db
    .select()
    .from(commandHistory)
    .where(before ? lt(commandHistory.revision, before) : undefined)
    .orderBy(desc(commandHistory.revision))
    .limit(limit + 1)
  const hasMore = entries.length > limit
  const page = entries.slice(0, limit)
  return { entries: page, nextBefore: hasMore ? page.at(-1)!.revision : null }
}
