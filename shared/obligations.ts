// Repayment of obligations: the current balance from the history, the estimated schedule and
// early repayment. Pure functions shared by the server (plan sync, validation) and the client.
// Money is BigInt kopecks; interest is estimated monthly at rate / 12 and rounded to a kopeck.
import type { Obligation, ObligationEntry, Transaction } from './types'
import type { Plan, PlanOccurrence, PlanDirection } from './planning-types'

export const obligationKinds: Record<Obligation['kind'], string> = {
  credit: 'Кредит',
  mortgage: 'Ипотека',
  debt: 'Я должен',
  receivable: 'Мне должны',
}
export const isReceivable = (o: Pick<Obligation, 'kind'>) => o.kind === 'receivable'
/** A payment on a debt is an expense; money returned to the user is an income. */
export const obligationDirection = (o: Pick<Obligation, 'kind'>): PlanDirection =>
  isReceivable(o) ? 'income' : 'expense'
export const obligationCategory = (o: Pick<Obligation, 'kind'>) =>
  isReceivable(o) ? 'Возврат долга' : 'Кредиты и долги'

/** "8.5" → thousandths of a percent (8500). */
export function rateMilli(rate: string) {
  const [whole = '0', fraction = ''] = rate.split('.')
  return BigInt(whole) * 1000n + BigInt((fraction + '000').slice(0, 3))
}
/** Interest of one month on the balance, rounded half up to a kopeck. */
export function monthlyInterest(remaining: bigint, rate: string) {
  if (remaining <= 0n) return 0n
  const scale = 1_200_000n // 12 months × 100 % × 1000
  return (remaining * rateMilli(rate) * 2n + scale) / (2n * scale)
}
/** Actual elapsed UTC calendar days; denominator is 365 even in a leap year. */
export function actual365Interest(remaining: bigint, rate: string, from: string, to: string) {
  const days = Math.max(
    0,
    Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000),
  )
  const scale = 36_500_000n
  return (remaining * rateMilli(rate) * BigInt(days) * 2n + scale) / (2n * scale)
}
export function paymentInterest(o: Obligation, remaining: bigint, date: string, previous: string) {
  const bank = o.bankSchedule?.find((r) => r.date === date)
  return bank?.interest !== undefined
    ? BigInt(bank.interest)
    : o.interestMethod === 'actual365'
      ? actual365Interest(remaining, o.rate, previous, date)
      : monthlyInterest(remaining, o.rate)
}

