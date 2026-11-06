// Iteration 5: repayment of obligations. A repayment is a transaction plus an entry that splits it
// into principal, interest and fees; the balance follows from the entries. The payment schedule
// is a plan of the unified model (source `obligation`) that this module keeps in sync.
import { z } from 'zod'
import { and, eq, gt } from 'drizzle-orm'
import { createError } from 'h3'
import type { WriteTransaction } from '../db'
import {
  accounts,
  obligations,
  obligationEntries,
  plans,
  planVersions,
  planOccurrences,
  transactions,
} from '../db/schema'
import { amount, obligationSchema, pastDate, revision } from '../../shared/schemas'
import { planSchema } from '../../shared/planning-schemas'
import { addDays } from '../../shared/planning'
import { money } from '../../shared/money'
import {
  annuityPayment,
  monthEnd,
  obligationCategory,
  obligationDirection,
  obligationOutlook,
  paymentSchedule,
  paymentInterest,
  type ObligationData,
} from '../../shared/obligations'
import type { Obligation, ObligationEntry, Transaction } from '../../shared/types'
import type { CommandResult, Plan, PlanOccurrence } from '../../shared/planning-types'
import { executePlanningCommand } from './planning'

const split = { principal: amount, interest: amount.default('0'), fees: amount.default('0') }
const positiveTotal = (v: { principal: string; interest: string; fees: string }) =>
  BigInt(v.principal) + BigInt(v.interest) + BigInt(v.fees) > 0n
export const obligationCommands = [
  z.object({ op: z.literal('obligation.create'), data: obligationSchema }),
  z.object({
    op: z.literal('obligation.update'),
    id: z.uuid(),
    data: obligationSchema,
    expectedRevision: revision.optional(),
  }),
  z.object({ op: z.literal('obligation.delete'), id: z.uuid() }),
  z
    .object({
      op: z.literal('obligation.pay'),
      obligationId: z.uuid(),
      expectedRevision: revision,
      date: pastDate('Дата платежа не может быть в будущем'),
      ...split,
      mode: z.enum(['create', 'link']),
      accountId: z.uuid().optional(),
      transactionId: z.uuid().optional(),
      /** The scheduled date this payment settles; empty for an early repayment. */
      dueDate: z.iso.date().nullable().default(null),
      early: z.enum(['none', 'term', 'payment']).default('none'),
      note: z.string().trim().max(300).default(''),
    })
    .refine(positiveTotal, 'Сумма платежа должна быть больше нуля')
    .refine((v) => v.early === 'none' || !v.dueDate, 'Досрочный платёж не закрывает дату графика')
    .superRefine((v, ctx) => {
      if (v.mode === 'create' && !v.accountId)
        ctx.addIssue({ code: 'custom', message: 'Выберите счёт' })
      if (v.mode === 'link' && !v.transactionId)
        ctx.addIssue({ code: 'custom', message: 'Выберите уже записанную операцию' })
    }),
  z
    .object({
      op: z.literal('obligation.payment.update'),
      id: z.uuid(),
      expectedRevision: revision,
      date: pastDate('Дата платежа не может быть в будущем'),
      ...split,
      note: z.string().trim().max(300).default(''),
    })
    .refine(positiveTotal, 'Сумма платежа должна быть больше нуля'),
  z.object({
    op: z.literal('obligation.payment.cancel'),
    id: z.uuid(),
    expectedRevision: revision,
    deleteTransaction: z.boolean().default(true),
  }),
  z.object({
    op: z.literal('obligation.reconcile'),
    id: z.uuid(),
    expectedRevision: revision,
    date: pastDate('Нельзя сверить будущую дату'),
    actual: amount,
    expected: z.string().regex(/^-?\d{1,17}$/),
    note: z.string().trim().max(300).default(''),
  }),
] as const
const obligationCommandSchema = z.discriminatedUnion('op', obligationCommands)
export type ObligationCommand = z.infer<typeof obligationCommandSchema>
export const isObligationCommand = (command: { op: string }): command is ObligationCommand =>
  command.op.startsWith('obligation.')

const total = (v: { principal: string; interest: string; fees: string }) =>
  (BigInt(v.principal) + BigInt(v.interest) + BigInt(v.fees)).toString()
const fail = (statusCode: number, message: string) => createError({ statusCode, message })

