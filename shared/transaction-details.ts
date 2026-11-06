import { z } from 'zod'
import type { Transaction, Workspace } from './types'
export const transactionSplitSchema = z.object({
  categoryId: z.uuid(),
  category: z.string().max(160).optional(),
  amount: z
    .string()
    .regex(/^\d{1,16}$/)
    .refine((v) => BigInt(v) > 0n && BigInt(v) <= 9000000000000000n),
})
export type TransactionSplit = z.infer<typeof transactionSplitSchema>
export function expenseParts(t: Transaction) {
  return t.splits?.length
    ? t.splits
    : [{ categoryId: t.categoryId, category: t.category, amount: t.amount }]
}
/** A refund reduces expenses in its recorded month; it is excluded from income. */
export function categoryAmounts(t: Transaction) {
  return t.kind === 'expense'
    ? expenseParts(t).map((p) => ({ ...p, amount: BigInt(p.amount) }))
    : t.kind === 'income' && t.refundOf
      ? (t.splits?.length
          ? t.splits
          : [{ categoryId: t.categoryId, category: t.category, amount: t.amount }]
        ).map((p) => ({ ...p, amount: -BigInt(p.amount) }))
      : []
}
export function transactionDetailIssues(
  w: Pick<Workspace, 'transactions' | 'deletedTransactions' | 'categories'>,
) {
  const history = [...w.transactions, ...w.deletedTransactions],
    issues: string[] = []
  for (const t of history) {
    if (t.splits?.length) {
      if (t.kind !== 'expense' && !(t.kind === 'income' && t.refundOf))
        issues.push('Разделить можно расход или возврат')
      if (t.splits.reduce((s, p) => s + BigInt(p.amount), 0n) !== BigInt(t.amount))
        issues.push('Суммы категорий должны совпадать с суммой операции')
      if (new Set(t.splits.map((p) => p.categoryId)).size !== t.splits.length)
        issues.push('Категории разделения повторяются')
      if (t.splits.some((p) => !w.categories?.some((c) => c.id === p.categoryId)))
        issues.push('Категория разделения не найдена')
    }
    if (t.refundOf) {
      const original = history.find((p) => p.id === t.refundOf)
      if (t.kind !== 'income' || !original || original.kind !== 'expense' || t.date < original.date)
        issues.push('Возврат должен ссылаться на более ранний расход')
      if (original && !t.deletedAt && original.deletedAt)
        issues.push('Сначала отмените возврат перед удалением покупки')
    }
  }
  for (const original of history.filter((t) => t.kind === 'expense'))
    if (
      history
        .filter((t) => t.refundOf === original.id && !t.deletedAt)
        .reduce((s, t) => s + BigInt(t.amount), 0n) > BigInt(original.amount)
    )
      issues.push('Возвраты превышают исходную покупку')
  return issues
}
