import type { Account, Transaction, Workspace } from './types'
import type { PlanDirection, ProjectedOccurrence } from './planning-types'
import { accountBalance } from './money'
import { creditLimit } from './credit'
import { addDays, isOpen, projectPlans } from './planning'

/** Overdue open dates are still expected: they are counted on the first forecast day. */
export const overdueWindow = 90

export type ForecastWorkspace = Pick<
  Workspace,
  'accounts' | 'transactions' | 'deletedTransactions' | 'plans' | 'planVersions' | 'planOccurrences'
>
export interface ForecastEvent {
  toAccountId?: string | null
  /** `planId:dueDate`, the key of the projected date. */
  id: string
  planId: string
  dueDate: string
  /** The day the money is expected to move; an overdue date is moved to the first day. */
  date: string
  overdue: boolean
  title: string
  category: string
  direction: PlanDirection
  amount: string
  accountId: string | null
}
export interface BalanceSummary {
  start: string
  incomes: string
  payments: string
  end: string
  /** The lowest balance at the end of a day, the current balance included. */
  min: string
  minDate: string
  /** First day the balance is below zero, or null when it stays non-negative. */
  deficitDate: string | null
}
export interface AccountForecast extends BalanceSummary {
  available?: string
  minAvailable?: string
  account: Account
}
export interface ForecastDay {
  date: string
  /** Balance of forecast accounts and unassigned plans at the end of the day. */
  total: string
  accounts: Record<string, string>
  events: ForecastEvent[]
}
export interface Forecast {
  from: string
  to: string
  total: BalanceSummary
  accounts: AccountForecast[]
  /** Plans without an account: they change the total, but no single account. */
  unassigned: { incomes: string; payments: string; events: ForecastEvent[] }
  /** Accounts outside the forecast (savings and archived) and plans tied to them. */
  outside: { accounts: Account[]; balance: string; events: ForecastEvent[] }
  events: ForecastEvent[]
  days: ForecastDay[]
}

export const isForecastAccount = (account: Account) => account.inForecast && !account.archived

const signed = (event: ForecastEvent) =>
  event.direction === 'income' ? BigInt(event.amount) : -BigInt(event.amount)

function toEvent(item: ProjectedOccurrence, today: string): ForecastEvent {
  const overdue = item.date < today
  return {
    id: item.id,
    planId: item.planId,
    dueDate: item.dueDate,
    date: overdue ? today : item.date,
    overdue,
    title: item.title,
    category: item.category,
    direction: item.direction,
    amount: item.amount,
    accountId: item.accountId,
    toAccountId: item.creditAccountId,
  }
}

function summarize(
  start: bigint,
  days: { date: string; balance: bigint }[],
  events: ForecastEvent[],
  floor = 0n,
) {
  let min = start,
    minDate = days[0]!.date,
    deficitDate: string | null = start < floor ? days[0]!.date : null
  for (const day of days) {
    if (day.balance < min) {
      min = day.balance
      minDate = day.date
    }
    if (deficitDate === null && day.balance < floor) deficitDate = day.date
  }
  const total = (direction: PlanDirection) =>
    events
      .filter((e) => e.direction === direction)
      .reduce((sum, e) => sum + BigInt(e.amount), 0n)
      .toString()
  return {
    start: start.toString(),
    incomes: total('income'),
    payments: total('expense'),
    end: days.at(-1)!.balance.toString(),
    min: min.toString(),
    minDate,
    deficitDate,
  }
}

/**
 * Expected balances from `today` to `today + days`, built only from entered plans.
 * The current balance already contains every recorded transaction, so confirmed, cancelled and
 * closed dates are not counted again; open dates (pending, or confirmed by a since deleted
 * transaction) are. Overdue open dates of the last 90 days are expected on the first day.
 */
