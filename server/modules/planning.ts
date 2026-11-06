import { z } from 'zod'
import { and, eq, isNull, gte } from 'drizzle-orm'
import { createError } from 'h3'
import type { WriteTransaction } from '../db'
import {
  accounts,
  budgets,
  recurringPayments,
  recurringVersions,
  paymentOccurrences,
  transactions,
} from '../db/schema'
import { budgetSchema, monthSchema, recurringSchema } from '../../shared/planning-schemas'
import { positiveAmount } from '../../shared/schemas'
import { localDate } from '../../shared/money'
import { addDays, projectPayments } from '../../shared/planning'
import type {
  CommandResult,
  RecurringFields,
  RecurringVersion,
  PaymentOccurrence,
} from '../../shared/planning-types'
import type { Transaction } from '../../shared/types'

const paymentKey = { recurringId: z.uuid(), dueDate: z.iso.date() }
const revision = z.string().regex(/^\d{1,20}$/)
export const planningCommands = [
  z.object({ op: z.literal('budget.set'), data: budgetSchema }),
  z.object({ op: z.literal('budget.delete'), id: z.uuid() }),
  z
    .object({ op: z.literal('budget.copy'), from: monthSchema, to: monthSchema })
    .refine((v) => v.from !== v.to, 'Выберите другой месяц'),
  z.object({ op: z.literal('recurring.save'), id: z.uuid().optional(), data: recurringSchema }),
  z.object({ op: z.literal('recurring.toggle'), id: z.uuid(), active: z.boolean() }),
  z
    .object({
      op: z.literal('payment.pay'),
      ...paymentKey,
      expectedRevision: revision,
      date: z.iso.date().refine((d) => d <= localDate(), 'Дата оплаты не может быть в будущем'),
      mode: z.enum(['create', 'link']),
      accountId: z.uuid().optional(),
      amount: positiveAmount.optional(),
      transactionId: z.uuid().optional(),
    })
    .superRefine((v, ctx) => {
      if (v.mode === 'create' && (!v.accountId || !v.amount))
        ctx.addIssue({ code: 'custom', message: 'Укажите счёт и фактическую сумму' })
      if (v.mode === 'link' && !v.transactionId)
        ctx.addIssue({ code: 'custom', message: 'Выберите уже записанный расход' })
    }),
  z.object({ op: z.literal('payment.skip'), ...paymentKey, expectedRevision: revision }),
  z.object({ op: z.literal('payment.unskip'), ...paymentKey, expectedRevision: revision }),
] as const
export const planningCommandSchema = z.discriminatedUnion('op', planningCommands)
export type PlanningCommand = z.infer<typeof planningCommandSchema>
export function isPlanningCommand(command: { op: string }): command is PlanningCommand {
  return /^(budget\.|recurring\.|payment\.)/.test(command.op)
}

