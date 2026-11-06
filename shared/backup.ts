import { goalFundingSchema, fundingOf, goalFundingIssues } from './goals'
import { categorySchema, withCategoryIds } from './categories'
import { transactionSplitSchema, transactionDetailIssues } from './transaction-details'
import { importRuleSchema, importMappingSchema } from './import-workflow'
import { validTimeZone } from './time-zone'
import { z } from 'zod'
import { commandHistoryEntrySchema, type CommandHistoryEntry } from './command-history'
import {
  accountSchema,
  transactionSchema,
  goalSchema,
  eventSchema,
  shoppingSchema,
  obligationSchema,
  signedAmount,
  amount,
} from './schemas'
import type { Workspace } from './types'
import {
  budgetSchema,
  directionSchema,
  planSchema,
  planVersionSchema,
  occurrenceSchema,
} from './planning-schemas'

type Row = Record<string, unknown>
const isRow = (value: unknown): value is Row =>
  !!value && typeof value === 'object' && !Array.isArray(value)
export const backupVersion = 9
export const backupMaxBytes = 25 * 1024 * 1024
const timestamp = z
  .string()
  .max(40)
  .refine(
    (value) =>
      /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/.test(value) && Number.isFinite(Date.parse(value)),
    'Некорректное время записи',
  )