export function forecast(workspace: ForecastWorkspace, today: string, days: number): Forecast {
  const to = addDays(today, Math.max(0, days))
  const included = workspace.accounts.filter(isForecastAccount)
  const includedIds = new Set(included.map((a) => a.id))
  const events = projectPlans(workspace, addDays(today, -overdueWindow), to)
    .filter(isOpen)
    .map((item) => toEvent(item, today))
    .sort((a, b) => a.date.localeCompare(b.date) || Number(b.overdue) - Number(a.overdue))
  const scoped = events.filter(
    (e) =>
      !e.accountId ||
      includedIds.has(e.accountId) ||
      (!!e.toAccountId && includedIds.has(e.toAccountId)),
  )
  const outsideEvents = events.filter((e) => !scoped.includes(e))
  const eventsFor = (id: string) =>
    scoped.flatMap((e) =>
      e.accountId === id
        ? [e]
        : e.toAccountId === id
          ? [{ ...e, direction: 'income' as const }]
          : [],
    )
  const totalEvents = scoped.flatMap((e) =>
    !e.toAccountId
      ? [e]
      : includedIds.has(e.toAccountId)
        ? !e.accountId || includedIds.has(e.accountId)
          ? []
          : [{ ...e, direction: 'income' as const }]
        : [e],
  )

  const start = new Map(
    included.map((a) => [a.id, BigInt(accountBalance(a, workspace.transactions))]),
  )
  const running = new Map(start)
  let unassigned = 0n
  const byDate = new Map<string, ForecastEvent[]>()
  for (const event of scoped) byDate.set(event.date, [...(byDate.get(event.date) || []), event])

  const series: ForecastDay[] = []
  const perAccount = new Map(included.map((a) => [a.id, [] as { date: string; balance: bigint }[]]))
  const totalSeries: { date: string; balance: bigint }[] = []
  for (let date = today; date <= to; date = addDays(date, 1)) {
    const dayEvents = byDate.get(date) || []
    for (const event of dayEvents) {
      if (event.accountId) {
        if (running.has(event.accountId))
          running.set(event.accountId, running.get(event.accountId)! + signed(event))
      } else unassigned += signed(event)
      if (event.toAccountId && running.has(event.toAccountId))
        running.set(event.toAccountId, running.get(event.toAccountId)! + BigInt(event.amount))
    }
    let total = unassigned
    const accounts: Record<string, string> = {}
    for (const account of included) {
      const balance = running.get(account.id)!
      total += balance
      accounts[account.id] = balance.toString()
      perAccount.get(account.id)!.push({ date, balance })
    }
    totalSeries.push({ date, balance: total })
    series.push({ date, total: total.toString(), accounts, events: dayEvents })
  }

  const startTotal = [...start.values()].reduce((sum, v) => sum + v, 0n)
  const unassignedEvents = scoped.filter((e) => !e.accountId)
  const unassignedSummary = summarize(0n, [{ date: today, balance: unassigned }], unassignedEvents)
  return {
    from: today,
    to,
    total: summarize(
      startTotal,
      totalSeries,
      totalEvents,
      -included.reduce((sum, a) => sum + creditLimit(a), 0n),
    ),
    accounts: included.map((account) => {
      const summary = summarize(
        start.get(account.id)!,
        perAccount.get(account.id)!,
        eventsFor(account.id),
        -creditLimit(account),
      )
      return {
        account,
        ...summary,
        ...(account.kind === 'credit'
          ? {
              available: (BigInt(summary.start) + creditLimit(account)).toString(),
              minAvailable: (BigInt(summary.min) + creditLimit(account)).toString(),
            }
          : {}),
      }
    }),
    unassigned: {
      incomes: unassignedSummary.incomes,
      payments: unassignedSummary.payments,
      events: unassignedEvents,
    },
    outside: {
      accounts: workspace.accounts.filter((a) => !isForecastAccount(a) && !a.archived),
      balance: workspace.accounts
        .filter((a) => !isForecastAccount(a) && !a.archived)
        .reduce((sum, a) => sum + BigInt(accountBalance(a, workspace.transactions)), 0n)
        .toString(),
      events: outsideEvents,
    },
    events: scoped,
    days: series,
  }
}

/** The next expected income, the payments due before it and the lowest balance until then. */
export function untilNextIncome(result: Forecast) {
  const income = result.events.find((e) => e.direction === 'income')
  if (!income) return null
  const payments = result.events.filter((e) => e.direction === 'expense' && e.date < income.date)
  const before = result.days.filter((d) => d.date < income.date)
  const start = BigInt(result.total.start)
  const lowest = before.reduce((min, d) => (BigInt(d.total) < min ? BigInt(d.total) : min), start)
  return {
    income,
    payments,
    paymentsTotal: payments.reduce((sum, e) => sum + BigInt(e.amount), 0n).toString(),
    /** Lowest balance before the income arrives (the current balance if nothing is due). */
    lowest: lowest.toString(),
  }
}

/**
 * How the balance of forecast accounts changed over [from, to] (rule 11): transfers between
 * forecast accounts cancel out, a transfer to an account outside the forecast is an outflow.
 */
export function forecastFlows(
  workspace: Pick<ForecastWorkspace, 'accounts' | 'transactions'>,
  from: string,
  to: string,
) {
  const ids = new Set(workspace.accounts.filter(isForecastAccount).map((a) => a.id))
  const opening = workspace.accounts.filter(isForecastAccount).reduce(
    (sum, a) =>
      sum +
      BigInt(
        accountBalance(
          a,
          workspace.transactions.filter((t: Transaction) => t.date < from),
        ),
      ),
    0n,
  )
  let incomes = 0n,
    expenses = 0n,
    adjustments = 0n,
    transfersOut = 0n,
    transfersIn = 0n
  for (const t of workspace.transactions) {
    if (t.deletedAt || t.date < from || t.date > to) continue
    const amount = BigInt(t.amount)
    const inside = ids.has(t.accountId)
    if (t.kind === 'transfer') {
      const target = !!t.toAccountId && ids.has(t.toAccountId)
      if (inside && !target) transfersOut += amount
      if (!inside && target) transfersIn += amount
    } else if (inside) {
      if (t.kind === 'income') incomes += amount
      else if (t.kind === 'expense') expenses += amount
      else adjustments += amount
    }
  }
  return {
    opening: opening.toString(),
    incomes: incomes.toString(),
    expenses: expenses.toString(),
    adjustments: adjustments.toString(),
    transfersOut: transfersOut.toString(),
    transfersIn: transfersIn.toString(),
    closing: (opening + incomes - expenses + adjustments - transfersOut + transfersIn).toString(),
  }
}

/** Recorded balance of forecast accounts at the end of a past day. */
export function balanceAt(
  workspace: Pick<ForecastWorkspace, 'accounts' | 'transactions'>,
  date: string,
) {
  const recorded = workspace.transactions.filter((t) => t.date <= date)
  return workspace.accounts
    .filter(isForecastAccount)
    .reduce((sum, a) => sum + BigInt(accountBalance(a, recorded)), 0n)
    .toString()
}