async function closeSchedule(db: WriteTransaction, id: string, today: string) {
  await db
    .delete(paymentOccurrences)
    .where(
      and(
        eq(paymentOccurrences.recurringId, id),
        eq(paymentOccurrences.status, 'pending'),
        gte(paymentOccurrences.dueDate, today),
      ),
    )
  const versions = await db
    .select()
    .from(recurringVersions)
    .where(and(eq(recurringVersions.recurringId, id), isNull(recurringVersions.validTo)))
  for (const version of versions) {
    if (version.validFrom >= today)
      await db.delete(recurringVersions).where(eq(recurringVersions.id, version.id))
    else
      await db
        .update(recurringVersions)
        .set({ validTo: addDays(today, -1) })
        .where(eq(recurringVersions.id, version.id))
  }
}
async function addSchedule(
  db: WriteTransaction,
  id: string,
  fields: RecurringFields,
  validFrom: string,
) {
  await db.insert(recurringVersions).values({
    id: crypto.randomUUID(),
    recurringId: id,
    title: fields.title,
    category: fields.category,
    amount: fields.amount,
    accountId: fields.accountId,
    frequency: fields.frequency,
    interval: fields.interval,
    startDate: fields.startDate,
    endDate: fields.endDate,
    note: fields.note,
    validFrom,
    validTo: null,
  })
}
async function resolvePayment(db: WriteTransaction, recurringId: string, dueDate: string) {
  const [versions, occurrences, history] = await Promise.all([
    db.select().from(recurringVersions).where(eq(recurringVersions.recurringId, recurringId)),
    db
      .select()
      .from(paymentOccurrences)
      .where(
        and(
          eq(paymentOccurrences.recurringId, recurringId),
          eq(paymentOccurrences.dueDate, dueDate),
        ),
      ),
    db.select().from(transactions),
  ])
  const payment = projectPayments(
    {
      recurringVersions: versions as RecurringVersion[],
      paymentOccurrences: occurrences as PaymentOccurrence[],
      transactions: history.filter((t) => !t.deletedAt) as Transaction[],
      deletedTransactions: history.filter((t) => t.deletedAt) as Transaction[],
    },
    dueDate,
    dueDate,
  )[0]
  if (!payment)
    throw createError({
      statusCode: 404,
      message: 'Платёж больше не запланирован на эту дату. Обновите календарь.',
    })
  return { payment, existing: occurrences[0], history }
}
export async function executePlanningCommand(
  db: WriteTransaction,
  command: PlanningCommand,
  currentRevision: string,
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
    case 'recurring.save': {
      const previous = command.id
        ? (await db.select().from(recurringPayments).where(eq(recurringPayments.id, command.id)))[0]
        : null
      if (command.id && !previous)
        throw createError({ statusCode: 404, message: 'Расписание не найдено' })
      if (command.data.accountId) {
        const [account] = await db
          .select()
          .from(accounts)
          .where(eq(accounts.id, command.data.accountId))
        if (!account || (account.archived && previous?.accountId !== account.id))
          throw createError({
            statusCode: 400,
            message: 'Выберите действующий счёт или оплату без счёта по умолчанию',
          })
      }
      const id = command.id || crypto.randomUUID()
      if (previous) {
        await closeSchedule(db, id, localDate())
        await db.update(recurringPayments).set(command.data).where(eq(recurringPayments.id, id))
      } else await db.insert(recurringPayments).values({ id, ...command.data, active: true })
      if (!previous || previous.active)
        await addSchedule(db, id, command.data, previous ? localDate() : command.data.startDate)
      break
    }
    case 'recurring.toggle': {
      const [previous] = await db
        .select()
        .from(recurringPayments)
        .where(eq(recurringPayments.id, command.id))
      if (!previous) throw createError({ statusCode: 404, message: 'Расписание не найдено' })
      if (previous.active === command.active) break
      if (command.active && previous.endDate && previous.endDate < localDate())
        throw createError({
          statusCode: 400,
          message: 'Продлите дату окончания перед возобновлением',
        })
      await closeSchedule(db, command.id, localDate())
      await db
        .update(recurringPayments)
        .set({ active: command.active })
        .where(eq(recurringPayments.id, command.id))
      if (command.active)
        await addSchedule(db, command.id, previous as RecurringFields, localDate())
      break
    }
    case 'payment.pay':
    case 'payment.skip':
    case 'payment.unskip': {
      const { payment, existing, history } = await resolvePayment(
        db,
        command.recurringId,
        command.dueDate,
      )
      if (command.op === 'payment.pay' && payment.status === 'paid')
        return { alreadyPaid: true, transactionId: payment.transactionId! }
      if (command.op === 'payment.skip' && payment.status === 'skipped') return { ok: true }
      if (currentRevision !== command.expectedRevision)
        throw createError({
          statusCode: 409,
          message: 'Данные изменились. Закройте форму и обновите календарь.',
        })
      const snapshot = {
        id: existing?.id || crypto.randomUUID(),
        recurringId: payment.recurringId,
        dueDate: payment.dueDate,
        title: payment.title,
        category: payment.category,
        amount: payment.amount,
        accountId: payment.accountId,
        note: payment.note,
      }
      if (command.op === 'payment.unskip') {
        if (payment.status !== 'skipped' || !existing)
          throw createError({ statusCode: 400, message: 'Этот платёж не был пропущен' })
        await db
          .update(paymentOccurrences)
          .set({ status: 'pending', transactionId: null })
          .where(eq(paymentOccurrences.id, existing.id))
        break
      }
      if (payment.status === 'paid' || payment.status === 'deleted')
        throw createError({
          statusCode: 409,
          message:
            payment.status === 'deleted'
              ? 'Связанный расход удалён. Восстановите его вместо повторной оплаты.'
              : 'Платёж уже оплачен',
        })
      if (command.op === 'payment.skip') {
        await db
          .insert(paymentOccurrences)
          .values({ ...snapshot, status: 'skipped', transactionId: null })
          .onConflictDoUpdate({
            target: [paymentOccurrences.recurringId, paymentOccurrences.dueDate],
            set: { status: 'skipped', transactionId: null },
          })
        break
      }
      let transactionId = command.transactionId
      if (command.mode === 'link') {
        const transaction = history.find((t) => t.id === transactionId)
        if (!transaction || transaction.deletedAt || transaction.kind !== 'expense')
          throw createError({ statusCode: 400, message: 'Выберите действующий расход' })
        const linked = await db
          .select()
          .from(paymentOccurrences)
          .where(eq(paymentOccurrences.transactionId, transactionId!))
        if (linked.length)
          throw createError({
            statusCode: 409,
            message: 'Этот расход уже связан с другим платежом',
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
          kind: 'expense',
          amount: command.amount!,
          accountId: account.id,
          category: payment.category,
          description: payment.title,
          date: command.date,
        })
      }
      await db
        .insert(paymentOccurrences)
        .values({ ...snapshot, status: 'paid', transactionId: transactionId! })
        .onConflictDoUpdate({
          target: [paymentOccurrences.recurringId, paymentOccurrences.dueDate],
          set: { status: 'paid', transactionId: transactionId! },
        })
      return { transactionId }
    }
  }
  return { ok: true }
}
