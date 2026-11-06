import type { Workspace, Transaction } from './types'
import type { RecurringVersion, ProjectedPayment } from './planning-types'

const dayMs = 86400000
const utc = (date: string) => new Date(`${date}T00:00:00Z`)
export function addDays(date: string, days: number) {
  const value = utc(date)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}
export function shiftMonth(month: string, delta: number) {
  const value = utc(`${month}-01`)
  value.setUTCMonth(value.getUTCMonth() + delta)
  return value.toISOString().slice(0, 7)
}
export function monthRange(month: string) {
  return { from: `${month}-01`, to: addDays(`${shiftMonth(month, 1)}-01`, -1) }
}
function clampedDate(year: number, month: number, day: number) {
  const start = utc(`${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`)
  start.setUTCMonth(start.getUTCMonth() + 1)
  start.setUTCDate(0)
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(Math.min(day, start.getUTCDate())).padStart(2, '0')}`
}
export function recurringDates(version: RecurringVersion, from: string, to: string): string[] {
  const low = [from, version.startDate, version.validFrom].sort().at(-1)!
  const high = [to, version.endDate, version.validTo].filter((v): v is string => !!v).sort()[0]!
  if (low > high) return []
  const [year, month, day] = version.startDate.split('-').map(Number) as [number, number, number]
  const output: string[] = []
  if (version.frequency === 'weekly') {
    const step = version.interval * 7
    const count = Math.max(
      0,
      Math.ceil((utc(low).getTime() - utc(version.startDate).getTime()) / dayMs / step),
    )
    for (
      let date = addDays(version.startDate, count * step);
      date <= high;
      date = addDays(date, step)
    )
      output.push(date)
  } else if (version.frequency === 'monthly') {
    const [lowYear, lowMonth] = low.split('-').map(Number) as [number, number]
    const distance = (lowYear - year) * 12 + lowMonth - month
    let index = Math.max(0, Math.floor(distance / version.interval))
    for (;;) {
      const nextMonth = shiftMonth(version.startDate.slice(0, 7), index * version.interval)
      if (`${nextMonth}-01` > high) break
      const [nextYear, nextNumber] = nextMonth.split('-').map(Number) as [number, number]
      const date = clampedDate(nextYear, nextNumber, day)
      if (date >= low && date <= high) output.push(date)
      index++
    }
  } else {
    let index = Math.max(0, Math.floor((Number(low.slice(0, 4)) - year) / version.interval))
    for (
      let nextYear = year + index * version.interval;
      nextYear <= Number(high.slice(0, 4));
      nextYear += version.interval
    ) {
      const date = clampedDate(nextYear, month, day)
      if (date >= low && date <= high) output.push(date)
    }
  }
  return output
}
export type PlanningWorkspace = Pick<
  Workspace,
  'recurringVersions' | 'paymentOccurrences' | 'transactions' | 'deletedTransactions'
>
export function projectPayments(
  workspace: PlanningWorkspace,
  from: string,
  to: string,
): ProjectedPayment[] {
  const result = new Map<string, ProjectedPayment>()
  for (const version of workspace.recurringVersions)
    for (const dueDate of recurringDates(version, from, to)) {
      const key = `${version.recurringId}:${dueDate}`
      result.set(key, {
        id: key,
        recurringId: version.recurringId,
        dueDate,
        title: version.title,
        category: version.category,
        amount: version.amount,
        accountId: version.accountId,
        note: version.note,
        status: 'pending',
        transactionId: null,
        actualAmount: null,
        actualDate: null,
      })
    }
  const transactions = new Map(
    [...workspace.transactions, ...workspace.deletedTransactions].map((t) => [t.id, t]),
  )
  for (const occurrence of workspace.paymentOccurrences) {
    if (occurrence.dueDate < from || occurrence.dueDate > to) continue
    const transaction = occurrence.transactionId
      ? transactions.get(occurrence.transactionId)
      : undefined
    result.set(`${occurrence.recurringId}:${occurrence.dueDate}`, {
      ...occurrence,
      status:
        occurrence.status === 'paid' && (!transaction || transaction.deletedAt)
          ? 'deleted'
          : occurrence.status,
      actualAmount: transaction?.amount || null,
      actualDate: transaction?.date || null,
    })
  }
  return [...result.values()].sort(
    (a, b) => a.dueDate.localeCompare(b.dueDate) || a.title.localeCompare(b.title, 'ru'),
  )
}
export function categorySpending(transactions: Transaction[], month: string) {
  const totals = new Map<string, bigint>()
  for (const t of transactions)
    if (!t.deletedAt && t.kind === 'expense' && t.date.startsWith(month + '-'))
      totals.set(t.category, (totals.get(t.category) || 0n) + BigInt(t.amount))
  return totals
}
export function budgetRows(workspace: Workspace, month: string) {
  const spent = categorySpending(workspace.transactions, month),
    planned = new Map<string, bigint>()
  const range = monthRange(month)
  for (const item of projectPayments(workspace, range.from, range.to))
    if (item.status === 'pending' || item.status === 'deleted')
      planned.set(item.category, (planned.get(item.category) || 0n) + BigInt(item.amount))
  return workspace.budgets
    .filter((b) => b.month === month)
    .map((b) => {
      const actual = spent.get(b.category) || 0n,
        future = planned.get(b.category) || 0n,
        limit = BigInt(b.limit)
      return {
        ...b,
        spent: actual.toString(),
        planned: future.toString(),
        remaining: (limit - actual).toString(),
        afterPlanned: (limit - actual - future).toString(),
        percent:
          limit === 0n ? (actual > 0n ? 100 : 0) : Math.min(100, Number((actual * 100n) / limit)),
      }
    })
    .sort((a, b) => a.category.localeCompare(b.category, 'ru'))
}
export function frequencyLabel(frequency: string, interval: number) {
  return frequency === 'weekly'
    ? interval === 1
      ? 'Каждую неделю'
      : `Каждые ${interval} нед.`
    : frequency === 'yearly'
      ? interval === 1
        ? 'Каждый год'
        : `Каждые ${interval} лет`
      : interval === 1
        ? 'Каждый месяц'
        : `Каждые ${interval} мес.`
}