async function loadData(db: WriteTransaction) {
  const [list, entries, history, planRows, occurrences] = await Promise.all([
    db.select().from(obligations),
    db.select().from(obligationEntries),
    db.select().from(transactions),
    db.select().from(plans),
    db.select().from(planOccurrences),
  ])
  const data: ObligationData = {
    obligationEntries: entries as ObligationEntry[],
    transactions: history.filter((t) => !t.deletedAt),
    plans: planRows as Plan[],
    planOccurrences: occurrences as PlanOccurrence[],
  }
  return { list: list as Obligation[], data, history: history as Transaction[] }
}
async function getObligation(db: WriteTransaction, id: string) {
  const [row] = await db.select().from(obligations).where(eq(obligations.id, id))
  if (!row) throw fail(404, 'Обязательство не найдено')
  return row as Obligation
}
async function outlookOf(db: WriteTransaction, obligation: Obligation) {
  return obligationOutlook(obligation, (await loadData(db)).data)
}
/** Changes the estimated end of a plan without a new version: it is not a user setting. */
async function setPlanEnd(db: WriteTransaction, plan: Plan, endDate: string | null) {
  await db.update(plans).set({ endDate }).where(eq(plans.id, plan.id))
  const open = await db.select().from(planVersions).where(eq(planVersions.planId, plan.id))
  for (const version of open)
    if (!version.validTo || (endDate && version.endDate && version.endDate > endDate))
      await db
        .update(planVersions)
        .set({ endDate: endDate && endDate < version.startDate ? version.startDate : endDate })
        .where(eq(planVersions.id, version.id))
  if (endDate)
    await db
      .delete(planOccurrences)
      .where(
        and(
          eq(planOccurrences.planId, plan.id),
          eq(planOccurrences.status, 'pending'),
          gt(planOccurrences.dueDate, endDate),
        ),
      )
}

/**
 * Brings the plan of every obligation in line with its balance and settings, and rejects a state
 * where repayments exceed the debt. Runs after every command, so deleting or restoring a
 * transaction, cancelling a scheduled date or editing an obligation is reflected at once.
 */
export async function syncObligations(db: WriteTransaction, currentRevision: string) {
  const { list, data } = await loadData(db)
  for (const obligation of list) {
    const outlook = obligationOutlook(obligation, data)
    if (outlook.remaining < 0n)
      throw fail(
        409,
        `По «${obligation.title}» погашено больше долга на ${money(-outlook.remaining)}. ` +
          'Отмените лишний платёж или сверьте остаток.',
      )
    const plan = outlook.plan
    const direction = obligationDirection(obligation)
    const bank = obligation.bankSchedule || []
    const needed = outlook.remaining > 0n && (BigInt(obligation.payment) > 0n || bank.length > 0)
    if (needed) {
      const fields = planSchema.parse({
        title: obligation.title,
        category: plan?.category || obligationCategory(obligation),
        amount: bank[0]?.amount || obligation.payment,
        accountId: obligation.accountId,
        frequency: bank.length ? 'custom' : 'monthly',
        customDates: bank.map(({ date, amount }) => ({ date, amount })),
        interval: 1,
        startDate: bank[0]?.date || obligation.startDate,
        endDate: bank.at(-1)?.date || (outlook.payoff ? monthEnd(outlook.payoff) : null),
        monthDays: bank.length ? [] : [obligation.dueDay],
      })
      const source = { source: 'obligation' as const, sourceId: obligation.id }
      if (plan && plan.direction !== direction) {
        await executePlanningCommand(db, { op: 'plan.delete', id: plan.id }, currentRevision)
      }
      if (!plan || plan.direction !== direction) {
        await executePlanningCommand(
          db,
          { op: 'plan.save', direction, data: fields },
          currentRevision,
          source,
        )
        continue
      }
      const changed =
        plan.title !== fields.title ||
        plan.category !== fields.category ||
        plan.amount !== fields.amount ||
        plan.accountId !== fields.accountId ||
        plan.startDate !== fields.startDate ||
        plan.monthDays.join() !== fields.monthDays.join() ||
        JSON.stringify(plan.customDates || []) !== JSON.stringify(fields.customDates) ||
        !plan.active
      if (changed) {
        if (!plan.active) await db.update(plans).set({ active: true }).where(eq(plans.id, plan.id))
        await executePlanningCommand(
          db,
          { op: 'plan.save', id: plan.id, direction, data: fields },
          currentRevision,
          source,
        )
      } else if (plan.endDate !== fields.endDate) await setPlanEnd(db, plan, fields.endDate)
      continue
    }
    if (!plan) continue
    // Repaid or without a monthly payment: no more dates after the last settled one.
    const paid = data.planOccurrences.filter((o) => o.planId === plan.id && o.status === 'paid')
    if (!paid.length) {
      await db.delete(planOccurrences).where(eq(planOccurrences.planId, plan.id))
      await executePlanningCommand(db, { op: 'plan.delete', id: plan.id }, currentRevision)
      continue
    }
    const lastPaid = paid
      .map((o) => o.dueDate)
      .sort()
      .at(-1)!
    const before = addDays(outlook.firstOpen, -1)
    const end = before > lastPaid ? before : lastPaid
    if (plan.endDate !== end) await setPlanEnd(db, plan, end)
  }
}

