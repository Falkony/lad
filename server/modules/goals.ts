import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { createError } from 'h3'
import type { WriteTransaction } from '../db'
import { goals, accounts, transactions, categories, plans, planOccurrences } from '../db/schema'
import { goalSchema, pastDate, positiveAmount, revision } from '../../shared/schemas'
import {
  goalFundingSchema,
  fundingOf,
  goalAllocations,
  goalFundingIssues,
} from '../../shared/goals'
import { accountBalance, localDate } from '../../shared/money'
import { monthRange } from '../../shared/planning'
import { planSchema } from '../../shared/planning-schemas'
import { executePlanningCommand } from './planning'
import type { Goal, Account, Transaction } from '../../shared/types'
const fail = (message: string) => createError({ statusCode: 409, message })
const base = { id: z.uuid(), expectedRevision: revision }
const payment = {
  date: pastDate(),
  amount: positiveAmount,
  accountId: z.uuid().optional(),
  transactionId: z.uuid().optional(),
  mode: z.enum(['create', 'link']).default('create'),
}
export const goalCommands = [
  z.object({ op: z.literal('goal.create'), data: goalSchema }),
  z.object({
    op: z.literal('goal.update'),
    id: z.uuid(),
    data: goalSchema,
    expectedRevision: revision.optional(),
  }),
  z.object({ op: z.literal('goal.delete'), id: z.uuid() }),
  z.object({
    op: z.literal('goal.allocate'),
    ...base,
    accountId: z.uuid(),
    amount: positiveAmount,
    action: z.enum(['reserve', 'release']),
    date: pastDate(),
    note: z.string().max(300).default(''),
  }),
  z.object({ op: z.literal('goal.purchase'), ...base, ...payment }),
  z.object({ op: z.literal('goal.refund'), ...base, ...payment }),
  z.object({ op: z.literal('goal.cancel'), ...base }),
] as const
type GoalCommand = z.infer<(typeof goalCommands)[number]>
export const isGoalCommand = (command: { op: string }): command is GoalCommand =>
  command.op.startsWith('goal.')
