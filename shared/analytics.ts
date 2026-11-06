import type { Workspace } from './types'
import type { MonthReport, Reconciliation } from './periods'
import { accountBalance } from './money'
import { monthRange, monthPlan, categorySpending, projectPlans, isOpen, addDays } from './planning'
import { categoryAmounts } from './transaction-details'
import { obligationState } from './obligations'
export function analyzeMonth(
  w: Workspace,
  month: string,
  reconciliations: Reconciliation[] = [],
): MonthReport {
  const { from, to } = monthRange(month),
    active = w.transactions.filter((t) => !t.deletedAt && t.date <= to),
    period = active.filter((t) => t.date >= from),
    asof = {
      ...w,
      transactions: active,
      deletedTransactions: w.deletedTransactions.filter((t) => t.date <= to),
    },
    plan = monthPlan(asof, month)
  const projections = projectPlans(asof, from, to),
    spent = categorySpending(active, month),
    names = new Set([
      ...spent.keys(),
      ...w.budgets.filter((b) => b.month === month).map((b) => b.category),
      ...projections
        .filter((p) => p.direction === 'expense' && p.source !== 'credit')
        .map((p) => p.category),
    ])
  const categories = [...names].sort().map((category) => {
    const limit =
        w.budgets.find((b) => b.month === month && b.category === category)?.limit ?? null,
      actual = spent.get(category) || 0n,
      planned = projections
        .filter(
          (p) =>
            p.category === category &&
            p.direction === 'expense' &&
            p.source !== 'credit' &&
            isOpen(p),
        )
        .reduce((s, p) => s + BigInt(p.amount), 0n)
    return {
      category,
      limit,
      spent: actual.toString(),
      planned: planned.toString(),
      over: limit !== null && actual > BigInt(limit) ? (actual - BigInt(limit)).toString() : '0',
      transactionIds: period
        .filter((t) => categoryAmounts(t).some((p) => (p.category || t.category) === category))
        .map((t) => t.id),
    }
  })
  const accounts = w.accounts
    .map((a) => {
      const opening = accountBalance(
          a,
          active.filter((t) => t.date < from),
        ),
        closing = accountBalance(a, active)
      return {
        id: a.id,
        name: a.name,
        opening,
        closing,
        reconciled: reconciliations.some(
          (r) => r.accountId === a.id && r.date === to && r.balance === closing,
        ),
        creditDebt:
          a.kind === 'credit' && BigInt(closing) < 0n ? (-BigInt(closing)).toString() : '0',
      }
    })
    .filter(
      (a) =>
        BigInt(a.opening) !== 0n ||
        BigInt(a.closing) !== 0n ||
        period.some((t) => t.accountId === a.id || t.toAccountId === a.id),
    )
  const obligations = w.obligations
    .filter((o) => o.startDate <= to)
    .map((o) => {
      const before = obligationState(
          o,
          w.obligationEntries.filter((e) => e.date < from),
          new Set(active.filter((t) => t.date < from).map((t) => t.id)),
        ),
        after = obligationState(
          o,
          w.obligationEntries.filter((e) => e.date <= to),
          new Set(active.map((t) => t.id)),
        ),
        entries = w.obligationEntries.filter(
          (e) =>
            e.obligationId === o.id &&
            e.kind === 'payment' &&
            e.date >= from &&
            e.date <= to &&
            !!e.transactionId &&
            active.some((t) => t.id === e.transactionId),
        )
      return {
        id: o.id,
        title: o.title,
        kind: o.kind,
        opening: o.startDate >= from ? '0' : before.remaining.toString(),
        closing: after.remaining.toString(),
        principal: entries.reduce((s, e) => s + BigInt(e.principal), 0n).toString(),
        interest: entries.reduce((s, e) => s + BigInt(e.interest), 0n).toString(),
        fees: entries.reduce((s, e) => s + BigInt(e.fees), 0n).toString(),
      }
    })
  const recurring = w.plans
    .filter(
      (p) =>
        p.direction === 'expense' &&
        p.source !== 'credit' &&
        p.source !== 'goal' &&
        p.frequency !== 'once',
    )
    .map((p) => {
      const rows = projections.filter((r) => r.planId === p.id)
      return {
        id: p.id,
        title: p.title,
        source: p.source,
        planned: rows.reduce((s, r) => s + BigInt(r.amount), 0n).toString(),
        actual: rows
          .filter((r) => r.status === 'paid' && r.actualDate! >= from && r.actualDate! <= to)
          .reduce((s, r) => s + BigInt(r.actualAmount || '0'), 0n)
          .toString(),
      }
    })
    .filter((r) => r.planned !== '0' || r.actual !== '0')
  const issues: MonthReport['issues'] = accounts
    .filter((a) => !a.reconciled)
    .map((a) => ({
      code: 'unreconciled',
      message: `${a.name}: нет совпадающей сверки на ${to}`,
      accountId: a.id,
    }))
  for (const t of period)
    if (
      !t.refundOf &&
      !t.splits?.length &&
      t.category === 'Другое' &&
      ['income', 'expense'].includes(t.kind)
    )
      issues.push({
        code: 'uncategorized',
        message: `${t.date}: уточните категорию «${t.description || t.category}»`,
        transactionId: t.id,
      })
  const overdue = projectPlans(asof, addDays(from, -90), to).filter(isOpen)
  for (const p of overdue)
    issues.push({
      code: 'open-plan',
      message: `${p.date}: не подтверждён план «${p.title}»`,
      planId: p.planId,
      dueDate: p.dueDate,
    })
  const grouped = new Map<string, string>()
  for (const t of period) {
    if (t.kind === 'transfer' || t.kind === 'adjustment') continue
    const key = [t.date, t.kind, t.amount, t.accountId, t.description].join('|')
    const previous = grouped.get(key)
    if (previous)
      issues.push({
        code: 'possible-duplicate',
        message: `${t.date}: проверьте возможный дубль «${t.description || t.category}»`,
        transactionId: t.id,
      })
    else grouped.set(key, t.id)
  }
  return {
    version: 1,
    month,
    from,
    to,
    sourceRevision: w.revision,
    income: plan.received,
    expenses: plan.spent,
    net: (BigInt(plan.received) - BigInt(plan.spent)).toString(),
    expectedIncome: plan.expectedIncome,
    expectedPayments: plan.expectedPayments,
    accounts,
    categories,
    obligations,
    recurring,
    issues,
    inputs: { transactions: [...period].sort((a, b) => a.id.localeCompare(b.id)), projections },
  }
}
export function compareReports(current: MonthReport, previous: MonthReport) {
  return {
    income: (BigInt(current.income) - BigInt(previous.income)).toString(),
    expenses: (BigInt(current.expenses) - BigInt(previous.expenses)).toString(),
    net: (BigInt(current.net) - BigInt(previous.net)).toString(),
    debtPayments: (
      current.obligations
        .filter((o) => o.kind !== 'receivable')
        .reduce((s, o) => s + BigInt(o.principal) + BigInt(o.interest) + BigInt(o.fees), 0n) -
      previous.obligations
        .filter((o) => o.kind !== 'receivable')
        .reduce((s, o) => s + BigInt(o.principal) + BigInt(o.interest) + BigInt(o.fees), 0n)
    ).toString(),
  }
}