// Copies made before migration 7 have no forecast flag: apply the same default as the migration.
const account = z.preprocess(
  (row) =>
    isRow(row) && row.inForecast === undefined
      ? { ...row, inForecast: row.kind !== 'savings' }
      : row,
  accountSchema.extend({
    id: z.uuid(),
    archived: z.boolean().default(false),
    inForecast: z.boolean(),
  }),
)
const transaction = z
  .object({
    ...transactionSchema.shape,
    id: z.uuid(),
    categoryId: z.uuid(),
    kind: z.enum(['expense', 'income', 'transfer', 'adjustment']),
    amount: signedAmount,
    // Stored history is restored as is: "not in the future" applies to new input only.
    date: z.iso.date(),
    createdAt: timestamp,
    deletedAt: timestamp.nullable().default(null),
    importAccountId: z.uuid().nullable().default(null),
    splits: z.array(transactionSplitSchema).max(50).default([]),
    refundOf: z.uuid().nullable().default(null),
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
const rows = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
/**
 * Copies of versions 1–3 stored recurring payments under other names and kept one-off payments
 * in the calendar. Convert them to the plan model the same way migration 6 converts a database;
 * anything malformed is passed through untouched for the schema to report.
 */
export function upgradeBackup(input: unknown): unknown {
  const upgraded = upgradeObligations(upgradePlans(input))
  const refunds = new Map<string, string>()
  if (isRow(upgraded))
    for (const goal of rows(upgraded.goals))
      if (isRow(goal) && isRow(goal.funding))
        for (const p of rows(goal.funding.purchases))
          if (isRow(p) && typeof p.transactionId === 'string')
            for (const id of rows(p.refundIds))
              if (typeof id === 'string') refunds.set(id, p.transactionId)
  if (isRow(input) && [1, 2, 3, 4, 5, 6, 7, 8].includes(input.version as number) && isRow(upgraded))
    return withCategoryIds({
      ...upgraded,
      transactions: rows(upgraded.transactions).map((t) =>
        isRow(t) && refunds.has(t.id as string)
          ? { ...t, refundOf: refunds.get(t.id as string) }
          : t,
      ),
      deletedTransactions: rows(upgraded.deletedTransactions).map((t) =>
        isRow(t) && refunds.has(t.id as string)
          ? { ...t, refundOf: refunds.get(t.id as string) }
          : t,
      ),
      importKeys:
        upgraded.importKeys ??
        [...rows(upgraded.transactions), ...rows(upgraded.deletedTransactions)]
          .filter((t) => isRow(t) && t.importKey)
          .map((t) => {
            const row = t as Row
            return {
              id: crypto.randomUUID(),
              accountId: row.importAccountId || row.accountId,
              key: row.importKey,
              transactionId: row.id,
              batchId: null,
            }
          }),
      timeZone: upgraded.timeZone || 'Europe/Moscow',
      goals: rows(upgraded.goals).map((g) =>
        isRow(g)
          ? { ...g, funding: g.funding || { unassigned: g.saved, entries: [], purchases: [] } }
          : g,
      ),
      version: backupVersion,
      commandHistory: [5, 6, 7, 8].includes(input.version as number) ? upgraded.commandHistory : [],
    })
  return upgraded
}
/**
 * Copies made before migration 9 store the current balance of an obligation: it becomes the
 * opening balance on the day of the copy, as the migration does with a database.
 */
function upgradeObligations(input: unknown): unknown {
  if (!isRow(input)) return input
  const day =
    typeof input.exportedAt === 'string' && /^\d{4}-\d{2}-\d{2}/.test(input.exportedAt)
      ? input.exportedAt.slice(0, 10)
      : null
  const obligations = rows(input.obligations).map((o) => {
    if (!isRow(o) || o.openingBalance !== undefined) return o
    const { remaining, ...rest } = o
    return { ...rest, openingBalance: remaining, startDate: o.startDate ?? day, accountId: null }
  })
  return { ...input, obligations }
}
function upgradePlans(input: unknown): unknown {
  if (!isRow(input) || ![1, 2, 3].includes(input.version as number)) return input
  const { recurringPayments, recurringVersions, paymentOccurrences, ...rest } = input
  const plans: unknown[] = rows(recurringPayments).map((r) =>
    isRow(r) ? { ...r, direction: 'expense', source: 'manual', sourceId: null } : r,
  )
  const planVersions: unknown[] = rows(recurringVersions).map((v) => {
    if (!isRow(v)) return v
    const { recurringId, ...version } = v
    return { ...version, planId: recurringId }
  })
  const planOccurrences: unknown[] = rows(paymentOccurrences).map((o) => {
    if (!isRow(o)) return o
    const { recurringId, ...occurrence } = o
    return { ...occurrence, planId: recurringId, movedTo: null }
  })
  const events: unknown[] = []
  for (const event of rows(input.events)) {
    if (!isRow(event)) {
      events.push(event)
      continue
    }
    const amount = typeof event.amount === 'string' && /^\d+$/.test(event.amount) && event.amount
    if (event.kind !== 'payment' || !amount || BigInt(amount) === 0n) {
      events.push({ ...event, kind: event.kind === 'note' ? 'note' : 'task', amount: null })
      continue
    }
    const fields = {
      title: event.title,
      category: 'Другое',
      amount,
      accountId: null,
      frequency: 'once',
      interval: 1,
      startDate: event.date,
      endDate: null,
      note: event.note ?? '',
    }
    plans.push({ id: event.id, ...fields, active: true, direction: 'expense', source: 'manual' })
    planVersions.push({
      id: crypto.randomUUID(),
      planId: event.id,
      ...fields,
      validFrom: event.date,
      validTo: null,
    })
    // A payment ticked off in the calendar had no linked expense: keep it as a closed date.
    if (event.done)
      planOccurrences.push({
        id: crypto.randomUUID(),
        planId: event.id,
        dueDate: event.date,
        title: event.title,
        category: 'Другое',
        amount,
        accountId: null,
        note: event.note ?? '',
        status: 'closed',
        transactionId: null,
        movedTo: null,
      })
  }
  return { ...rest, version: backupVersion, events, plans, planVersions, planOccurrences }
}

const obligationEntry = z
  .object({
    id: z.uuid(),
    obligationId: z.uuid(),
    kind: z.enum(['payment', 'adjustment']),
    date: z.iso.date(),
    principal: signedAmount,
    interest: amount.default('0'),
    fees: amount.default('0'),
    transactionId: z.uuid().nullable().default(null),
    early: z.enum(['none', 'term', 'payment']).default('none'),
    previousPayment: amount.nullable().default(null),
    note: z.string().max(300).default(''),
    createdAt: timestamp,
  })
  .refine(
    (e) =>
      e.kind === 'payment'
        ? !e.principal.startsWith('-') &&
          !!e.transactionId &&
          BigInt(e.principal) + BigInt(e.interest) + BigInt(e.fees) > 0n
        : BigInt(e.principal) !== 0n &&
          e.interest === '0' &&
          e.fees === '0' &&
          e.transactionId === null,
    'Некорректная запись погашения',
  )
const plan = planSchema.safeExtend({
  id: z.uuid(),
  categoryId: z.uuid(),
  active: z.boolean(),
  direction: directionSchema,
  source: z.enum(['manual', 'obligation', 'goal', 'credit']).default('manual'),
  sourceId: z.string().max(100).nullable().default(null),
})
const backupObject = z
  .object({
    version: z.literal(backupVersion),
    importRules: z
      .array(importRuleSchema.extend({ id: z.uuid() }))
      .max(10000)
      .default([]),
    importTemplates: z
      .array(z.object({ id: z.uuid(), name: z.string().max(160), mapping: importMappingSchema }))
      .max(1000)
      .default([]),
    importKeys: z
      .array(
        z.object({
          id: z.uuid(),
          accountId: z.uuid(),
          key: z.string().max(300),
          transactionId: z.uuid(),
          batchId: z.uuid().nullable(),
        }),
      )
      .max(100000)
      .default([]),
    importBatches: z
      .array(
        z.object({
          id: z.uuid(),
          createdAt: z.iso.datetime(),
          fileName: z.string().max(200),
          status: z.enum(['applied', 'undone']),
          revision: z.string().regex(/^\d+$/),
          report: z.object({
            imported: z.number().int().nonnegative(),
            skipped: z.number().int().nonnegative(),
            matched: z.number().int().nonnegative(),
            linked: z.number().int().nonnegative(),
            ignored: z.number().int().nonnegative(),
          }),
          records: z
            .array(
              z.object({
                id: z.uuid(),
                accountId: z.uuid(),
                key: z.string().max(300),
                created: z.boolean(),
                snapshot: z.record(z.string(), z.unknown()),
              }),
            )
            .max(2000),
        }),
      )
      .max(10000)
      .default([]),
    categories: z.array(categorySchema).max(10000),
    timeZone: z.string().refine(validTimeZone),
    exportedAt: z.iso.datetime(),
    accounts: z.array(account).max(1000),
    transactions: z.array(transaction).max(50000),
    deletedTransactions: z.array(transaction).max(50000).default([]),
    goals: z.array(goalSchema.extend({ id: z.uuid(), funding: goalFundingSchema })).max(10000),
    events: z.array(eventSchema.extend({ id: z.uuid() })).max(20000),
    shopping: z.array(shoppingSchema.extend({ id: z.uuid() })).max(10000),
    obligations: z.array(obligationSchema.extend({ id: z.uuid() })).max(10000),
    obligationEntries: z.array(obligationEntry).max(50000).default([]),
    isDemo: z.boolean().default(false),
    budgets: z
      .array(budgetSchema.extend({ id: z.uuid(), categoryId: z.uuid() }))
      .max(20000)
      .default([]),
    plans: z.array(plan).max(20000).default([]),
    planVersions: z
      .array(planVersionSchema.safeExtend({ categoryId: z.uuid() }))
      .max(50000)
      .default([]),
    planOccurrences: z
      .array(occurrenceSchema.safeExtend({ categoryId: z.uuid() }))
      .max(50000)
      .default([]),
    commandHistory: z.array(commandHistoryEntrySchema).max(100000),
  })
  .superRefine((backup, ctx) => {
    for (const message of transactionDetailIssues(backup))
      ctx.addIssue({ code: 'custom', message, path: ['transactions'] })
    const aliasKeys = new Set<string>(),
      allTx = [...backup.transactions, ...backup.deletedTransactions]
    for (const key of backup.importKeys) {
      const compound = key.accountId + ':' + key.key
      if (
        aliasKeys.has(compound) ||
        !backup.accounts.some((a) => a.id === key.accountId) ||
        !allTx.some((t) => t.id === key.transactionId) ||
        (key.batchId && !backup.importBatches.some((b) => b.id === key.batchId))
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Нарушены связи ключей импорта',
          path: ['importKeys'],
        })
      aliasKeys.add(compound)
    }
    for (const rule of backup.importRules)
      if (
        !backup.categories.some((c) => c.id === rule.categoryId) ||
        (rule.accountId && !backup.accounts.some((a) => a.id === rule.accountId))
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Нарушены связи правила импорта',
          path: ['importRules'],
        })
    for (const message of goalFundingIssues(backup, true))
      ctx.addIssue({ code: 'custom', message, path: ['goals'] })
    for (const key of [
      'categories',
      'accounts',
      'goals',
      'events',
      'shopping',
      'obligations',
      'obligationEntries',
      'budgets',
      'plans',
      'planVersions',
      'planOccurrences',
      'commandHistory',
      'importRules',
      'importTemplates',
      'importKeys',
      'importBatches',
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
    const categoryIds = new Set(backup.categories.map((c) => c.id))
    for (const section of [
      'transactions',
      'deletedTransactions',
      'budgets',
      'plans',
      'planVersions',
      'planOccurrences',
    ] as const)
      for (const row of backup[section])
        if (!(row as any).categoryId || !categoryIds.has((row as any).categoryId))
          ctx.addIssue({ code: 'custom', message: 'Категория не найдена', path: [section] })
    const revisions = new Set<string>()
    for (const entry of backup.commandHistory) {
      if (!/^[1-9]\d{0,19}$/.test(entry.revision)) continue
      const revision = BigInt(entry.revision).toString()
      if (revisions.has(revision))
        ctx.addIssue({
          code: 'custom',
          message: 'Повторяющаяся ревизия журнала',
          path: ['commandHistory'],
        })
      revisions.add(revision)
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
    const obligations = new Map(backup.obligations.map((o) => [o.id, o])),
      repaid = new Set<string>()
    for (const o of backup.obligations)
      if (o.accountId && !accounts.has(o.accountId))
        ctx.addIssue({
          code: 'custom',
          message: 'Обязательство ссылается на отсутствующий счёт',
          path: ['obligations'],
        })
    const everyTransaction = new Map(
      [...backup.transactions, ...backup.deletedTransactions].map((t) => [t.id, t]),
    )
    for (const entry of backup.obligationEntries) {
      const owner = obligations.get(entry.obligationId)
      const tx = entry.transactionId ? everyTransaction.get(entry.transactionId) : undefined
      const total = BigInt(entry.principal) + BigInt(entry.interest) + BigInt(entry.fees)
      const issue = (message: string) =>
        ctx.addIssue({ code: 'custom', message, path: ['obligationEntries'] })
      if (!owner) issue('Погашение ссылается на отсутствующее обязательство')
      if (entry.transactionId) {
        if (
          !tx ||
          tx.kind !== (owner?.kind === 'receivable' ? 'income' : 'expense') ||
          BigInt(tx.amount) !== total
        )
          issue('Погашение должно ссылаться на операцию того же направления и суммы')
        if (repaid.has(entry.transactionId))
          issue('Одна операция связана с несколькими погашениями')
        repaid.add(entry.transactionId)
      }
    }
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message, path: ['plans'] })
    const plans = new Map(backup.plans.map((p) => [p.id, p])),
      allTransactions = new Map(
        [...backup.transactions, ...backup.deletedTransactions].map((t) => [t.id, t]),
      )
    for (const plan of backup.plans.filter((p) => p.source === 'goal'))
      if (!backup.goals.some((g) => g.id === plan.sourceId))
        issue('План покупки ссылается на отсутствующую цель')
    for (const card of backup.accounts.filter((a) => a.kind === 'credit')) {
      if (BigInt(card.creditSettings.limit) <= 0n)
        issue('Кредитный лимит должен быть положительным')
      const payer = backup.accounts.find((a) => a.id === card.creditSettings.payerAccountId)
      if (
        card.creditSettings.payerAccountId &&
        (!payer || payer.kind === 'credit' || payer.archived)
      )
        issue('Счёт погашения карты недоступен')
    }
    for (const plan of backup.plans.filter((p) => p.source === 'credit'))
      if (!backup.accounts.some((a) => a.id === plan.sourceId && a.kind === 'credit'))
        issue('План погашения ссылается на отсутствующую кредитную карту')
    const budgetKeys = new Set<string>(),
      dateKeys = new Set<string>(),
      linked = new Set<string>()
    for (const b of backup.budgets) {
      const key = `${b.month}:${b.category}`
      if (budgetKeys.has(key)) issue('Дублирующийся лимит категории')
      budgetKeys.add(key)
    }
    for (const row of [...backup.plans, ...backup.planVersions, ...backup.planOccurrences])
      if (row.accountId && !accounts.has(row.accountId)) issue('В плане указан отсутствующий счёт')
    for (const version of backup.planVersions)
      if (!plans.has(version.planId)) issue('Версия плана ссылается на отсутствующий план')
    for (const plan of backup.plans) {
      const versions = backup.planVersions
        .filter((v) => v.planId === plan.id)
        .sort((a, b) => a.validFrom.localeCompare(b.validFrom))
      const open = versions.filter((v) => !v.validTo)
      if (open.length !== (plan.active ? 1 : 0)) issue('Нарушена целостность действующего плана')
      for (let i = 1; i < versions.length; i++)
        if (!versions[i - 1]!.validTo || versions[i]!.validFrom <= versions[i - 1]!.validTo!)
          issue('Периоды плана пересекаются')
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
          if (open[0][key] !== plan[key]) issue('Текущие настройки плана и его версия не совпадают')
    }
    for (const occurrence of backup.planOccurrences) {
      const owner = plans.get(occurrence.planId)
      if (!owner) issue('Отметка даты ссылается на отсутствующий план')
      const key = `${occurrence.planId}:${occurrence.dueDate}`
      if (dateKeys.has(key)) issue('Повторяющаяся отметка одной даты плана')
      dateKeys.add(key)
      if (occurrence.transactionId) {
        const tx = allTransactions.get(occurrence.transactionId)
        if (
          !tx ||
          (owner &&
            (tx.kind !== (owner.source === 'credit' ? 'transfer' : owner.direction) ||
              (owner.source === 'credit' && tx.toAccountId !== owner.sourceId)))
        )
          issue('Подтверждение должно ссылаться на существующую операцию того же направления')
        if (linked.has(occurrence.transactionId))
          issue('Одна операция подтверждает несколько дат плана')
        linked.add(occurrence.transactionId)
      }
    }
  })
export const backupSchema = z.preprocess(upgradeBackup, backupObject)
export type Backup = z.infer<typeof backupObject>
// Export must never fail because of one unexpected row: a backup that the restore preview
// flags is better than no backup at all. Full validation happens on restore.
export function createBackup(
  workspace: Workspace & { commandHistory?: CommandHistoryEntry[] },
): Backup {
  const { revision: _revision, ...data } = workspace
  return withCategoryIds({
    timeZone: workspace.timeZone || 'Europe/Moscow',
    ...data,
    goals: data.goals.map((g) => ({ ...g, funding: fundingOf(g) })),
    commandHistory: workspace.commandHistory || [],
    version: backupVersion,
    exportedAt: new Date().toISOString(),
  }) as Backup
}