/** Records the split of a transaction that confirmed a scheduled date of an obligation plan. */
export async function afterPlanConfirm(
  db: WriteTransaction,
  planId: string,
  transactionId: string,
) {
  const [plan] = await db.select().from(plans).where(eq(plans.id, planId))
  if (plan?.source !== 'obligation' || !plan.sourceId) return
  const known = await db
    .select()
    .from(obligationEntries)
    .where(eq(obligationEntries.transactionId, transactionId))
  if (known.length) return
  const obligation = await getObligation(db, plan.sourceId)
  const [transaction] = await db
    .select()
    .from(transactions)
    .where(eq(transactions.id, transactionId))
  const outlook = await outlookOf(db, obligation)
  const [occurrence] = await db
    .select()
    .from(planOccurrences)
    .where(eq(planOccurrences.transactionId, transactionId))
  const bank = obligation.bankSchedule?.find((r) => r.date === occurrence?.dueDate)
  const due =
    bank?.interest !== undefined
      ? BigInt(bank.interest)
      : paymentInterest(
          obligation,
          outlook.remaining,
          transaction!.date,
          outlook.lastPaidDate || obligation.startDate,
        )
  const interest = due < BigInt(transaction!.amount) ? due : BigInt(transaction!.amount)
  const principal = BigInt(transaction!.amount) - interest
  if (principal > outlook.remaining)
    throw fail(
      400,
      `Сумма больше остатка долга с процентами. Запишите платёж в разделе «Кредиты и долги» ` +
        'и укажите, сколько пошло на основной долг.',
    )
  await db.insert(obligationEntries).values({
    id: crypto.randomUUID(),
    obligationId: obligation.id,
    kind: 'payment',
    date: transaction!.date,
    principal: principal.toString(),
    interest: interest.toString(),
    fees: '0',
    transactionId,
  })
}

/** Keeps a repayment and its transaction consistent when the transaction is edited directly. */
export async function checkTransactionEdit(
  db: WriteTransaction,
  id: string,
  data: { kind: string; amount: string; date: string },
) {
  const [entry] = await db
    .select()
    .from(obligationEntries)
    .where(eq(obligationEntries.transactionId, id))
  if (!entry) return
  const obligation = await getObligation(db, entry.obligationId)
  if (data.kind !== obligationDirection(obligation) || data.amount !== total(entry))
    throw fail(
      409,
      'Операция — погашение по обязательству. Сумму и тип меняйте в разделе «Кредиты и долги»: ' +
        'там же указывается, сколько ушло на основной долг и проценты.',
    )
  if (data.date < obligation.startDate)
    throw fail(400, 'Дата погашения раньше начала учёта обязательства')
  await db
    .update(obligationEntries)
    .set({ date: data.date })
    .where(eq(obligationEntries.id, entry.id))
}

function checkRevision(expected: string, current: string) {
  if (expected !== current)
    throw fail(409, 'Данные изменились. Закройте форму и проверьте их ещё раз.')
}