async function get(db: WriteTransaction, id: string) {
  const [g] = await db.select().from(goals).where(eq(goals.id, id))
  if (!g) throw createError({ statusCode: 404, message: 'Цель не найдена' })
  return g as Goal
}
function release(goal: Goal, note: string) {
  const funding = structuredClone(fundingOf(goal))
  funding.unassigned = '0'
  for (const [accountId, amount] of goalAllocations(goal))
    if (amount > 0n)
      funding.entries.push({
        id: crypto.randomUUID(),
        accountId,
        amount: (-amount).toString(),
        date: localDate(),
        note,
      })
  return funding
}
async function linkPurchase(db: WriteTransaction, goal: Goal, transactionId: string) {
  const [tx] = await db.select().from(transactions).where(eq(transactions.id, transactionId))
  if (!tx || tx.deletedAt || tx.kind !== 'expense') throw fail('Выберите действующий расход')
  const all = await db.select().from(goals)
  if (all.some((g) => fundingOf(g).purchases.some((p) => p.transactionId === transactionId)))
    throw fail('Покупка уже связана с целью')
  const last = fundingOf(goal).purchases.at(-1)
  if (last) {
    const history = await db.select().from(transactions)
    const original = history.find((t) => t.id === last.transactionId && !t.deletedAt)
    const refunded = history
      .filter((t) => last.refundIds.includes(t.id) && !t.deletedAt)
      .reduce((s, t) => s + BigInt(t.amount), 0n)
    if (original && refunded < BigInt(original.amount))
      throw fail('Сначала завершите возврат прежней покупки')
  }
  const funding = release(goal, 'Резерв использован на покупку')
  funding.purchases.push({ transactionId, refundIds: [] })
  await db
    .update(goals)
    .set({ status: 'done', saved: funding.unassigned, funding })
    .where(eq(goals.id, goal.id))
}
export async function afterGoalConfirm(
  db: WriteTransaction,
  planId: string,
  transactionId: string,
) {
  const [plan] = await db.select().from(plans).where(eq(plans.id, planId))
  if (plan?.source === 'goal' && plan.sourceId)
    await linkPurchase(db, await get(db, plan.sourceId), transactionId)
}
export async function executeGoalCommand(db: WriteTransaction, c: GoalCommand) {
  if (c.op === 'goal.create') {
    if (c.data.categoryId) {
      const [category] = await db
        .select()
        .from(categories)
        .where(eq(categories.id, c.data.categoryId))
      if (!category || category.archived) throw fail('Выберите действующую категорию')
    }
    if (c.data.status === 'done') throw fail('Завершите цель через запись покупки')
    await db.insert(goals).values({
      id: crypto.randomUUID(),
      ...c.data,
      funding: { unassigned: c.data.saved, entries: [], purchases: [] },
    })
    return { ok: true }
  }
  const goal = await get(db, c.id),
    funding = structuredClone(fundingOf(goal))
  if (c.op === 'goal.update') {
    if (c.data.categoryId && c.data.categoryId !== goal.categoryId) {
      const [category] = await db
        .select()
        .from(categories)
        .where(eq(categories.id, c.data.categoryId))
      if (!category || category.archived) throw fail('Выберите действующую категорию')
    }
    if (c.data.status === 'done' && goal.status !== 'done')
      throw fail('Завершите цель через запись покупки')
    if (goal.status === 'done' && c.data.status !== 'done')
      throw fail('Для изменения покупки запишите возврат или отмену')
    if (c.data.status === 'cancelled' && goal.status !== 'cancelled')
      throw fail('Используйте отмену с освобождением резервов')
    const allocated = [...goalAllocations(goal).values()].reduce((s, a) => s + a, 0n)
    const unassigned = BigInt(c.data.saved) - allocated
    if (unassigned < 0n) throw fail('Сначала освободите резерв по счетам')
    funding.unassigned = unassigned.toString()
    await db
      .update(goals)
      .set({ ...c.data, funding })
      .where(eq(goals.id, c.id))
  } else if (c.op === 'goal.delete') {
    if (funding.entries.length || funding.purchases.length)
      throw fail('Цель с историей сохранена: используйте отмену')
    const related = await db.select().from(plans).where(eq(plans.sourceId, c.id))
    if (related.length) throw fail('Отмените запланированную цель перед удалением')
    await db.delete(goals).where(eq(goals.id, c.id))
  } else if (c.op === 'goal.allocate') {
    if (['done', 'cancelled'].includes(goal.status))
      throw fail('Для этой цели резервирование закрыто')
    const [a] = await db.select().from(accounts).where(eq(accounts.id, c.accountId))
    if (!a || a.archived || a.kind === 'credit')
      throw fail('Выберите действующий счёт собственных денег')
    funding.entries.push({
      id: crypto.randomUUID(),
      accountId: c.accountId,
      amount: (BigInt(c.amount) * (c.action === 'reserve' ? 1n : -1n)).toString(),
      date: c.date,
      note: c.note,
    })
    if (c.action === 'reserve')
      funding.unassigned = (
        BigInt(funding.unassigned) > BigInt(c.amount)
          ? BigInt(funding.unassigned) - BigInt(c.amount)
          : 0n
      ).toString()
    await db
      .update(goals)
      .set({ funding, status: goal.status === 'wish' ? 'saving' : goal.status })
      .where(eq(goals.id, c.id))
  } else if (c.op === 'goal.cancel') {
    const next = release(goal, 'Цель отменена')
    await db
      .update(goals)
      .set({ funding: next, saved: next.unassigned, status: 'cancelled' })
      .where(eq(goals.id, c.id))
  } else {
    const history = await db.select().from(transactions)
    let transactionId = c.transactionId
    const kind = c.op === 'goal.purchase' ? 'expense' : 'income'
    if (c.mode === 'link') {
      const t = history.find((t) => t.id === transactionId && !t.deletedAt && t.kind === kind)
      if (!t || t.amount !== c.amount) throw fail('Выберите действующую операцию с той же суммой')
      const all = await db.select().from(goals)
      if (all.some((g) => fundingOf(g).purchases.some((p) => p.refundIds.includes(t.id))))
        throw fail('Возврат уже связан с целью')
    } else {
      const [a] = await db
        .select()
        .from(accounts)
        .where(eq(accounts.id, c.accountId || ''))
      if (!a || a.archived) throw fail('Выберите действующий счёт')
      const category = goal.categoryId
        ? (await db.select().from(categories).where(eq(categories.id, goal.categoryId)))[0]?.name
        : 'Покупки'
      transactionId = crypto.randomUUID()
      await db.insert(transactions).values({
        id: transactionId,
        kind,
        amount: c.amount,
        accountId: a.id,
        category: category || 'Покупки',
        description: goal.title,
        date: c.date,
      })
    }
    if (c.op === 'goal.purchase') await linkPurchase(db, goal, transactionId!)
    else {
      const last = funding.purchases.at(-1)
      if (!last) throw fail('Сначала свяжите покупку с целью')
      const original = history.find((t) => t.id === last.transactionId && !t.deletedAt)
      if (!original) throw fail('Исходная покупка удалена')
      const refunded = history
        .filter((t) => last.refundIds.includes(t.id) && !t.deletedAt)
        .reduce((s, t) => s + BigInt(t.amount), 0n)
      if (refunded + BigInt(c.amount) > BigInt(original.amount))
        throw fail('Возврат превышает стоимость покупки')
      last.refundIds.push(transactionId!)
      await db
        .update(goals)
        .set({
          funding,
          status: refunded + BigInt(c.amount) === BigInt(original.amount) ? 'saving' : goal.status,
        })
        .where(eq(goals.id, c.id))
    }
    return { transactionId }
  }
  return { ok: true }
}
export async function syncGoals(db: WriteTransaction, revision: string) {
  const list = await db.select().from(goals),
    allAccounts = await db.select().from(accounts),
    history = await db.select().from(transactions),
    catalogue = await db.select().from(categories)
  const reserved = new Map<string, bigint>()
  const issues = goalFundingIssues({
    goals: list as Goal[],
    accounts: allAccounts as Account[],
    transactions: history.filter((t) => !t.deletedAt) as Transaction[],
    deletedTransactions: history.filter((t) => !!t.deletedAt) as Transaction[],
    categories: catalogue,
  })
  if (issues.length) throw fail(issues[0]!)
  for (const row of list) {
    const goal = row as Goal,
      funding = goalFundingSchema.parse(fundingOf(goal))
    let saved = BigInt(funding.unassigned)
    if (goal.categoryId && !catalogue.some((c) => c.id === goal.categoryId))
      throw fail('Категория цели не найдена')
    for (const [id, amount] of goalAllocations(goal)) {
      if (amount < 0n) throw fail('Нельзя изъять больше резерва цели')
      const a = allAccounts.find((a) => a.id === id)
      if (!a) throw fail('Счёт резерва не найден')
      if (amount > 0n && (a.archived || a.kind === 'credit'))
        throw fail('Освободите резерв перед архивацией или изменением счёта')
      reserved.set(id, (reserved.get(id) || 0n) + amount)
      saved += amount
    }
    if (saved > 9000000000000000n) throw fail('Слишком большая сумма накоплений')
    let status = goal.status
    const purchase = funding.purchases.at(-1)
    if (purchase) {
      const tx = history.find((t) => t.id === purchase.transactionId)
      if (!tx || tx.kind !== 'expense') throw fail('Нарушена связь покупки с расходом')
      let refunded = 0n
      for (const id of purchase.refundIds) {
        const refund = history.find((t) => t.id === id)
        if (!refund || refund.kind !== 'income') throw fail('Нарушена связь возврата')
        if (!refund.deletedAt) refunded += BigInt(refund.amount)
      }
      if (refunded > BigInt(tx.amount)) throw fail('Возвраты превышают покупку')
      if (status !== 'cancelled')
        status = tx.deletedAt
          ? 'planned'
          : refunded === BigInt(tx.amount)
            ? status === 'done'
              ? 'saving'
              : status
            : 'done'
    }
    await db
      .update(goals)
      .set({ saved: saved.toString(), status, funding })
      .where(eq(goals.id, goal.id))
    const [plan] = await db.select().from(plans).where(eq(plans.sourceId, goal.id))
    const needed = status === 'planned' && !!goal.purchaseMonth && !!goal.categoryId
    if (needed) {
      const category = catalogue.find((c) => c.id === goal.categoryId)!
      const range = monthRange(goal.purchaseMonth!)
      const date =
        goal.deadline && goal.deadline.startsWith(goal.purchaseMonth!) ? goal.deadline : range.to
      const data = planSchema.parse({
        title: goal.title,
        category: category.name,
        amount: goal.target,
        frequency: 'custom',
        startDate: date,
        endDate: date,
        customDates: [{ date, amount: goal.target }],
      })
      if (
        !plan ||
        !plan.active ||
        plan.amount !== data.amount ||
        plan.startDate !== date ||
        plan.category !== data.category
      ) {
        if (plan && !plan.active)
          await db.update(plans).set({ active: true }).where(eq(plans.id, plan.id))
        await executePlanningCommand(
          db,
          { op: 'plan.save', id: plan?.id, direction: 'expense', data },
          revision,
          { source: 'goal', sourceId: goal.id },
        )
      }
    } else if (plan && plan.active) {
      const paid = await db
        .select()
        .from(planOccurrences)
        .where(eq(planOccurrences.planId, plan.id))
      if (paid.some((o) => o.status === 'paid'))
        await executePlanningCommand(
          db,
          { op: 'plan.toggle', id: plan.id, active: false },
          revision,
        )
      else await executePlanningCommand(db, { op: 'plan.delete', id: plan.id }, revision)
    }
  }
  for (const [id, amount] of reserved) {
    const a = allAccounts.find((a) => a.id === id)!
    if (amount > 0n && amount > BigInt(accountBalance(a as Account, history as Transaction[])))
      throw fail(
        'Денег на счёте недостаточно для всех резервов. Освободите резерв перед расходом или переводом',
      )
  }
}
