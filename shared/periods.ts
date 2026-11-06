import { z } from 'zod'
import type { Transaction } from './types'
import type { ProjectedOccurrence } from './planning-types'
import { transactionSchema, signedAmount, amount } from './schemas'
const moneyValue = z.string().regex(/^-?\d{1,40}$/)
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/)
export interface BudgetChange {
  id: string
  month: string
  categoryId: string
  category: string
  oldLimit: string | null
  newLimit: string | null
  revision: string
  createdAt: string
  operation: string
}
export interface Reconciliation {
  id: string
  accountId: string
  date: string
  balance: string
  revision: string
  createdAt: string
}
export interface MonthReport {
  version: 1
  month: string
  from: string
  to: string
  sourceRevision: string
  income: string
  expenses: string
  net: string
  expectedIncome: string
  expectedPayments: string
  accounts: {
    id: string
    name: string
    opening: string
    closing: string
    reconciled: boolean
    creditDebt: string
  }[]
  categories: {
    category: string
    limit: string | null
    spent: string
    planned: string
    over: string
    transactionIds: string[]
  }[]
  obligations: {
    id: string
    title: string
    kind: string
    opening: string
    closing: string
    principal: string
    interest: string
    fees: string
  }[]
  recurring: { id: string; title: string; source: string; planned: string; actual: string }[]
  issues: {
    code: string
    message: string
    transactionId?: string
    accountId?: string
    planId?: string
    dueDate?: string
  }[]
  inputs: { transactions: Transaction[]; projections: ProjectedOccurrence[] }
}
export interface PeriodClosure {
  id: string
  month: string
  generation: number
  status: 'closed' | 'reopened'
  sourceRevision: string
  revision: string
  createdAt: string
  reopenedAt: string | null
  note: string
  reopenNote: string
  snapshot: MonthReport
  sha256: string
}
export interface PeriodAnalysis {
  report: MonthReport
  comparison: MonthReport
  delta: { income: string; expenses: string; net: string; debtPayments: string }
  revision: string
  closures: PeriodClosure[]
  history: BudgetChange[]
}
export const budgetChangeSchema = z.object({
  id: z.uuid(),
  month: z.string().regex(/^\d{4}-\d{2}$/),
  categoryId: z.uuid(),
  category: z.string().max(160),
  oldLimit: amount.nullable(),
  newLimit: amount.nullable(),
  revision: z.string().regex(/^\d{1,20}$/),
  createdAt: z.iso.datetime(),
  operation: z.string().max(80),
})
export const reconciliationSchema = z.object({
  id: z.uuid(),
  accountId: z.uuid(),
  date: z.iso.date(),
  balance: signedAmount,
  revision: z.string().regex(/^\d{1,20}$/),
  createdAt: z.iso.datetime(),
})
const storedTransaction = z
  .object({
    ...transactionSchema.shape,
    id: z.uuid(),
    categoryId: z.uuid().optional(),
    kind: z.enum(['income', 'expense', 'transfer', 'adjustment']),
    amount: signedAmount,
    date: z.iso.date(),
    createdAt: z.string().max(40),
    deletedAt: z.string().nullable(),
    importAccountId: z.uuid().nullable(),
  })
  .passthrough()
const projection = z
  .object({
    id: z.string().max(100),
    planId: z.uuid(),
    date: z.iso.date(),
    dueDate: z.iso.date(),
    title: z.string(),
    category: z.string(),
    amount: moneyValue,
    accountId: z.uuid().nullable(),
    note: z.string(),
    status: z.enum(['pending', 'paid', 'skipped', 'closed', 'deleted']),
    transactionId: z.uuid().nullable(),
    movedTo: z.iso.date().nullable(),
    direction: z.enum(['expense', 'income']),
    frequency: z.enum(['once', 'monthly', 'weekly', 'yearly', 'custom']),
    actualAmount: moneyValue.nullable(),
    actualDate: z.iso.date().nullable(),
    source: z.enum(['manual', 'obligation', 'credit', 'goal']).optional(),
    creditAccountId: z.uuid().nullable().optional(),
  })
  .passthrough()
export const monthReportSchema = z
  .object({
    version: z.literal(1),
    month,
    from: z.iso.date(),
    to: z.iso.date(),
    sourceRevision: z.string().regex(/^\d{1,20}$/),
    income: moneyValue,
    expenses: moneyValue,
    net: moneyValue,
    expectedIncome: moneyValue,
    expectedPayments: moneyValue,
    accounts: z.array(
      z.object({
        id: z.uuid(),
        name: z.string(),
        opening: moneyValue,
        closing: moneyValue,
        reconciled: z.boolean(),
        creditDebt: moneyValue,
      }),
    ),
    categories: z.array(
      z.object({
        category: z.string(),
        limit: moneyValue.nullable(),
        spent: moneyValue,
        planned: moneyValue,
        over: moneyValue,
        transactionIds: z.array(z.uuid()),
      }),
    ),
    obligations: z.array(
      z.object({
        id: z.uuid(),
        title: z.string(),
        kind: z.string(),
        opening: moneyValue,
        closing: moneyValue,
        principal: moneyValue,
        interest: moneyValue,
        fees: moneyValue,
      }),
    ),
    recurring: z.array(
      z.object({
        id: z.uuid(),
        title: z.string(),
        source: z.string(),
        planned: moneyValue,
        actual: moneyValue,
      }),
    ),
    issues: z.array(
      z.object({
        code: z.string(),
        message: z.string(),
        transactionId: z.uuid().optional(),
        accountId: z.uuid().optional(),
        planId: z.uuid().optional(),
        dueDate: z.iso.date().optional(),
      }),
    ),
    inputs: z.object({
      transactions: z.array(storedTransaction),
      projections: z.array(projection),
    }),
  })
  .passthrough()
  .refine((v) => BigInt(v.income) - BigInt(v.expenses) === BigInt(v.net), 'Итог месяца не сходится')
export const periodClosureSchema = z.object({
  id: z.uuid(),
  month,
  generation: z.number().int().positive(),
  status: z.enum(['closed', 'reopened']),
  sourceRevision: z.string().regex(/^\d{1,20}$/),
  revision: z.string().regex(/^\d{1,20}$/),
  createdAt: z.iso.datetime(),
  reopenedAt: z.iso.datetime().nullable(),
  note: z.string().max(1000),
  reopenNote: z.string().max(1000),
  snapshot: monthReportSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
})
export function stableJSON(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stableJSON).join(',') + ']'
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => JSON.stringify(k) + ':' + stableJSON(v))
        .join(',') +
      '}'
    )
  return JSON.stringify(value) ?? 'null'
}
