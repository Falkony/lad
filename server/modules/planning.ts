import { z } from 'zod'
import { and, eq, isNull, gte, inArray } from 'drizzle-orm'
import { createError } from 'h3'
import type { WriteTransaction } from '../db'
import { accounts, budgets, plans, planVersions, planOccurrences, transactions } from '../db/schema'
import {
  budgetSchema,
  directionSchema,
  monthSchema,
  planSchema,
} from '../../shared/planning-schemas'
import { pastDate, positiveAmount, revision } from '../../shared/schemas'
import { localDate } from '../../shared/money'
import { addDays, projectOccurrence } from '../../shared/planning'
import type {
  CommandResult,
  Plan,
  PlanFields,
  PlanVersion,
  PlanOccurrence,
} from '../../shared/planning-types'
import type { Transaction } from '../../shared/types'

const dateKey = { planId: z.uuid(), dueDate: z.iso.date(), expectedRevision: revision }
export const planningCommands = [
  z.object({ op: z.literal('budget.set'), data: budgetSchema }),
  z.object({ op: z.literal('budget.delete'), id: z.uuid() }),
  z
    .object({ op: z.literal('budget.copy'), from: monthSchema, to: monthSchema })
    .refine((v) => v.from !== v.to, 'Выберите другой месяц'),
  z.object({
    op: z.literal('plan.save'),
    id: z.uuid().optional(),
    direction: directionSchema.default('expense'),
    data: planSchema,
  }),
  z.object({ op: z.literal('plan.toggle'), id: z.uuid(), active: z.boolean() }),
  z.object({ op: z.literal('plan.delete'), id: z.uuid() }),
  z
    .object({
      op: z.literal('occurrence.confirm'),
      ...dateKey,
      date: pastDate('Дата операции не может быть в будущем'),
      mode: z.enum(['create', 'link']),
      accountId: z.uuid().optional(),
      amount: positiveAmount.optional(),
      transactionId: z.uuid().optional(),
    })
    .superRefine((v, ctx) => {
      if (v.mode === 'create' && (!v.accountId || !v.amount))
        ctx.addIssue({ code: 'custom', message: 'Укажите счёт и фактическую сумму' })
      if (v.mode === 'link' && !v.transactionId)
        ctx.addIssue({ code: 'custom', message: 'Выберите уже записанную операцию' })
    }),
  z.object({ op: z.literal('occurrence.skip'), ...dateKey }),
  z.object({ op: z.literal('occurrence.unskip'), ...dateKey }),
  z.object({
    op: z.literal('occurrence.adjust'),
    ...dateKey,
    date: z.iso.date(),
    amount: positiveAmount,
  }),
] as const
export const planningCommandSchema = z.discriminatedUnion('op', planningCommands)
export type PlanningCommand = z.infer<typeof planningCommandSchema>
export function isPlanningCommand(command: { op: string }): command is PlanningCommand {
  return /^(budget|plan|occurrence)\./.test(command.op)
}

const directionWord = (plan: Pick<Plan, 'direction'>) =>
  plan.direction === 'income' ? 'доходом' : 'расходом'

