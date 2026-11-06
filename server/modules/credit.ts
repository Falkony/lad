import { eq } from 'drizzle-orm'
import { createError } from 'h3'
import type { WriteTransaction } from '../db'
import { accounts, transactions, plans, planOccurrences } from '../db/schema'
import { creditState } from '../../shared/credit'
import { localDate } from '../../shared/money'
import { firstDueDate, nextDueDate } from '../../shared/obligations'
import { planSchema } from '../../shared/planning-schemas'
import { executePlanningCommand } from './planning'
import type { Account, Transaction } from '../../shared/types'
export async function syncCreditCards(db: WriteTransaction, revision: string) {
  const all = await db.select().from(accounts),
    history = await db.select().from(transactions)
  for (const account of all.filter((a) => a.kind === 'credit')) {
    const state = creditState(account as Account, history as Transaction[])
    if (state.limit <= 0n)
      throw createError({ statusCode: 400, message: 'Укажите кредитный лимит' })
    if (state.available < 0n)
      throw createError({ statusCode: 409, message: 'Кредитный лимит превышен' })
    if (account.archived && state.debt > 0n)
      throw createError({
        statusCode: 409,
        message: 'Погасите долг перед архивацией кредитной карты',
      })
    const c = account.creditSettings as Account['creditSettings']
    const [plan] = await db.select().from(plans).where(eq(plans.sourceId, account.id))
    if (c?.payerAccountId) {
      const payer = all.find((a) => a.id === c.payerAccountId)
      if (!payer || payer.archived || payer.id === account.id || payer.kind === 'credit')
        throw createError({
          statusCode: 400,
          message: 'Выберите действующий счёт собственных денег для погашения',
        })
    }
    if (state.payment <= 0n || account.archived) {
      if (plan) {
        const paid = (
          await db.select().from(planOccurrences).where(eq(planOccurrences.planId, plan.id))
        ).some((o) => o.status === 'paid')
        if (paid) {
          await executePlanningCommand(
            db,
            { op: 'plan.toggle', id: plan.id, active: false },
            revision,
          )
        } else await executePlanningCommand(db, { op: 'plan.delete', id: plan.id }, revision)
      }
      continue
    }
    let date = c?.graceUntil || firstDueDate(localDate(), c?.paymentDay || 20)
    const settled = plan
      ? (await db.select().from(planOccurrences).where(eq(planOccurrences.planId, plan.id))).filter(
          (o) =>
            o.status === 'closed' ||
            (o.status === 'paid' && history.some((t) => t.id === o.transactionId && !t.deletedAt)),
        )
      : []
    while (settled.some((o) => o.dueDate === date)) date = nextDueDate(date, c?.paymentDay || 20)
    const fields = planSchema.parse({
      title: `Погашение: ${account.name}`,
      category: plan?.category || 'Погашение карты',
      amount: state.payment.toString(),
      accountId: c?.payerAccountId || null,
      frequency: 'custom',
      customDates: [{ date, amount: state.payment.toString() }],
      startDate: date,
      endDate: date,
      interval: 1,
    })
    if (
      plan &&
      plan.active &&
      plan.amount === fields.amount &&
      plan.accountId === fields.accountId &&
      JSON.stringify(plan.customDates) === JSON.stringify(fields.customDates)
    )
      continue
    if (plan && !plan.active)
      await db.update(plans).set({ active: true }).where(eq(plans.id, plan.id))
    await executePlanningCommand(
      db,
      { op: 'plan.save', id: plan?.id, direction: 'expense', data: fields },
      revision,
      { source: 'credit', sourceId: account.id },
    )
  }
}
