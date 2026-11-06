import { describe, expect, it } from 'vitest'
import {
  balanceAt,
  forecast,
  forecastFlows,
  untilNextIncome,
  type ForecastWorkspace,
} from '../shared/forecast'
import type { Plan, PlanOccurrence, PlanVersion } from '../shared/planning-types'
import type { Account, Transaction } from '../shared/types'

const account = (id: string, openingBalance: string, extra: Partial<Account> = {}): Account => ({
  id,
  name: id,
  kind: 'card',
  openingBalance,
  color: 'green',
  bankName: '',
  last4: '',
  archived: false,
  inForecast: true,
  ...extra,
})
let seq = 0
const tx = (
  data: Partial<Transaction> & Pick<Transaction, 'kind' | 'amount' | 'accountId' | 'date'>,
): Transaction => ({
  id: `t${++seq}`,
  toAccountId: null,
  category: 'Другое',
  description: '',
  importKey: null,
  importAccountId: null,
  createdAt: `${data.date}T10:00:00Z`,
  deletedAt: null,
  ...data,
})
function plan(
  id: string,
  data: Partial<PlanVersion> & Pick<PlanVersion, 'amount' | 'startDate'>,
  direction: Plan['direction'] = 'expense',
): { plan: Plan; version: PlanVersion } {
  const version: PlanVersion = {
    id: `${id}-v`,
    planId: id,
    title: id,
    category: direction === 'income' ? 'Зарплата' : 'Дом',
    accountId: null,
    frequency: 'monthly',
    interval: 1,
    endDate: null,
    note: '',
    validFrom: '2020-01-01',
    validTo: null,
    ...data,
  }
  const { id: _id, planId: _planId, validFrom: _from, validTo: _to, ...fields } = version
  return {
    plan: { ...fields, id, active: true, direction, source: 'manual', sourceId: null },
    version,
  }
}
function workspace(
  accounts: Account[],
  plans: ReturnType<typeof plan>[] = [],
  transactions: Transaction[] = [],
  planOccurrences: PlanOccurrence[] = [],
): ForecastWorkspace {
  return {
    accounts,
    transactions,
    deletedTransactions: [],
    plans: plans.map((p) => p.plan),
    planVersions: plans.map((p) => p.version),
    planOccurrences,
  }
}
const occurrence = (
  planId: string,
  dueDate: string,
  data: Partial<PlanOccurrence>,
): PlanOccurrence => ({
  id: `${planId}:${dueDate}`,
  planId,
  dueDate,
  title: planId,
  category: 'Дом',
  amount: '0',
  accountId: null,
  note: '',
  status: 'pending',
  transactionId: null,
  movedTo: null,
  ...data,
})

