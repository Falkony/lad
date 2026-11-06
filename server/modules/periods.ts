import { portableRows } from '../../shared/portable'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { eq, desc, and } from 'drizzle-orm'
import { createError } from 'h3'
import { getDb, type WriteTransaction } from '../db'
import {
  accounts,
  transactions,
  budgets,
  plans,
  planVersions,
  planOccurrences,
  obligations,
  obligationEntries,
  categories,
  workspaceGuard,
  budgetHistory,
  reconciliations,
  periodClosures,
  importBatches,
  importKeys,
  goals,
} from '../db/schema'
import { monthSchema } from '../../shared/planning-schemas'
import { revision } from '../../shared/schemas'
import { localDate } from '../../shared/money'
import { monthRange, shiftMonth } from '../../shared/planning'
import { analyzeMonth, compareReports } from '../../shared/analytics'
import { stableJSON, type MonthReport, type Reconciliation } from '../../shared/periods'
import type { Workspace } from '../../shared/types'
const fail = (message: string) => createError({ statusCode: 409, message })
export const periodCommands = [
  z.object({
    op: z.literal('period.close'),
    month: monthSchema,
    expectedRevision: revision,
    allowWarnings: z.boolean().default(false),
    note: z.string().trim().max(1000).default(''),
  }),
  z.object({
    op: z.literal('period.reopen'),
    id: z.uuid(),
    expectedRevision: revision,
    note: z.string().trim().min(1).max(1000),
  }),
  z.object({
    op: z.literal('period.prepare'),
    month: monthSchema,
    expectedRevision: revision,
    categoryIds: z.array(z.uuid()).max(1000).default([]),
  }),
] as const
type PeriodCommand = z.infer<(typeof periodCommands)[number]>
export const isPeriodCommand = (c: { op: string }): c is PeriodCommand => c.op.startsWith('period.')
const digest = (snapshot: unknown) =>
  createHash('sha256').update(stableJSON(snapshot)).digest('hex')
