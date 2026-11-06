import { z } from 'zod'
import {
  accountSchema,
  transactionSchema,
  goalSchema,
  eventSchema,
  shoppingSchema,
  obligationSchema,
  signedAmount,
} from './schemas'
import type { Workspace } from './types'
import {
  budgetSchema,
  recurringSchema,
  recurringVersionSchema,
  occurrenceSchema,
} from './planning-schemas'

const timestamp = z
  .string()
  .max(40)
  .refine(
    (value) =>
      /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/.test(value) && Number.isFinite(Date.parse(value)),
    'Некорректное время записи',
  )
const account = accountSchema.extend({ id: z.uuid(), archived: z.boolean().default(false) })
const transaction = z
  .object({
    ...transactionSchema.shape,
    id: z.uuid(),
    kind: z.enum(['expense', 'income', 'transfer', 'adjustment']),
    amount: signedAmount,
    // Stored history is restored as is: "not in the future" applies to new input only.
    date: z.iso.date(),
    createdAt: timestamp,
    deletedAt: timestamp.nullable().default(null),
    importAccountId: z.uuid().nullable().default(null),
  })
  .superRefine((row, ctx) => {
    if (row.kind === 'transfer' && (!row.toAccountId || row.toAccountId === row.accountId))
      ctx.addIssue({
        code: 'custom',
        message: 'Некорректный перевод между счетами',
        path: ['toAccountId'],
      })
    if (!/^-?\d+$/.test(row.amount)) return
    if (row.kind === 'adjustment' ? BigInt(row.amount) === 0n : BigInt(row.amount) <= 0n)
      ctx.addIssue({ code: 'custom', message: 'Некорректная сумма операции', path: ['amount'] })
    if (row.kind !== 'transfer' && row.toAccountId !== null)
      ctx.addIssue({
        code: 'custom',
        message: 'У этой операции не должно быть второго счёта',
        path: ['toAccountId'],
      })
  })