export async function executeObligationCommand(
  db: WriteTransaction,
  command: ObligationCommand,
  currentRevision: string,
): Promise<CommandResult> {
  switch (command.op) {
    case 'obligation.create': {
      await checkAccount(db, command.data.accountId)
      await db.insert(obligations).values({ id: crypto.randomUUID(), ...command.data })
      break
    }
    case 'obligation.update': {
      const previous = await getObligation(db, command.id)
      if (previous.accountId !== command.data.accountId)
        await checkAccount(db, command.data.accountId)
      const entries = await db
        .select()
        .from(obligationEntries)
        .where(eq(obligationEntries.obligationId, command.id))
      if (entries.length) {
        if (obligationDirection(previous) !== obligationDirection(command.data))
          throw fail(
            400,
            'По обязательству уже есть погашения: «Мне должны» нельзя превратить в долг и наоборот.',
          )
        if (entries.some((e) => e.date < command.data.startDate))
          throw fail(400, 'Есть погашения раньше новой даты начала учёта')
      }
      await db.update(obligations).set(command.data).where(eq(obligations.id, command.id))
      break
    }
    case 'obligation.delete': {
      await getObligation(db, command.id)
      const entries = await db
        .select()
        .from(obligationEntries)
        .where(eq(obligationEntries.obligationId, command.id))
        .limit(1)
      if (entries.length)
        throw fail(
          409,
          'У обязательства есть история погашений и сверок. Отмените их, если они записаны по ошибке.',
        )
      const owned = await db
        .select()
        .from(plans)
        .where(and(eq(plans.source, 'obligation'), eq(plans.sourceId, command.id)))
      for (const plan of owned) {
        await db.delete(planOccurrences).where(eq(planOccurrences.planId, plan.id))
        await executePlanningCommand(db, { op: 'plan.delete', id: plan.id }, currentRevision)
      }
      await db.delete(obligations).where(eq(obligations.id, command.id))
      break
    }
    case 'obligation.pay':
      checkRevision(command.expectedRevision, currentRevision)
      return { transactionId: await payObligation(db, command, currentRevision) }
    case 'obligation.payment.update': {
      checkRevision(command.expectedRevision, currentRevision)
      const entry = await getEntry(db, command.id)
      if (entry.kind !== 'payment')
        throw fail(400, 'Сверку нельзя изменить: отмените её и сверьте заново')
      const obligation = await getObligation(db, entry.obligationId)
      if (command.date < obligation.startDate)
        throw fail(400, 'Дата платежа раньше начала учёта обязательства')
      const [transaction] = await db
        .select()
        .from(transactions)
        .where(eq(transactions.id, entry.transactionId!))
      if (!transaction || transaction.deletedAt)
        throw fail(409, 'Операция платежа удалена. Восстановите её в разделе «Операции».')
      await db
        .update(transactions)
        .set({ amount: total(command), date: command.date })
        .where(eq(transactions.id, transaction.id))
      await db
        .update(obligationEntries)
        .set({
          date: command.date,
          principal: command.principal,
          interest: command.interest,
          fees: command.fees,
          note: command.note,
        })
        .where(eq(obligationEntries.id, entry.id))
      break
    }
    case 'obligation.payment.cancel': {
      checkRevision(command.expectedRevision, currentRevision)
      const entry = await getEntry(db, command.id)
      await db.delete(obligationEntries).where(eq(obligationEntries.id, entry.id))
      if (entry.transactionId) {
        // The scheduled date returns to the plan; the money movement is deleted or stays.
        await db
          .update(planOccurrences)
          .set({ status: 'pending', transactionId: null })
          .where(eq(planOccurrences.transactionId, entry.transactionId))
        if (command.deleteTransaction)
          await db
            .update(transactions)
            .set({ deletedAt: new Date().toISOString() })
            .where(eq(transactions.id, entry.transactionId))
      }
      if (entry.early === 'payment' && entry.previousPayment) {
        const later = await db
          .select()
          .from(obligationEntries)
          .where(
            and(
              eq(obligationEntries.obligationId, entry.obligationId),
              eq(obligationEntries.early, 'payment'),
              gt(obligationEntries.createdAt, entry.createdAt),
            ),
          )
          .limit(1)
        if (!later.length)
          await db
            .update(obligations)
            .set({ payment: entry.previousPayment })
            .where(eq(obligations.id, entry.obligationId))
      }
      break
    }
    case 'obligation.reconcile': {
      checkRevision(command.expectedRevision, currentRevision)
      const obligation = await getObligation(db, command.id)
      if (command.date < obligation.startDate)
        throw fail(400, 'Дата сверки раньше начала учёта обязательства')
      const { remaining } = await outlookOf(db, obligation)
      if (remaining.toString() !== command.expected)
        throw fail(409, 'Остаток изменился. Обновите данные и повторите сверку.')
      const delta = BigInt(command.actual) - remaining
      if (delta !== 0n)
        await db.insert(obligationEntries).values({
          id: crypto.randomUUID(),
          obligationId: obligation.id,
          kind: 'adjustment',
          date: command.date,
          principal: delta.toString(),
          note: command.note || 'Сверка с банком',
        })
      break
    }
  }
  return { ok: true }
}