async function load(db: WriteTransaction) {
  const [a, t, b, p, v, o, loans, entries, c, guard, r] = await Promise.all([
    db.select().from(accounts),
    db.select().from(transactions),
    db.select().from(budgets),
    db.select().from(plans),
    db.select().from(planVersions),
    db.select().from(planOccurrences),
    db.select().from(obligations),
    db.select().from(obligationEntries),
    db.select().from(categories),
    db.select().from(workspaceGuard),
    db.select().from(reconciliations),
  ])
  return {
    w: portableRows({
      accounts: a,
      transactions: t.filter((t) => !t.deletedAt),
      deletedTransactions: t.filter((t) => !!t.deletedAt),
      budgets: b,
      plans: p,
      planVersions: v,
      planOccurrences: o,
      obligations: loans,
      obligationEntries: entries,
      categories: c,
      revision: guard[0]!.revision,
      goals: [],
      events: [],
      shopping: [],
      isDemo: false,
    }) as Workspace,
    reconciliations: r as Reconciliation[],
  }
}
export async function syncBudgetHistory(db: WriteTransaction, revision: string, operation: string) {
  const current = await db.select().from(budgets),
    history = await db.select().from(budgetHistory).orderBy(desc(budgetHistory.revision)),
    latest = new Map<string, (typeof history)[number]>()
  for (const row of history) {
    const key = row.month + ':' + row.categoryId
    if (!latest.has(key)) latest.set(key, row)
  }
  const present = new Map(current.map((row) => [row.month + ':' + row.categoryId, row]))
  for (const key of new Set([...latest.keys(), ...present.keys()])) {
    const previous = latest.get(key),
      next = present.get(key)
    if ((previous?.newLimit ?? null) === (next?.limit ?? null)) continue
    await db.insert(budgetHistory).values({
      id: crypto.randomUUID(),
      month: next?.month || previous!.month,
      categoryId: next?.categoryId || previous!.categoryId,
      category: next?.category || previous!.category,
      oldLimit: previous?.newLimit ?? null,
      newLimit: next?.limit ?? null,
      revision,
      createdAt: new Date().toISOString(),
      operation,
    })
  }
}
export async function validatePeriodSnapshots(db: WriteTransaction) {
  for (const row of await db.select().from(periodClosures))
    if (
      digest(row.snapshot) !== row.sha256 ||
      row.snapshot.month !== row.month ||
      row.snapshot.sourceRevision !== row.sourceRevision
    )
      throw fail('Контрольная сумма итога месяца не совпадает')
}
/** Closed facts are edited only after an explicit reopen; future plans remain usable. */
export async function guardClosedPeriods(
  db: WriteTransaction,
  command: { op: string; [key: string]: any },
) {
  if (['workspace.reset', 'workspace.restore', 'period.reopen'].includes(command.op)) return
  const closures = (await db.select().from(periodClosures)).filter((c) => c.status === 'closed'),
    closed = closures.map((c) => c.month)
  if (!closed.length) return
  const dates: string[] = [],
    op = command.op
  if (op === 'period.prepare') dates.push(shiftMonth(command.month, 1))
  let moneyMutation = [
    'transaction.create',
    'transaction.delete',
    'transaction.restore',
    'account.reconcile',
    'shopping.checkout',
    'import',
    'import.undo',
    'goal.purchase',
    'goal.refund',
    'occurrence.confirm',
    'obligation.pay',
    'obligation.payment.update',
    'obligation.payment.cancel',
    'obligation.reconcile',
  ].includes(op)
  if (op === 'demo.load') dates.push(...closed)
  if (['category.rename', 'category.merge'].includes(op)) {
    const [c] = await db.select().from(categories).where(eq(categories.id, command.id))
    if (c)
      dates.push(
        ...closures
          .filter((row) => row.snapshot.categories.some((item) => item.category === c.name))
          .map((row) => row.month),
      )
  }
  if (op === 'account.create' && BigInt(command.data.openingBalance) !== 0n) dates.push(...closed)
  if (op === 'account.update') {
    const [a] = await db.select().from(accounts).where(eq(accounts.id, command.id))
    if (a && (a.openingBalance !== command.data.openingBalance || a.kind !== command.data.kind))
      dates.push(...closed)
  }
  if (['transaction.create', 'transaction.update'].includes(op)) dates.push(command.data.date)
  if (
    [
      'transaction.update',
      'transaction.delete',
      'transaction.restore',
      'transaction.details',
    ].includes(op)
  ) {
    const [t] = await db.select().from(transactions).where(eq(transactions.id, command.id))
    if (t) {
      if (op === 'transaction.update')
        moneyMutation = ['kind', 'amount', 'accountId', 'toAccountId', 'date'].some(
          (key) => (t as any)[key] !== command.data[key],
        )
      dates.push(t.date)
      for (const r of await db.select().from(transactions).where(eq(transactions.refundOf, t.id)))
        dates.push(r.date)
    }
  }
  if (op === 'transactions.categorize')
    for (const id of command.ids) {
      const [t] = await db.select().from(transactions).where(eq(transactions.id, id))
      if (t) {
        dates.push(t.date)
        for (const r of await db.select().from(transactions).where(eq(transactions.refundOf, id)))
          dates.push(r.date)
      }
    }
  if (op === 'account.reconcile' || op === 'shopping.checkout') dates.push(command.data.date)
  if (op === 'import') {
    const keys = await db.select().from(importKeys)
    for (const [index, t] of command.data.transactions.entries()) {
      const choice = command.data.decisions.find((d: any) => d.index === index)
      if (
        keys.some((k) => k.accountId === t.accountId && k.key === t.importKey) ||
        ['match', 'ignore'].includes(choice?.action)
      )
        continue
      dates.push(t.date)
      if (choice?.dueDate) dates.push(choice.dueDate)
    }
  }
  if (op === 'import.undo') {
    const [batch] = await db.select().from(importBatches).where(eq(importBatches.id, command.id))
    if (batch)
      dates.push(...batch.records.filter((r) => r.created).map((r) => String(r.snapshot.date)))
  }
  if (op.startsWith('occurrence.')) {
    dates.push(command.dueDate)
    if (command.date) dates.push(command.date)
    const [o] = await db
      .select()
      .from(planOccurrences)
      .where(
        and(
          eq(planOccurrences.planId, command.planId),
          eq(planOccurrences.dueDate, command.dueDate),
        ),
      )
    if (o?.movedTo) dates.push(o.movedTo)
  }
  if (op === 'budget.set') dates.push(command.data.month)
  if (op === 'budget.copy') dates.push(command.to)
  if (op === 'budget.delete') {
    const [b] = await db.select().from(budgets).where(eq(budgets.id, command.id))
    if (b) dates.push(b.month)
  }
  if (op === 'plan.save') {
    if (!command.id || command.data.frequency === 'once') {
      dates.push(command.data.startDate)
      if (!command.id)
        dates.push(
          ...closed.filter(
            (m) =>
              m >= command.data.startDate.slice(0, 7) &&
              (!command.data.endDate || m <= command.data.endDate.slice(0, 7)),
          ),
        )
    }
    if (command.id) {
      const [p] = await db.select().from(plans).where(eq(plans.id, command.id))
      if (p?.frequency === 'once') dates.push(p.startDate)
    }
  }
  if (op === 'plan.delete') {
    const [p] = await db.select().from(plans).where(eq(plans.id, command.id))
    if (p)
      dates.push(
        ...closed.filter(
          (m) => m >= p.startDate.slice(0, 7) && (!p.endDate || m <= p.endDate.slice(0, 7)),
        ),
      )
  }
  if (op.startsWith('obligation.')) {
    if (command.date) dates.push(command.date)
    if (command.dueDate) dates.push(command.dueDate)
    if (['obligation.payment.update', 'obligation.payment.cancel'].includes(op)) {
      const [entry] = await db
        .select()
        .from(obligationEntries)
        .where(eq(obligationEntries.id, command.id))
      if (entry) dates.push(entry.date)
    }
    if (['obligation.create', 'obligation.update', 'obligation.delete'].includes(op)) {
      const [previous] = command.id
        ? await db.select().from(obligations).where(eq(obligations.id, command.id))
        : []
      const d = command.data || previous
      if (
        d &&
        (!previous ||
          op === 'obligation.delete' ||
          previous.openingBalance !== d.openingBalance ||
          previous.startDate !== d.startDate)
      )
        dates.push(...closed.filter((m) => m >= d.startDate.slice(0, 7)))
    }
  }
  if (['goal.purchase', 'goal.refund'].includes(op)) dates.push(command.date)
  if (
    ['goal.create', 'goal.update'].includes(op) &&
    command.data.status === 'planned' &&
    command.data.purchaseMonth
  )
    dates.push(command.data.purchaseMonth)
  if (['goal.cancel', 'goal.delete', 'goal.update'].includes(op)) {
    const [g] = await db.select().from(goals).where(eq(goals.id, command.id))
    if (g?.status === 'planned' && g.purchaseMonth) dates.push(g.purchaseMonth)
  }
  if (moneyMutation)
    dates.push(...closed.filter((month) => dates.some((date) => date.slice(0, 7) <= month)))
  const blocked = [...new Set(dates.map((d) => d.slice(0, 7)).filter((m) => closed.includes(m)))]
  if (blocked.length)
    throw fail(
      `Сначала откройте закрытый месяц для исправлений: ${blocked.join(', ')}. Начальный остаток меняет всю историю; для нового счёта используйте ноль и сверку на нужную дату.`,
    )
}
export async function executePeriodCommand(
  db: WriteTransaction,
  c: PeriodCommand,
  revisionBefore: string,
) {
  if (c.op === 'period.reopen') {
    const [row] = await db.select().from(periodClosures).where(eq(periodClosures.id, c.id))
    if (!row || row.status !== 'closed') throw fail('Этот итог уже открыт или не найден')
    await db
      .update(periodClosures)
      .set({ status: 'reopened', reopenedAt: new Date().toISOString(), reopenNote: c.note })
      .where(eq(periodClosures.id, c.id))
    return { ok: true }
  }
  if (c.op === 'period.prepare') {
    const next = shiftMonth(c.month, 1)
    const existing = await db.select().from(budgets).where(eq(budgets.month, next))
    const catalogue = await db.select().from(categories)
    let copied = 0
    for (const row of await db.select().from(budgets).where(eq(budgets.month, c.month))) {
      if (
        (c.categoryIds.length && !c.categoryIds.includes(row.categoryId)) ||
        existing.some((b) => b.categoryId === row.categoryId) ||
        catalogue.find((cat) => cat.id === row.categoryId)?.archived
      )
        continue
      await db.insert(budgets).values({ ...row, id: crypto.randomUUID(), month: next })
      copied++
    }
    return { copied }
  }
  if (monthRange(c.month).to >= localDate()) throw fail('Закрыть можно завершившийся месяц')
  const old = await db
    .select()
    .from(periodClosures)
    .where(eq(periodClosures.month, c.month))
    .orderBy(desc(periodClosures.generation))
  if (old[0]?.status === 'closed') throw fail('Месяц уже закрыт')
  const data = await load(db),
    snapshot = analyzeMonth(data.w, c.month, data.reconciliations)
  if (snapshot.issues.length && (!c.allowWarnings || !c.note))
    throw fail(
      'Остались вопросы проверки месяца. Исправьте их или явно укажите причину закрытия с предупреждениями',
    )
  await db.insert(periodClosures).values({
    id: crypto.randomUUID(),
    month: c.month,
    generation: (old[0]?.generation || 0) + 1,
    status: 'closed',
    sourceRevision: revisionBefore,
    revision: (BigInt(revisionBefore) + 1n).toString(),
    createdAt: new Date().toISOString(),
    reopenedAt: null,
    note: c.note,
    reopenNote: '',
    snapshot,
    sha256: digest(snapshot),
  })
  return { ok: true }
}
export async function readPeriodAnalysis(month: string, previous = shiftMonth(month, -1)) {
  const db = await getDb()
  return db.transaction(
    async (tx) => {
      const data = await load(tx),
        closures = await tx
          .select()
          .from(periodClosures)
          .where(eq(periodClosures.month, month))
          .orderBy(desc(periodClosures.generation)),
        prior = await tx
          .select()
          .from(periodClosures)
          .where(eq(periodClosures.month, previous))
          .orderBy(desc(periodClosures.generation))
      const live = analyzeMonth(data.w, month, data.reconciliations),
        report = closures[0]?.status === 'closed' ? closures[0].snapshot : live,
        comparison =
          prior[0]?.status === 'closed'
            ? prior[0].snapshot
            : analyzeMonth(data.w, previous, data.reconciliations)
      return {
        report,
        comparison,
        delta: compareReports(report, comparison),
        revision: data.w.revision,
        closures,
        history: await tx
          .select()
          .from(budgetHistory)
          .where(eq(budgetHistory.month, month))
          .orderBy(desc(budgetHistory.revision))
          .limit(200),
      }
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  )
}
export async function exportPeriod(id: string) {
  const db = await getDb()
  const [row] = await db.select().from(periodClosures).where(eq(periodClosures.id, id))
  if (!row) throw createError({ statusCode: 404, message: 'Итог не найден' })
  if (digest(row.snapshot) !== row.sha256) throw fail('Контрольная сумма итога не совпадает')
  return { format: 'lad-period', version: 1, closure: row }
}