export const backupSchema = z
  .object({
    version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    exportedAt: z.iso.datetime(),
    accounts: z.array(account).max(1000),
    transactions: z.array(transaction).max(50000),
    deletedTransactions: z.array(transaction).max(50000).default([]),
    goals: z.array(goalSchema.extend({ id: z.uuid() })).max(10000),
    events: z.array(eventSchema.extend({ id: z.uuid() })).max(20000),
    shopping: z.array(shoppingSchema.extend({ id: z.uuid() })).max(10000),
    obligations: z.array(obligationSchema.extend({ id: z.uuid() })).max(10000),
    isDemo: z.boolean().default(false),
    budgets: z
      .array(budgetSchema.extend({ id: z.uuid() }))
      .max(20000)
      .default([]),
    recurringPayments: z
      .array(recurringSchema.safeExtend({ id: z.uuid(), active: z.boolean() }))
      .max(10000)
      .default([]),
    recurringVersions: z.array(recurringVersionSchema).max(50000).default([]),
    paymentOccurrences: z.array(occurrenceSchema).max(50000).default([]),
  })
  .superRefine((backup, ctx) => {
    for (const key of [
      'accounts',
      'goals',
      'events',
      'shopping',
      'obligations',
      'budgets',
      'recurringPayments',
      'recurringVersions',
      'paymentOccurrences',
    ] as const) {
      const ids = new Set<string>()
      for (const row of backup[key]) {
        if (ids.has(row.id))
          ctx.addIssue({
            code: 'custom',
            message: `Повторяющийся ID в разделе ${key}`,
            path: [key],
          })
        ids.add(row.id)
      }
    }
    const accounts = new Set(backup.accounts.map((a) => a.id)),
      ids = new Set<string>(),
      importKeys = new Set<string>()
    for (const row of [...backup.transactions, ...backup.deletedTransactions]) {
      if (ids.has(row.id))
        ctx.addIssue({
          code: 'custom',
          message: 'Повторяющийся ID операции',
          path: ['transactions'],
        })
      ids.add(row.id)
      if (
        !accounts.has(row.accountId) ||
        (row.toAccountId && !accounts.has(row.toAccountId)) ||
        (row.importAccountId && !accounts.has(row.importAccountId))
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Операция ссылается на отсутствующий счёт',
          path: ['transactions'],
        })
      if (row.importKey !== null) {
        const key = `${row.importAccountId || row.accountId}:${row.importKey}`
        if (importKeys.has(key))
          ctx.addIssue({
            code: 'custom',
            message: 'Повторяющийся ключ банковского импорта',
            path: ['transactions'],
          })
        importKeys.add(key)
      }
    }
    if (
      backup.transactions.some((t) => t.deletedAt !== null) ||
      backup.deletedTransactions.some((t) => t.deletedAt === null)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Нарушено разделение действующих и удалённых операций',
        path: ['deletedTransactions'],
      })
    const issue = (message: string) =>
      ctx.addIssue({ code: 'custom', message, path: ['recurringPayments'] })
    const rules = new Map(backup.recurringPayments.map((r) => [r.id, r])),
      allTransactions = new Map(
        [...backup.transactions, ...backup.deletedTransactions].map((t) => [t.id, t]),
      )
    const budgetKeys = new Set<string>(),
      paymentKeys = new Set<string>(),
      linked = new Set<string>()
    for (const b of backup.budgets) {
      const key = `${b.month}:${b.category}`
      if (budgetKeys.has(key)) issue('Дублирующийся лимит категории')
      budgetKeys.add(key)
    }
    for (const row of [
      ...backup.recurringPayments,
      ...backup.recurringVersions,
      ...backup.paymentOccurrences,
    ])
      if (row.accountId && !accounts.has(row.accountId))
        issue('В расписании указан отсутствующий счёт')
    for (const version of backup.recurringVersions)
      if (!rules.has(version.recurringId))
        issue('Версия расписания ссылается на отсутствующий платёж')
    for (const rule of backup.recurringPayments) {
      const versions = backup.recurringVersions
        .filter((v) => v.recurringId === rule.id)
        .sort((a, b) => a.validFrom.localeCompare(b.validFrom))
      const open = versions.filter((v) => !v.validTo)
      if (open.length !== (rule.active ? 1 : 0))
        issue('Нарушена целостность действующего расписания')
      for (let i = 1; i < versions.length; i++)
        if (!versions[i - 1]!.validTo || versions[i]!.validFrom <= versions[i - 1]!.validTo!)
          issue('Периоды расписания пересекаются')
      if (open[0])
        for (const key of [
          'title',
          'category',
          'amount',
          'accountId',
          'frequency',
          'interval',
          'startDate',
          'endDate',
          'note',
        ] as const)
          if (open[0][key] !== rule[key])
            issue('Текущие настройки и расписание платежа не совпадают')
    }
    for (const payment of backup.paymentOccurrences) {
      if (!rules.has(payment.recurringId))
        issue('Отметка оплаты ссылается на отсутствующее расписание')
      const key = `${payment.recurringId}:${payment.dueDate}`
      if (paymentKeys.has(key)) issue('Повторяющаяся отметка одного платежа')
      paymentKeys.add(key)
      if (payment.transactionId) {
        const tx = allTransactions.get(payment.transactionId)
        if (!tx || tx.kind !== 'expense') issue('Оплата должна ссылаться на существующий расход')
        if (linked.has(payment.transactionId)) issue('Один расход связан с несколькими платежами')
        linked.add(payment.transactionId)
      }
    }
  })
export type Backup = z.infer<typeof backupSchema>
// Export must never fail because of one unexpected row: a backup that the restore preview
// flags is better than no backup at all. Full validation happens on restore.
export function createBackup(workspace: Workspace): Backup {
  const { revision: _revision, ...data } = workspace
  return { ...data, version: 3, exportedAt: new Date().toISOString() } as Backup
}