const pad = (n: number) => String(n).padStart(2, '0')
/** The payment day in a month, clamped to the month's last day (the 31st in February → the 28th). */
export function dueDateIn(month: string, day: number) {
  const [year, number] = month.split('-').map(Number) as [number, number]
  const last = new Date(Date.UTC(year, number, 0)).getUTCDate()
  return `${month}-${pad(Math.min(day, last))}`
}
function addMonths(month: string, count: number) {
  const [year, number] = month.split('-').map(Number) as [number, number]
  const value = new Date(Date.UTC(year, number - 1 + count, 1))
  return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}`
}
/** The first payment date on or after `date`. */
export function firstDueDate(date: string, day: number) {
  const here = dueDateIn(date.slice(0, 7), day)
  return here >= date ? here : dueDateIn(addMonths(date.slice(0, 7), 1), day)
}
export const nextDueDate = (date: string, day: number) =>
  dueDateIn(addMonths(date.slice(0, 7), 1), day)
export const monthEnd = (date: string) => dueDateIn(date.slice(0, 7), 31)

export interface ObligationState {
  remaining: bigint
  paidPrincipal: bigint
  paidInterest: bigint
  paidFees: bigint
  /** The net change of the principal by reconciliations with the bank. */
  adjusted: bigint
  lastPaidDate: string | null
}
/**
 * The balance follows from the opening balance, repayments and reconciliations. A repayment whose
 * transaction was deleted does not count until the transaction is restored (rule 8).
 */
export function obligationState(
  obligation: Pick<Obligation, 'id' | 'openingBalance'>,
  entries: ObligationEntry[],
  activeTransactions: Set<string>,
): ObligationState {
  const state: ObligationState = {
    remaining: BigInt(obligation.openingBalance),
    paidPrincipal: 0n,
    paidInterest: 0n,
    paidFees: 0n,
    adjusted: 0n,
    lastPaidDate: null,
  }
  for (const entry of entries) {
    if (entry.obligationId !== obligation.id) continue
    if (entry.kind === 'adjustment') {
      state.adjusted += BigInt(entry.principal)
      continue
    }
    if (entry.transactionId && !activeTransactions.has(entry.transactionId)) continue
    state.paidPrincipal += BigInt(entry.principal)
    state.paidInterest += BigInt(entry.interest)
    state.paidFees += BigInt(entry.fees)
    if (!state.lastPaidDate || entry.date > state.lastPaidDate) state.lastPaidDate = entry.date
  }
  state.remaining += state.adjusted - state.paidPrincipal
  return state
}

export interface ScheduleRow {
  date: string
  payment: bigint
  interest: bigint
  principal: bigint
  remaining: bigint
}
/**
 * The estimated schedule: equal monthly payments, interest on the balance at rate / 12, the last
 * payment closes the balance. `complete` is false when the payment does not cover the interest
 * or the schedule is longer than `limit` months.
 */
export function paymentSchedule(
  remaining: bigint,
  rate: string,
  payment: bigint,
  firstDate: string,
  day: number,
  limit = 600,
  method: 'monthly' | 'actual365' = 'monthly',
  previousDate = firstDate,
) {
  const rows: ScheduleRow[] = []
  let balance = remaining,
    date = firstDate
  while (balance > 0n && rows.length < limit) {
    const interest =
      method === 'actual365'
        ? actual365Interest(balance, rate, previousDate, date)
        : monthlyInterest(balance, rate)
    if (payment <= interest) break
    const amount = payment < balance + interest ? payment : balance + interest
    balance -= amount - interest
    rows.push({ date, payment: amount, interest, principal: amount - interest, remaining: balance })
    previousDate = date
    date = nextDueDate(date, day)
  }
  return { rows, complete: balance <= 0n }
}
function paysOff(remaining: bigint, rate: string, payment: bigint, months: number) {
  let balance = remaining
  for (let i = 0; i < months && balance > 0n; i++) {
    const interest = monthlyInterest(balance, rate)
    if (payment <= interest) return false
    balance -= payment - interest < balance ? payment - interest : balance
  }
  return balance <= 0n
}
/** The smallest monthly payment that repays the balance in `months` payments. */
export function annuityPayment(remaining: bigint, rate: string, months: number) {
  if (remaining <= 0n || months <= 0) return remaining > 0n ? remaining : 0n
  let low = 1n,
    high = remaining + monthlyInterest(remaining, rate) * BigInt(months) + 1n
  while (low < high) {
    const middle = (low + high) / 2n
    if (paysOff(remaining, rate, middle, months)) high = middle
    else low = middle + 1n
  }
  return low
}
/** The usual split of a payment: this month's interest first, the rest repays the principal. */
export function suggestSplit(remaining: bigint, rate: string, total: bigint, early: boolean) {
  const due = early ? 0n : monthlyInterest(remaining, rate)
  const interest = due < total ? due : total
  return { interest, principal: total - interest }
}

export interface ObligationData {
  activeTransactionIds?: string[]
  obligationEntries: ObligationEntry[]
  /** Active (not deleted) transactions. */
  transactions: Pick<Transaction, 'id'>[]
  plans: Plan[]
  planOccurrences: PlanOccurrence[]
}
export const obligationPlan = (data: Pick<ObligationData, 'plans'>, id: string) =>
  data.plans.find((p) => p.source === 'obligation' && p.sourceId === id)
/**
 * The first scheduled payment date that is still open: not confirmed by an active transaction
 * and not cancelled. The estimated schedule starts here, so it does not drift while the user
 * has not recorded a payment yet.
 */
export function firstOpenDate(
  obligation: Pick<Obligation, 'id' | 'startDate' | 'dueDay'>,
  data: ObligationData,
  activeTransactions = new Set([
    ...data.transactions.map((t) => t.id),
    ...(data.activeTransactionIds || []),
  ]),
) {
  const plan = obligationPlan(data, obligation.id)
  const decided = new Set(
    plan
      ? data.planOccurrences
          .filter(
            (o) =>
              o.planId === plan.id &&
              (o.status === 'skipped' ||
                o.status === 'closed' ||
                (o.status === 'paid' &&
                  !!o.transactionId &&
                  activeTransactions.has(o.transactionId))),
          )
          .map((o) => o.dueDate)
      : [],
  )
  let date = firstDueDate(obligation.startDate, obligation.dueDay)
  for (let i = 0; i < 1200 && decided.has(date); i++) date = nextDueDate(date, obligation.dueDay)
  return date
}
/** Balance, history totals and the estimated schedule of an obligation. */
export function obligationOutlook(obligation: Obligation, data: ObligationData) {
  const active = new Set([
    ...data.transactions.map((t) => t.id),
    ...(data.activeTransactionIds || []),
  ])
  const state = obligationState(obligation, data.obligationEntries, active)
  const firstOpen = firstOpenDate(obligation, data, active)
  const payment = BigInt(obligation.payment)
  let schedule =
    state.remaining > 0n && payment > 0n
      ? paymentSchedule(
          state.remaining,
          obligation.rate,
          payment,
          firstOpen,
          obligation.dueDay,
          600,
          obligation.interestMethod,
          state.lastPaidDate || obligation.startDate,
        )
      : { rows: [] as ScheduleRow[], complete: state.remaining <= 0n }
  if (obligation.bankSchedule?.length) {
    const plan = obligationPlan(data, obligation.id)
    const decided = new Set(
      data.planOccurrences
        .filter(
          (o) =>
            o.planId === plan?.id &&
            (o.status === 'skipped' ||
              o.status === 'closed' ||
              (o.status === 'paid' && !!o.transactionId && active.has(o.transactionId))),
        )
        .map((o) => o.dueDate),
    )
    let balance = state.remaining,
      previous = state.lastPaidDate || obligation.startDate
    const rows: ScheduleRow[] = []
    for (const row of obligation.bankSchedule
      .filter((r) => !decided.has(r.date))
      .sort((a, b) => a.date.localeCompare(b.date))) {
      if (balance <= 0n) break
      const interest = paymentInterest(obligation, balance, row.date, previous),
        amount = BigInt(row.amount)
      if (amount <= interest) break
      const principal = amount - interest < balance ? amount - interest : balance
      balance -= principal
      rows.push({ date: row.date, payment: amount, interest, principal, remaining: balance })
      previous = row.date
    }
    schedule = { rows, complete: balance <= 0n }
  }
  return {
    ...state,
    firstOpen,
    schedule: schedule.rows,
    /** The schedule repays the balance: false when the payment is missing or too small. */
    complete: schedule.complete,
    payoff: schedule.complete ? (schedule.rows.at(-1)?.date ?? null) : null,
    futureInterest: schedule.rows.reduce((sum, row) => sum + row.interest, 0n),
    plan: obligationPlan(data, obligation.id),
  }
}