async function checkAccount(db: WriteTransaction, id: string | null) {
  if (!id) return
  const [account] = await db.select().from(accounts).where(eq(accounts.id, id))
  if (!account || account.archived) throw fail(400, 'Выберите действующий счёт')
}
async function getEntry(db: WriteTransaction, id: string) {
  const [entry] = await db.select().from(obligationEntries).where(eq(obligationEntries.id, id))
  if (!entry) throw fail(404, 'Запись погашения не найдена')
  return entry as ObligationEntry
}

type PayCommand = Extract<ObligationCommand, { op: 'obligation.pay' }>
export async function payObligation(
  db: WriteTransaction,
  command: Omit<PayCommand, 'op' | 'expectedRevision'>,
  currentRevision: string,
) {
  const obligation = await getObligation(db, command.obligationId)
  if (command.date < obligation.startDate)
    throw fail(400, 'Дата платежа раньше начала учёта обязательства')
  const direction = obligationDirection(obligation)
  const amountTotal = total(command)
  let transactionId: string
  if (command.mode === 'link') {
    const [transaction] = await db
      .select()
      .from(transactions)
      .where(eq(transactions.id, command.transactionId!))
    if (!transaction || transaction.deletedAt || transaction.kind !== direction)
      throw fail(
        400,
        `Выберите действующую операцию, которая является ${direction === 'income' ? 'доходом' : 'расходом'}`,
      )
    if (transaction.amount !== amountTotal)
      throw fail(
        400,
        `Сумма операции ${money(transaction.amount)} не совпадает с суммой платежа ${money(amountTotal)}`,
      )
    const linked = await Promise.all([
      db
        .select()
        .from(obligationEntries)
        .where(eq(obligationEntries.transactionId, transaction.id)),
      db.select().from(planOccurrences).where(eq(planOccurrences.transactionId, transaction.id)),
    ])
    if (linked.some((rows) => rows.length))
      throw fail(409, 'Эта операция уже связана с другим платежом или планом')
    transactionId = transaction.id
  } else {
    await checkAccount(db, command.accountId!)
    transactionId = crypto.randomUUID()
    await db.insert(transactions).values({
      id: transactionId,
      kind: direction,
      amount: amountTotal,
      accountId: command.accountId!,
      category: obligationCategory(obligation),
      description: obligation.title,
      date: command.date,
    })
  }
  const entryDate =
    command.mode === 'link'
      ? (await db.select().from(transactions).where(eq(transactions.id, transactionId)))[0]!.date
      : command.date
  let previousPayment: string | null = null
  if (command.early === 'payment') {
    // Keep the number of remaining payments and lower the payment to repay the new balance.
    const outlook = await outlookOf(db, obligation)
    const schedule = paymentSchedule(
      outlook.remaining,
      obligation.rate,
      BigInt(obligation.payment),
      outlook.firstOpen,
      obligation.dueDay,
    )
    if (!schedule.complete || !schedule.rows.length)
      throw fail(
        400,
        'Нельзя пересчитать платёж: текущий платёж не погашает долг. Выберите сокращение срока.',
      )
    const left = outlook.remaining - BigInt(command.principal)
    if (left > 0n) {
      previousPayment = obligation.payment
      await db
        .update(obligations)
        .set({ payment: annuityPayment(left, obligation.rate, schedule.rows.length).toString() })
        .where(eq(obligations.id, obligation.id))
    }
  }
  await db.insert(obligationEntries).values({
    id: crypto.randomUUID(),
    obligationId: obligation.id,
    kind: 'payment',
    date: entryDate,
    principal: command.principal,
    interest: command.interest,
    fees: command.fees,
    transactionId,
    early: command.early,
    previousPayment,
    note: command.note,
  })
  if (command.dueDate) {
    const [plan] = await db
      .select()
      .from(plans)
      .where(and(eq(plans.source, 'obligation'), eq(plans.sourceId, obligation.id)))
    if (!plan) throw fail(400, 'У обязательства нет графика платежей')
    const result = await executePlanningCommand(
      db,
      {
        op: 'occurrence.confirm',
        planId: plan.id,
        dueDate: command.dueDate,
        expectedRevision: currentRevision,
        date: entryDate,
        mode: 'link',
        transactionId,
      },
      currentRevision,
    )
    if (result.alreadyPaid) throw fail(409, 'Эта дата графика уже оплачена')
  }
  return transactionId
}