describe('money forecast', () => {
  const today = '2026-01-28'
  it('builds balances per account and in total, crossing a month end', () => {
    const ws = workspace(
      [account('card', '100000'), account('cash', '5000')],
      [
        plan('rent', { amount: '80000', startDate: '2026-01-31', accountId: 'card' }),
        plan('salary', { amount: '150000', startDate: '2026-02-05', accountId: 'card' }, 'income'),
        plan('market', { amount: '7000', startDate: '2026-02-01', frequency: 'once' }),
      ],
    )
    const result = forecast(ws, today, 30)
    expect(result.from).toBe(today)
    expect(result.to).toBe('2026-02-27')
    expect(result.days).toHaveLength(31)
    expect(result.total).toMatchObject({
      start: '105000',
      incomes: '150000',
      payments: '87000',
      end: '168000',
      min: '18000',
      minDate: '2026-02-01',
      deficitDate: null,
    })
    const card = result.accounts.find((a) => a.account.id === 'card')!
    expect(card).toMatchObject({
      start: '100000',
      min: '20000',
      minDate: '2026-01-31',
      end: '170000',
    })
    // A plan without an account changes the total only.
    expect(result.unassigned).toMatchObject({ payments: '7000', incomes: '0' })
    expect(result.days.find((d) => d.date === '2026-02-01')!.accounts.card).toBe('20000')
  })

  it('finds the first deficit date on one account even when the total stays positive', () => {
    const ws = workspace(
      [account('card', '10000'), account('cash', '500000')],
      [plan('loan', { amount: '25000', startDate: '2026-02-03', accountId: 'card' })],
    )
    const result = forecast(ws, today, 30)
    expect(result.total.deficitDate).toBeNull()
    expect(result.accounts.find((a) => a.account.id === 'card')!).toMatchObject({
      deficitDate: '2026-02-03',
      min: '-15000',
    })
    // A balance that is already negative is a deficit from the first day.
    expect(forecast(workspace([account('card', '-1')]), today, 5).total.deficitDate).toBe(today)
  })

  it('keeps savings and archived accounts outside, with plans tied to them', () => {
    const ws = workspace(
      [
        account('card', '100000'),
        account('reserve', '900000', { kind: 'savings', inForecast: false }),
        account('old', '300', { archived: true }),
      ],
      [
        plan(
          'deposit',
          { amount: '10000', startDate: '2026-02-01', accountId: 'reserve' },
          'income',
        ),
      ],
    )
    const result = forecast(ws, today, 30)
    expect(result.total.start).toBe('100000')
    expect(result.accounts.map((a) => a.account.id)).toEqual(['card'])
    expect(result.outside.balance).toBe('900000')
    expect(result.outside.accounts.map((a) => a.id)).toEqual(['reserve'])
    expect(result.outside.events.map((e) => e.planId)).toEqual(['deposit'])
    expect(result.total.incomes).toBe('0')
  })

  it('counts a confirmed date once and brings back an overdue or unlinked one', () => {
    const paid = tx({ kind: 'expense', amount: '80000', accountId: 'card', date: '2026-01-27' })
    const ws = workspace(
      [account('card', '200000')],
      [
        plan('rent', { amount: '80000', startDate: '2026-01-27', accountId: 'card' }),
        plan('phone', { amount: '1000', startDate: '2026-01-20', accountId: 'card' }),
      ],
      [paid],
      [
        occurrence('rent', '2026-01-27', {
          status: 'paid',
          transactionId: paid.id,
          amount: '80000',
        }),
      ],
    )
    const result = forecast(ws, today, 10)
    // Rent is already in the balance; the overdue phone bill is expected today.
    expect(result.total.start).toBe('120000')
    expect(result.events.map((e) => [e.planId, e.date, e.overdue])).toEqual([
      ['phone', today, true],
    ])
    expect(result.total.payments).toBe('1000')

    // The confirming expense was deleted: the date is open again and expected once.
    const deleted = { ...paid, deletedAt: '2026-01-28T09:00:00Z' }
    const reopened = forecast(
      { ...ws, transactions: [], deletedTransactions: [deleted] },
      today,
      10,
    )
    expect(reopened.total.start).toBe('200000')
    expect(reopened.events.filter((e) => e.planId === 'rent')).toHaveLength(1)
    expect(reopened.total.payments).toBe('81000')
  })

  it('uses a moved date and amount and skips cancelled dates', () => {
    const ws = workspace(
      [account('card', '50000')],
      [
        plan('gym', {
          amount: '3000',
          startDate: '2026-01-29',
          accountId: 'card',
          frequency: 'weekly',
        }),
      ],
      [],
      [
        occurrence('gym', '2026-01-29', { movedTo: '2026-03-10', amount: '3500' }),
        occurrence('gym', '2026-02-05', { status: 'skipped', amount: '3000' }),
      ],
    )
    const result = forecast(ws, today, 15)
    expect(result.events.map((e) => [e.dueDate, e.date])).toEqual([['2026-02-12', '2026-02-12']])
    const longer = forecast(ws, today, 60)
    expect(longer.events.find((e) => e.dueDate === '2026-01-29')).toMatchObject({
      date: '2026-03-10',
      amount: '3500',
    })
  })

  it('handles leap days on the horizon', () => {
    const ws = workspace(
      [account('card', '0')],
      [plan('fee', { amount: '100', startDate: '2028-01-31', accountId: 'card' })],
    )
    const result = forecast(ws, '2028-02-01', 30)
    expect(result.to).toBe('2028-03-02')
    // January 31 is overdue on February 1 and is expected on the first day.
    expect(result.events.map((e) => [e.date, e.overdue])).toEqual([
      ['2028-02-01', true],
      ['2028-02-29', false],
    ])
  })

  it('tells what is due before the next income', () => {
    const ws = workspace(
      [account('card', '30000')],
      [
        plan('rent', { amount: '25000', startDate: '2026-02-01', accountId: 'card' }),
        plan('phone', { amount: '1000', startDate: '2026-02-03', accountId: 'card' }),
        plan('salary', { amount: '150000', startDate: '2026-02-05', accountId: 'card' }, 'income'),
      ],
    )
    const next = untilNextIncome(forecast(ws, today, 30))!
    expect(next.income.planId).toBe('salary')
    expect(next.payments.map((p) => p.planId)).toEqual(['rent', 'phone'])
    expect(next.paymentsTotal).toBe('26000')
    expect(next.lowest).toBe('4000')
    expect(untilNextIncome(forecast(workspace([account('card', '1')]), today, 30))).toBeNull()
  })
})

describe('forecast flows', () => {
  it('shows transfers to accounts outside the forecast as an outflow', () => {
    const accounts = [
      account('card', '100000'),
      account('cash', '0'),
      account('reserve', '0', { kind: 'savings', inForecast: false }),
    ]
    const transactions = [
      tx({ kind: 'income', amount: '50000', accountId: 'card', date: '2025-12-31' }),
      tx({ kind: 'expense', amount: '2000', accountId: 'card', date: '2026-01-05' }),
      tx({
        kind: 'transfer',
        amount: '7000',
        accountId: 'card',
        toAccountId: 'cash',
        date: '2026-01-06',
      }),
      tx({
        kind: 'transfer',
        amount: '30000',
        accountId: 'card',
        toAccountId: 'reserve',
        date: '2026-01-07',
      }),
      tx({
        kind: 'transfer',
        amount: '1000',
        accountId: 'reserve',
        toAccountId: 'cash',
        date: '2026-01-08',
      }),
      tx({ kind: 'adjustment', amount: '-500', accountId: 'cash', date: '2026-01-09' }),
      tx({ kind: 'income', amount: '9000', accountId: 'reserve', date: '2026-01-10' }),
      tx({
        kind: 'expense',
        amount: '1',
        accountId: 'card',
        date: '2026-01-11',
        deletedAt: '2026-01-12T00:00:00Z',
      }),
    ]
    const flows = forecastFlows({ accounts, transactions }, '2026-01-01', '2026-01-31')
    expect(flows).toEqual({
      opening: '150000',
      incomes: '0',
      expenses: '2000',
      adjustments: '-500',
      transfersOut: '30000',
      transfersIn: '1000',
      closing: '118500',
    })
    expect(balanceAt({ accounts, transactions }, '2026-01-31')).toBe(flows.closing)
    expect(balanceAt({ accounts, transactions }, '2026-01-05')).toBe('148000')
  })
})
