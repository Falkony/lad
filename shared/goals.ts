import { z } from 'zod'
import type { Workspace, Goal } from './types'
import { forecast } from './forecast'
import { accountBalance } from './money'
export const goalFundingSchema = z.object({
  unassigned: z
    .string()
    .regex(/^\d{1,16}$/)
    .default('0'),
  entries: z
    .array(
      z.object({
        id: z.uuid(),
        accountId: z.uuid(),
        amount: z.string().regex(/^-?\d{1,16}$/),
        date: z.iso.date(),
        note: z.string().max(300),
      }),
    )
    .max(2000)
    .default([]),
  purchases: z
    .array(z.object({ transactionId: z.uuid(), refundIds: z.array(z.uuid()).max(100) }))
    .max(100)
    .default([]),
})
export type GoalFunding = z.infer<typeof goalFundingSchema>
export const fundingOf = (goal: Goal): GoalFunding =>
  goal.funding || { unassigned: goal.saved, entries: [], purchases: [] }
export function goalAllocations(goal: Goal) {
  const totals = new Map<string, bigint>()
  for (const e of fundingOf(goal).entries)
    totals.set(e.accountId, (totals.get(e.accountId) || 0n) + BigInt(e.amount))
  return totals
}
export function reservedByAccount(workspace: Pick<Workspace, 'goals'>) {
  const totals = new Map<string, bigint>()
  for (const goal of workspace.goals)
    for (const [id, amount] of goalAllocations(goal))
      totals.set(id, (totals.get(id) || 0n) + amount)
  return totals
}
export function decisionMoney(w: Workspace, today: string, days = 90) {
  const result = forecast(
      {
        ...w,
        accounts: w.accounts.map((a) => ({
          ...a,
          inForecast: a.inForecast && a.kind !== 'credit',
        })),
      },
      today,
      days,
    ),
    reserved = reservedByAccount(w)
  const ids = new Set(
    w.accounts.filter((a) => a.inForecast && !a.archived && a.kind !== 'credit').map((a) => a.id),
  )
  const reserve = [...reserved].filter(([id]) => ids.has(id)).reduce((s, [, v]) => s + v, 0n)
  const releasedGoals = new Set<string>()
  const releases = result.events.flatMap((e) => {
    const plan = w.plans.find((p) => p.id === e.planId && p.source === 'goal')
    const goal = w.goals.find((g) => g.id === plan?.sourceId)
    if (!goal || releasedGoals.has(goal.id)) return []
    releasedGoals.add(goal.id)
    return goal
      ? [
          {
            date: e.date,
            amount: [...goalAllocations(goal)]
              .filter(([id]) => ids.has(id))
              .reduce((s, [, v]) => s + v, 0n),
          },
        ]
      : []
  })
  let minimum = BigInt(result.total.start) - reserve
  for (const day of result.days) {
    const released = releases.filter((r) => r.date <= day.date).reduce((s, r) => s + r.amount, 0n)
    const free = BigInt(day.total) - reserve + released
    if (free < minimum) minimum = free
  }
  return {
    current: result.total.start,
    minimum: result.total.min,
    reserved: reserve.toString(),
    available: minimum.toString(),
    payments: result.total.payments,
    unassigned: result.unassigned.payments,
    from: today,
    to: result.to,
  }
}
export function goalFeasibility(goal: Goal, w: Workspace, today: string) {
  const reserved = [...goalAllocations(goal).values()].reduce((s, a) => s + a, 0n),
    target = BigInt(goal.target)
  const months = goal.deadline
    ? Math.max(
        0,
        (Number(goal.deadline.slice(0, 4)) - Number(today.slice(0, 4))) * 12 +
          Number(goal.deadline.slice(5, 7)) -
          Number(today.slice(5, 7)),
      )
    : 0
  const estimated = reserved + BigInt(goal.monthlyContribution || '0') * BigInt(months)
  return {
    reserved: reserved.toString(),
    estimated: estimated.toString(),
    missing: (target > reserved ? target - reserved : 0n).toString(),
    onTrack: estimated >= target,
    free: decisionMoney(w, today).available,
  }
}
export function freeOnAccount(
  w: Pick<Workspace, 'goals' | 'transactions'>,
  a: Workspace['accounts'][number],
) {
  return BigInt(accountBalance(a, w.transactions)) - (reservedByAccount(w).get(a.id) || 0n)
}
/** Referential checks shared by restore preview and the transactional command boundary. */
export function goalFundingIssues(
  w: Pick<Workspace, 'goals' | 'accounts' | 'transactions' | 'deletedTransactions' | 'categories'>,
  checkSaved = false,
) {
  const issues: string[] = [],
    history = [...w.transactions, ...w.deletedTransactions],
    used = new Set<string>()
  for (const goal of w.goals) {
    const funding = fundingOf(goal),
      allocations = new Map<string, bigint>(),
      ids = new Set<string>()
    if (goal.categoryId && !w.categories?.some((c) => c.id === goal.categoryId))
      issues.push('Категория цели не найдена')
    for (const e of funding.entries) {
      if (ids.has(e.id)) issues.push('Повтор записи накоплений')
      ids.add(e.id)
      const value = (allocations.get(e.accountId) || 0n) + BigInt(e.amount)
      if (value < 0n) issues.push('Нельзя изъять больше резерва цели')
      allocations.set(e.accountId, value)
      if (!w.accounts.some((a) => a.id === e.accountId)) issues.push('Счёт накоплений не найден')
    }
    const saved = BigInt(funding.unassigned) + [...allocations.values()].reduce((s, a) => s + a, 0n)
    if (saved > 9000000000000000n || (checkSaved && saved !== BigInt(goal.saved)))
      issues.push('Сумма накоплений не совпадает с историей')
    for (const p of funding.purchases) {
      const original = history.find((t) => t.id === p.transactionId)
      if (!original || original.kind !== 'expense')
        issues.push('Покупка должна ссылаться на расход')
      if (used.has(p.transactionId)) issues.push('Покупка связана с несколькими целями')
      used.add(p.transactionId)
      let refunded = 0n
      for (const id of p.refundIds) {
        const t = history.find((t) => t.id === id)
        if (!t || t.kind !== 'income' || (original && t.date < original.date))
          issues.push('Некорректная операция возврата')
        if (used.has(id)) issues.push('Один возврат связан несколько раз')
        used.add(id)
        if (t && !t.deletedAt) refunded += BigInt(t.amount)
      }
      if (original && refunded > BigInt(original.amount)) issues.push('Возвраты превышают покупку')
    }
  }
  for (const [id, amount] of reservedByAccount(w)) {
    const a = w.accounts.find((a) => a.id === id)
    if (
      amount > 0n &&
      (!a ||
        a.archived ||
        a.kind === 'credit' ||
        BigInt(accountBalance(a, w.transactions)) < amount)
    )
      issues.push('Недостаточно собственных денег для всех резервов')
  }
  return issues
}
