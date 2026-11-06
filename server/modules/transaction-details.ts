import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { createError } from 'h3'
import type { WriteTransaction } from '../db'
import { transactions, categories } from '../db/schema'
import { revision } from '../../shared/schemas'
import {
  transactionSplitSchema,
  transactionDetailIssues,
  expenseParts,
} from '../../shared/transaction-details'
import type { Transaction } from '../../shared/types'
export const detailCommands = [
  z.object({
    op: z.literal('transaction.details'),
    id: z.uuid(),
    expectedRevision: revision,
    splits: z.array(transactionSplitSchema).max(50).optional(),
    refundOf: z.uuid().nullable().optional(),
  }),
] as const
export const isDetailCommand = (c: { op: string }): c is z.infer<(typeof detailCommands)[0]> =>
  c.op === 'transaction.details'
export async function executeDetailCommand(
  db: WriteTransaction,
  c: z.infer<(typeof detailCommands)[0]>,
) {
  const [t] = await db.select().from(transactions).where(eq(transactions.id, c.id))
  if (!t || t.deletedAt) throw createError({ statusCode: 404, message: 'Операция не найдена' })
  await db
    .update(transactions)
    .set({ splits: c.splits, refundOf: c.refundOf })
    .where(eq(transactions.id, c.id))
  return { ok: true }
}
/** Allocate against remaining category amounts, including a deterministic kopeck remainder. */
export async function syncTransactionDetails(db: WriteTransaction) {
  const history = await db.select().from(transactions),
    catalogue = await db.select().from(categories)
  for (const t of history) {
    if (t.splits?.length && !t.refundOf) {
      const splits = t.splits.map((p) => ({
        ...p,
        category: catalogue.find((c) => c.id === p.categoryId)?.name || p.category,
      }))
      await db.update(transactions).set({ splits }).where(eq(transactions.id, t.id))
      t.splits = splits
    }
  }
  for (const original of history.filter((t) => t.kind === 'expense')) {
    const parts = expenseParts(original as Transaction),
      remaining = parts.map((p) => BigInt(p.amount))
    for (const refund of history
      .filter((t) => t.refundOf === original.id && !t.deletedAt)
      .sort(
        (a, b) =>
          a.date.localeCompare(b.date) ||
          a.createdAt.localeCompare(b.createdAt) ||
          a.id.localeCompare(b.id),
      )) {
      const total = remaining.reduce((s, v) => s + v, 0n),
        amount = BigInt(refund.amount)
      if (total < amount)
        throw createError({ statusCode: 409, message: 'Возвраты превышают исходную покупку' })
      const allocation = remaining.map((value) => (value * amount) / total)
      let rest = amount - allocation.reduce((s, v) => s + v, 0n)
      for (let i = 0; rest > 0n && i < allocation.length; i++)
        if (allocation[i]! < remaining[i]!) {
          allocation[i] = allocation[i]! + 1n
          rest--
        }
      const splits = parts
        .map((p, index) => {
          remaining[index] = remaining[index]! - allocation[index]!
          return {
            categoryId: p.categoryId!,
            category: catalogue.find((c) => c.id === p.categoryId)?.name || p.category,
            amount: allocation[index]!.toString(),
          }
        })
        .filter((p) => BigInt(p.amount) > 0n)
      refund.splits = splits
      await db
        .update(transactions)
        .set({ splits, category: original.category })
        .where(eq(transactions.id, refund.id))
    }
  }
  const issues = transactionDetailIssues({
    transactions: history.filter((t) => !t.deletedAt) as Transaction[],
    deletedTransactions: history.filter((t) => !!t.deletedAt) as Transaction[],
    categories: catalogue,
  })
  if (issues.length) throw createError({ statusCode: 409, message: issues[0] })
}
