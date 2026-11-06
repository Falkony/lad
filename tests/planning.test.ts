import { describe, expect, it } from 'vitest'
import {
  budgetRows,
  categorySpending,
  monthRange,
  recurringDates,
  shiftMonth,
} from '../shared/planning'
import type { RecurringVersion } from '../shared/planning-types'
import type { Transaction, Workspace } from '../shared/types'

const schedule: RecurringVersion = {
  id: 'version',
  recurringId: 'rule',
  title: 'Связь',
  category: 'Дом',
  amount: '10000',
  accountId: null,
  frequency: 'monthly',
  interval: 1,
  startDate: '2026-01-31',
  endDate: null,
  note: '',
  validFrom: '2026-01-01',
  validTo: null,
}
const expense: Transaction = {
  id: 'expense',
  kind: 'expense',
  amount: '4000',
  accountId: 'account',
  toAccountId: null,
  category: 'Дом',
  description: '',
  date: '2026-02-10',
  importKey: null,
  importAccountId: null,
  createdAt: '2026-02-10T00:00:00Z',
  deletedAt: null,
}
describe('anchored recurring dates', () => {
  it('clamps month ends without drifting the original day', () => {
    expect(recurringDates(schedule, '2026-01-01', '2026-04-30')).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
    ])
    expect(recurringDates({ ...schedule, interval: 2 }, '2026-02-01', '2026-08-01')).toEqual([
      '2026-03-31',
      '2026-05-31',
      '2026-07-31',
    ])
  })
  it('keeps leap-day anniversaries and clips all date bounds inclusively', () => {
    const leap = {
      ...schedule,
      frequency: 'yearly' as const,
      startDate: '2024-02-29',
      validFrom: '2024-02-29',
    }
    expect(recurringDates(leap, '2024-01-01', '2028-12-31')).toEqual([
      '2024-02-29',
      '2025-02-28',
      '2026-02-28',
      '2027-02-28',
      '2028-02-29',
    ])
    expect(
      recurringDates(
        { ...schedule, validFrom: '2026-02-01', validTo: '2026-03-31', endDate: '2026-02-28' },
        '2026-01-01',
        '2026-12-31',
      ),
    ).toEqual(['2026-02-28'])
  })
  it('uses whole UTC days across DST and year boundaries', () => {
    expect(
      recurringDates(
        { ...schedule, frequency: 'weekly', interval: 2, startDate: '2026-03-22' },
        '2026-03-23',
        '2026-04-20',
      ),
    ).toEqual(['2026-04-05', '2026-04-19'])
    expect(
      recurringDates(
        { ...schedule, frequency: 'weekly', startDate: '2026-12-27' },
        '2026-12-27',
        '2027-01-10',
      ),
    ).toEqual(['2026-12-27', '2027-01-03', '2027-01-10'])
    expect(monthRange('2024-02')).toEqual({ from: '2024-02-01', to: '2024-02-29' })
    expect(shiftMonth('2026-12', 1)).toBe('2027-01')
  })
})
describe('monthly budget accounting', () => {
  it('counts only active expenses dated in the selected month', () => {
    expect(
      categorySpending(
        [
          expense,
          { ...expense, kind: 'income' },
          { ...expense, kind: 'transfer' },
          { ...expense, kind: 'adjustment', amount: '-500' },
          { ...expense, deletedAt: '2026-02-11T00:00:00Z' },
          { ...expense, date: '2026-01-31' },
        ],
        '2026-02',
      ).get('Дом'),
    ).toBe(4000n)
  })
  it('separates actual spending from unpaid plans and avoids counting paid plans twice', () => {
    const state = {
      budgets: [{ id: 'b', month: '2026-02', category: 'Дом', limit: '12000' }],
      recurringVersions: [schedule],
      paymentOccurrences: [],
      transactions: [expense],
      deletedTransactions: [],
    } as unknown as Workspace
    expect(budgetRows(state, '2026-02')[0]).toMatchObject({
      spent: '4000',
      planned: '10000',
      remaining: '8000',
      afterPlanned: '-2000',
    })
    state.paymentOccurrences = [
      {
        id: 'p',
        recurringId: 'rule',
        dueDate: '2026-02-28',
        title: 'Связь',
        category: 'Дом',
        amount: '10000',
        accountId: null,
        note: '',
        status: 'paid',
        transactionId: expense.id,
      },
    ]
    expect(budgetRows(state, '2026-02')[0]).toMatchObject({
      spent: '4000',
      planned: '0',
      afterPlanned: '8000',
    })
    state.budgets[0]!.limit = '0'
    expect(budgetRows(state, '2026-02')[0]).toMatchObject({ remaining: '-4000', percent: 100 })
    state.transactions = []
    expect(budgetRows(state, '2026-02')[0]!.percent).toBe(0)
  })
})
