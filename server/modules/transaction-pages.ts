import { z } from 'zod'
import { and, or, eq, gte, lte, ilike, isNull, isNotNull, desc, sql } from 'drizzle-orm'
import { getDb } from '../db'
import { transactions, workspaceGuard } from '../db/schema'
import type { Transaction } from '../../shared/types'
export const transactionQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  kind: z.enum(['expense', 'income', 'transfer', 'adjustment']).optional(),
  category: z.string().max(160).optional(),
  accountId: z.uuid().optional(),
  transactionId: z.uuid().optional(),
  search: z.string().max(160).default(''),
  deleted: z.enum(['true', 'false']).default('false'),
})
export async function readTransactions(input: unknown) {
  const q = transactionQuerySchema.parse(input),
    db = await getDb()
  return db.transaction(
    async (tx) => {
      const where = and(
        q.deleted === 'true' ? isNotNull(transactions.deletedAt) : isNull(transactions.deletedAt),
        q.month ? ilike(transactions.date, q.month + '-%') : undefined,
        q.from ? gte(transactions.date, q.from) : undefined,
        q.to ? lte(transactions.date, q.to) : undefined,
        q.kind ? eq(transactions.kind, q.kind) : undefined,
        q.category
          ? or(
              eq(transactions.category, q.category),
              sql`exists(select 1 from jsonb_array_elements(${transactions.splits}) p where p->>'category'=${q.category})`,
            )
          : undefined,
        q.accountId
          ? or(eq(transactions.accountId, q.accountId), eq(transactions.toAccountId, q.accountId))
          : undefined,
        q.transactionId ? eq(transactions.id, q.transactionId) : undefined,
        q.search
          ? or(
              ilike(transactions.description, '%' + q.search.replace(/[\\%_]/g, '\\$&') + '%'),
              ilike(transactions.category, '%' + q.search.replace(/[\\%_]/g, '\\$&') + '%'),
            )
          : undefined,
      )
      const [totals] = await tx
        .select({
          count: sql<number>`count(*)::int`,
          income: sql<string>`coalesce(sum(case when kind='income' and refund_of is null then amount else 0 end),0)::text`,
          expense: sql<string>`coalesce(sum(case when kind='expense' then amount when kind='income' and refund_of is not null then -amount else 0 end),0)::text`,
        })
        .from(transactions)
        .where(where)
      const rows = await tx
        .select()
        .from(transactions)
        .where(where)
        .orderBy(desc(transactions.date), desc(transactions.createdAt), desc(transactions.id))
        .limit(q.limit)
        .offset((q.page - 1) * q.limit)
      const [guard] = await tx.select().from(workspaceGuard)
      return {
        rows: rows as Transaction[],
        ...totals!,
        page: q.page,
        limit: q.limit,
        revision: guard!.revision,
      }
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  )
}