/** Ends the current settings yesterday; future undecided dates follow the new settings. */
async function closeSchedule(db: WriteTransaction, id: string, today: string) {
  await db
    .delete(planOccurrences)
    .where(
      and(
        eq(planOccurrences.planId, id),
        eq(planOccurrences.status, 'pending'),
        gte(planOccurrences.dueDate, today),
      ),
    )
  const versions = await db
    .select()
    .from(planVersions)
    .where(and(eq(planVersions.planId, id), isNull(planVersions.validTo)))
  for (const version of versions) {
    if (version.validFrom >= today)
      await db.delete(planVersions).where(eq(planVersions.id, version.id))
    else
      await db
        .update(planVersions)
        .set({ validTo: addDays(today, -1) })
        .where(eq(planVersions.id, version.id))
  }
}
async function addSchedule(
  db: WriteTransaction,
  id: string,
  fields: PlanFields,
  validFrom: string,
) {
  await db.insert(planVersions).values({
    id: crypto.randomUUID(),
    planId: id,
    title: fields.title,
    category: fields.category,
    amount: fields.amount,
    accountId: fields.accountId,
    frequency: fields.frequency,
    interval: fields.interval,
    startDate: fields.startDate,
    endDate: fields.endDate,
    note: fields.note,
    monthDays: fields.monthDays,
    holidayShift: fields.holidayShift,
    validFrom,
    validTo: null,
  })
}
async function resolveOccurrence(db: WriteTransaction, planId: string, dueDate: string) {
  const [planRows, versions, occurrences, history] = await Promise.all([
    db.select().from(plans).where(eq(plans.id, planId)),
    db.select().from(planVersions).where(eq(planVersions.planId, planId)),
    db
      .select()
      .from(planOccurrences)
      .where(and(eq(planOccurrences.planId, planId), eq(planOccurrences.dueDate, dueDate))),
    db.select().from(transactions),
  ])
  const plan = planRows[0] as Plan | undefined
  if (!plan) throw createError({ statusCode: 404, message: 'План не найден' })
  const workspace = {
    plans: [plan],
    planVersions: versions as PlanVersion[],
    planOccurrences: occurrences as PlanOccurrence[],
    transactions: history.filter((t) => !t.deletedAt) as Transaction[],
    deletedTransactions: history.filter((t) => t.deletedAt) as Transaction[],
  }
  const item = projectOccurrence(workspace, planId, dueDate)
  // The date by the schedule alone: the original date or the working day before a day off.
  const scheduled =
    projectOccurrence({ ...workspace, planOccurrences: [] }, planId, dueDate)?.date || dueDate
  if (!item)
    throw createError({
      statusCode: 404,
      message: 'Эта дата больше не запланирована. Обновите календарь.',
    })
  return { plan, item, scheduled, existing: occurrences[0], history }
}
export async function executePlanningCommand(
  db: WriteTransaction,
  command: PlanningCommand,
  currentRevision: string,
  /** Internal callers: the owner of a plan they create (an obligation's payment schedule). */
  owner: { source: 'obligation'; sourceId: string } | null = null,
): Promise<CommandResult> {
  switch (command.op) {
    case 'budget.set':
      await db
        .insert(budgets)
        .values({ id: crypto.randomUUID(), ...command.data })
        .onConflictDoUpdate({
          target: [budgets.month, budgets.category],
          set: { limit: command.data.limit },
        })
      break
    case 'budget.delete': {
      const deleted = await db.delete(budgets).where(eq(budgets.id, command.id)).returning()
      if (!deleted.length) throw createError({ statusCode: 404, message: 'Лимит не найден' })
      break
    }
    case 'budget.copy': {
      const source = await db.select().from(budgets).where(eq(budgets.month, command.from))
      let copied = 0
      for (const row of source)
        copied += (
          await db
            .insert(budgets)
            .values({ ...row, id: crypto.randomUUID(), month: command.to })
            .onConflictDoNothing()
            .returning()
        ).length
      return { copied, skipped: source.length - copied }
    }
    case 'plan.save': {
      const previous = command.id
        ? (await db.select().from(plans).where(eq(plans.id, command.id)))[0]
        : null
      if (command.id && !previous) throw createError({ statusCode: 404, message: 'План не найден' })
      if (previous && previous.direction !== command.direction)
        throw createError({
          statusCode: 400,
          message: 'Поступление нельзя превратить в платёж и наоборот. Создайте новый план.',
        })
      if (command.data.accountId) {
        const [account] = await db
          .select()
          .from(accounts)
          .where(eq(accounts.id, command.data.accountId))
        if (!account || (account.archived && previous?.accountId !== account.id))
          throw createError({
            statusCode: 400,
            message: 'Выберите действующий счёт или выбор счёта при подтверждении',
          })
      }
      const once = command.data.frequency === 'once'
      if (previous && (previous.frequency === 'once') !== once)
        throw createError({
          statusCode: 400,
          message: 'Разовый план нельзя сделать регулярным и наоборот. Создайте новый план.',
        })
      const id = command.id || crypto.randomUUID()
      if (!previous) {
        await db.insert(plans).values({
          id,
          ...command.data,
          active: true,
          direction: command.direction,
          source: owner?.source || 'manual',
          sourceId: owner?.sourceId || null,
        })
        await addSchedule(db, id, command.data, command.data.startDate)
      } else if (once) {
        // A one-off plan has a single date: editing replaces it while nothing is confirmed.
        const done = await db
          .select()
          .from(planOccurrences)
          .where(
            and(
              eq(planOccurrences.planId, id),
              inArray(planOccurrences.status, ['paid', 'closed']),
            ),
          )
          .limit(1)
        if (done.length)
          throw createError({
            statusCode: 409,
            message: 'Разовый план уже выполнен. Для новой даты создайте новый план.',
          })
        await db.delete(planOccurrences).where(eq(planOccurrences.planId, id))
        await db.delete(planVersions).where(eq(planVersions.planId, id))
        await db
          .update(plans)
          .set({ ...command.data, active: true })
          .where(eq(plans.id, id))
        await addSchedule(db, id, command.data, command.data.startDate)
      } else {
        await closeSchedule(db, id, localDate())
        await db.update(plans).set(command.data).where(eq(plans.id, id))
        if (previous.active) await addSchedule(db, id, command.data, localDate())
      }
      break
    }
    case 'plan.toggle': {
      const [previous] = await db.select().from(plans).where(eq(plans.id, command.id))
      if (!previous) throw createError({ statusCode: 404, message: 'План не найден' })
      if (previous.frequency === 'once')
        throw createError({
          statusCode: 400,
          message: 'Разовый план не ставится на паузу: отмените или перенесите его дату.',
        })
      if (previous.active === command.active) break
      if (command.active && previous.endDate && previous.endDate < localDate())
        throw createError({
          statusCode: 400,
          message: 'Продлите дату окончания перед возобновлением',
        })
      await closeSchedule(db, command.id, localDate())
      await db.update(plans).set({ active: command.active }).where(eq(plans.id, command.id))
      if (command.active) await addSchedule(db, command.id, previous as PlanFields, localDate())
      break
    }
    case 'plan.delete': {
      const [plan] = await db.select().from(plans).where(eq(plans.id, command.id))
      if (!plan) throw createError({ statusCode: 404, message: 'План не найден' })
      const confirmed = await db
        .select()
        .from(planOccurrences)
        .where(and(eq(planOccurrences.planId, plan.id), eq(planOccurrences.status, 'paid')))
        .limit(1)
      if (confirmed.length)
        throw createError({
          statusCode: 409,
          message:
            plan.frequency === 'once'
              ? 'План уже подтверждён операцией. Удалите операцию, если план не выполнялся.'
              : 'У плана есть подтверждённые даты. Поставьте его на паузу, чтобы сохранить историю.',
        })
      await db.delete(planOccurrences).where(eq(planOccurrences.planId, plan.id))
      await db.delete(planVersions).where(eq(planVersions.planId, plan.id))
      await db.delete(plans).where(eq(plans.id, plan.id))
      break
    }
    case 'occurrence.confirm':
    case 'occurrence.skip':
    case 'occurrence.unskip':
    case 'occurrence.adjust': {
      const { plan, item, scheduled, existing, history } = await resolveOccurrence(
        db,
        command.planId,
        command.dueDate,
      )
      // Repeating the same confirmation or cancellation is harmless and needs no fresh revision.
      if (command.op === 'occurrence.confirm' && item.status === 'paid')
        return { alreadyPaid: true, transactionId: item.transactionId! }
      if (command.op === 'occurrence.skip' && item.status === 'skipped') return { ok: true }
      if (currentRevision !== command.expectedRevision)
        throw createError({
          statusCode: 409,
          message: 'Данные изменились. Закройте форму и обновите календарь.',
        })
      const snapshot = {
        id: existing?.id || crypto.randomUUID(),
        planId: item.planId,
        dueDate: item.dueDate,
        title: item.title,
        category: item.category,
        amount: item.amount,
        accountId: item.accountId,
        note: item.note,
        movedTo: item.movedTo,
      }
      const key = [planOccurrences.planId, planOccurrences.dueDate]
      if (command.op === 'occurrence.unskip') {
        if ((item.status !== 'skipped' && item.status !== 'closed') || !existing)
          throw createError({ statusCode: 400, message: 'Эта дата не была отменена' })
        await db
          .update(planOccurrences)
          .set({ status: 'pending', transactionId: null })
          .where(eq(planOccurrences.id, existing.id))
        break
      }
      if (command.op === 'occurrence.adjust') {
        if (item.status !== 'pending')
          throw createError({
            statusCode: 400,
            message: 'Изменить можно только дату, которая ещё ждёт подтверждения',
          })
        const movedTo = command.date === scheduled ? null : command.date
        await db
          .insert(planOccurrences)
          .values({
            ...snapshot,
            amount: command.amount,
            movedTo,
            status: 'pending',
            transactionId: null,
          })
          .onConflictDoUpdate({ target: key, set: { amount: command.amount, movedTo } })
        break
      }
      if (item.status === 'paid' || item.status === 'deleted')
        throw createError({
          statusCode: 409,
          message:
            item.status === 'deleted'
              ? 'Связанная операция удалена. Восстановите её вместо повторного подтверждения.'
              : 'Дата уже подтверждена',
        })
      if (command.op === 'occurrence.skip') {
        await db
          .insert(planOccurrences)
          .values({ ...snapshot, status: 'skipped', transactionId: null })
          .onConflictDoUpdate({ target: key, set: { status: 'skipped', transactionId: null } })
        break
      }
      let transactionId = command.transactionId
      if (command.mode === 'link') {
        const transaction = history.find((t) => t.id === transactionId)
        if (!transaction || transaction.deletedAt || transaction.kind !== plan.direction)
          throw createError({
            statusCode: 400,
            message: `Выберите действующую операцию, которая является ${directionWord(plan)}`,
          })
        const linked = await db
          .select()
          .from(planOccurrences)
          .where(eq(planOccurrences.transactionId, transactionId!))
        if (linked.length)
          throw createError({
            statusCode: 409,
            message: 'Эта операция уже связана с другим планом',
          })
      } else {
        const [account] = await db
          .select()
          .from(accounts)
          .where(eq(accounts.id, command.accountId!))
        if (!account || account.archived)
          throw createError({ statusCode: 400, message: 'Выберите действующий счёт' })
        transactionId = crypto.randomUUID()
        await db.insert(transactions).values({
          id: transactionId,
          kind: plan.direction,
          amount: command.amount!,
          accountId: account.id,
          category: item.category,
          description: item.title,
          date: command.date,
        })
      }
      await db
        .insert(planOccurrences)
        .values({ ...snapshot, status: 'paid', transactionId: transactionId! })
        .onConflictDoUpdate({
          target: key,
          set: { status: 'paid', transactionId: transactionId! },
        })
      return { transactionId }
    }
  }
  return { ok: true }
}
