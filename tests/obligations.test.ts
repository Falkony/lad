import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PGlite } from '@electric-sql/pglite'
import { commandSchema, executeCommand, readWorkspace } from '../server/modules/workspace'
import { migration } from '../server/db/migration'
import { obligationMigration } from '../server/db/obligation-migration'
import { backupSchema, createBackup } from '../shared/backup'
import { localDate } from '../shared/money'
import { addDays, projectPlans, shiftMonth } from '../shared/planning'
import {
  annuityPayment,
  dueDateIn,
  firstDueDate,
  monthEnd,
  monthlyInterest,
  obligationOutlook,
  paymentSchedule,
  suggestSplit,
} from '../shared/obligations'
import type { Workspace } from '../shared/types'

describe('repayment arithmetic', () => {
  it('estimates monthly interest in kopecks without floating point', () => {
    expect(monthlyInterest(120000000n, '12')).toBe(1200000n) // 1 200 000 ₽ at 12 % → 12 000 ₽
    expect(monthlyInterest(100000n, '8.5')).toBe(708n) // 708.33 → 708 kopecks
    expect(monthlyInterest(100000n, '0')).toBe(0n)
    expect(monthlyInterest(-5n, '10')).toBe(0n)
  })
  it('clamps the payment day to the month', () => {
    expect(dueDateIn('2026-02', 31)).toBe('2026-02-28')
    expect(dueDateIn('2028-02', 30)).toBe('2028-02-29')
    expect(firstDueDate('2026-11-21', 20)).toBe('2026-12-20')
    expect(firstDueDate('2026-11-20', 20)).toBe('2026-11-20')
    expect(monthEnd('2026-02-10')).toBe('2026-02-28')
  })
  it('builds a schedule that repays the balance with a smaller last payment', () => {
    const { rows, complete } = paymentSchedule(1000000n, '12', 260000n, '2026-11-20', 20)
    expect(complete).toBe(true)
    expect(rows.map((r) => r.date)).toEqual([
      '2026-11-20',
      '2026-12-20',
      '2027-01-20',
      '2027-02-20',
    ])
    expect(rows[0]).toMatchObject({ interest: 10000n, principal: 250000n, remaining: 750000n })
    expect(rows.at(-1)!.remaining).toBe(0n)
    expect(rows.at(-1)!.payment < 260000n).toBe(true)
    // A payment that does not cover the interest never repays the debt.
    expect(paymentSchedule(1000000n, '12', 10000n, '2026-11-20', 20).complete).toBe(false)
  })
  it('finds the smallest annuity payment for a term', () => {
    const payment = annuityPayment(1000000n, '12', 4)
    expect(paymentSchedule(1000000n, '12', payment, '2026-11-20', 20).rows).toHaveLength(4)
    expect(paymentSchedule(1000000n, '12', payment - 1n, '2026-11-20', 20).rows).toHaveLength(5)
    expect(annuityPayment(1000n, '0', 4)).toBe(250n)
  })
  it('splits a payment into this month interest and principal', () => {
    expect(suggestSplit(1000000n, '12', 260000n, false)).toEqual({
      interest: 10000n,
      principal: 250000n,
    })
    expect(suggestSplit(1000000n, '12', 260000n, true)).toEqual({
      interest: 0n,
      principal: 260000n,
    })
    expect(suggestSplit(1000000n, '12', 5000n, false)).toEqual({ interest: 5000n, principal: 0n })
  })
})

const run = (value: unknown) => executeCommand(commandSchema.parse(value))
const today = localDate()
const start = `${shiftMonth(today.slice(0, 7), -1)}-01`
let account = ''
async function setup() {
  await run({ op: 'account.create', data: { name: 'Карта', openingBalance: '100000000' } })
  account = (await readWorkspace()).accounts[0]!.id
}
async function createLoan(data: Record<string, unknown> = {}) {
  await run({
    op: 'obligation.create',
    data: {
      title: 'Кредит',
      kind: 'credit',
      openingBalance: '1000000',
      startDate: start,
      accountId: account,
      payment: '260000',
      dueDay: 1,
      rate: '12',
      ...data,
    },
  })
  const w = await readWorkspace()
  return w.obligations.find((o) => o.title === (data.title || 'Кредит'))!
}
const outlook = (w: Workspace, id: string) =>
  obligationOutlook(
    w.obligations.find((o) => o.id === id)!,
    w,
  )
const planOf = (w: Workspace, id: string) =>
  w.plans.find((p) => p.source === 'obligation' && p.sourceId === id)
async function pay(id: string, extra: Record<string, unknown> = {}) {
  const w = await readWorkspace()
  return run({
    op: 'obligation.pay',
    obligationId: id,
    expectedRevision: w.revision,
    date: start,
    principal: '250000',
    interest: '10000',
    mode: 'create',
    accountId: account,
    dueDate: start,
    ...extra,
  })
}

describe('obligation repayment', () => {
  beforeAll(async () => {
    process.env.LAD_DATA_DIR = join(await mkdtemp(join(tmpdir(), 'lad-obligations-')), 'db')
    delete process.env.DATABASE_URL
  })
  beforeEach(async () => {
    await run({ op: 'workspace.reset', confirmation: 'УДАЛИТЬ' })
    await setup()
  })

  it('creates the payment schedule as a plan ending in the month of payoff', async () => {
    const loan = await createLoan()
    const w = await readWorkspace()
    const plan = planOf(w, loan.id)!
    expect(plan).toMatchObject({
      direction: 'expense',
      category: 'Кредиты и долги',
      amount: '260000',
      monthDays: [1],
      startDate: start,
      accountId: account,
    })
    const o = outlook(w, loan.id)
    expect(o.schedule).toHaveLength(4)
    expect(plan.endDate).toBe(monthEnd(o.payoff!))
    const dates = projectPlans(w, start, addDays(start, 400)).filter((d) => d.planId === plan.id)
    expect(dates).toHaveLength(4)
    // The schedule is edited through the obligation, not as a plan.
    await expect(run({ op: 'plan.toggle', id: plan.id, active: false })).rejects.toThrow(
      /Кредиты и долги/,
    )
  })

  it('records a payment once: transaction, split, settled date and lower balance', async () => {
    const loan = await createLoan()
    const result = await pay(loan.id)
    const w = await readWorkspace()
    const tx = w.transactions.find((t) => t.id === result.transactionId)!
    expect(tx).toMatchObject({ kind: 'expense', amount: '260000', category: 'Кредиты и долги' })
    expect(w.obligationEntries).toHaveLength(1)
    expect(w.obligationEntries[0]).toMatchObject({ principal: '250000', interest: '10000' })
    expect(outlook(w, loan.id).remaining).toBe(750000n)
    const date = projectPlans(w, start, start).find((d) => d.planId === planOf(w, loan.id)!.id)!
    expect(date).toMatchObject({ status: 'paid', transactionId: tx.id })
    // Paying the same scheduled date again is rejected.
    await expect(pay(loan.id)).rejects.toThrow()
    expect((await readWorkspace()).transactions).toHaveLength(1)
  })

  it('splits a payment confirmed from the plans section automatically', async () => {
    const loan = await createLoan()
    const w = await readWorkspace()
    await run({
      op: 'occurrence.confirm',
      planId: planOf(w, loan.id)!.id,
      dueDate: start,
      expectedRevision: w.revision,
      date: start,
      mode: 'create',
      accountId: account,
      amount: '260000',
    })
    const after = await readWorkspace()
    expect(after.obligationEntries[0]).toMatchObject({ principal: '250000', interest: '10000' })
    expect(outlook(after, loan.id).remaining).toBe(750000n)
  })

  it('follows deletion and restoration of the transaction', async () => {
    const loan = await createLoan()
    const { transactionId } = await pay(loan.id)
    await run({ op: 'transaction.delete', id: transactionId })
    let w = await readWorkspace()
    expect(outlook(w, loan.id).remaining).toBe(1000000n)
    expect(outlook(w, loan.id).firstOpen).toBe(start)
    await run({ op: 'transaction.restore', id: transactionId })
    w = await readWorkspace()
    expect(outlook(w, loan.id).remaining).toBe(750000n)
  })

  it('keeps the transaction and the split consistent when the transaction is edited', async () => {
    const loan = await createLoan()
    const { transactionId } = await pay(loan.id)
    const tx = (await readWorkspace()).transactions[0]!
    const data = {
      kind: 'expense',
      amount: tx.amount,
      accountId: account,
      category: tx.category,
      description: tx.description,
      date: addDays(start, 1),
    }
    await expect(
      run({ op: 'transaction.update', id: transactionId, data: { ...data, amount: '1' } }),
    ).rejects.toThrow(/Кредиты и долги/)
    await run({ op: 'transaction.update', id: transactionId, data })
    expect((await readWorkspace()).obligationEntries[0]!.date).toBe(addDays(start, 1))
  })

  it('rejects an overpayment of the principal', async () => {
    const loan = await createLoan()
    await expect(pay(loan.id, { principal: '1000001', dueDate: null })).rejects.toThrow(
      /погашено больше долга/,
    )
    expect((await readWorkspace()).transactions).toHaveLength(0)
  })

  it('edits and cancels a payment, returning the date to the schedule', async () => {
    const loan = await createLoan()
    const { transactionId } = await pay(loan.id)
    let w = await readWorkspace()
    const entry = w.obligationEntries[0]!
    await run({
      op: 'obligation.payment.update',
      id: entry.id,
      expectedRevision: w.revision,
      date: start,
      principal: '200000',
      interest: '10000',
      fees: '500',
    })
    w = await readWorkspace()
    expect(w.transactions[0]!.amount).toBe('210500')
    expect(outlook(w, loan.id).remaining).toBe(800000n)
    await run({
      op: 'obligation.payment.cancel',
      id: entry.id,
      expectedRevision: w.revision,
      deleteTransaction: true,
    })
    w = await readWorkspace()
    expect(w.obligationEntries).toEqual([])
    expect(w.deletedTransactions.map((t) => t.id)).toEqual([transactionId])
    expect(outlook(w, loan.id).remaining).toBe(1000000n)
    const date = projectPlans(w, start, start).find((d) => d.planId === planOf(w, loan.id)!.id)!
    expect(date.status).toBe('pending')
  })

  it('shortens the term or lowers the payment after an early repayment', async () => {
    const loan = await createLoan({ openingBalance: '10000000', payment: '500000' })
    let w = await readWorkspace()
    const before = outlook(w, loan.id)
    await pay(loan.id, {
      principal: '3000000',
      interest: '0',
      dueDate: null,
      early: 'term',
    })
    w = await readWorkspace()
    const term = outlook(w, loan.id)
    expect(term.schedule.length).toBeLessThan(before.schedule.length)
    expect(planOf(w, loan.id)!.endDate).toBe(monthEnd(term.payoff!))
    const months = term.schedule.length
    await pay(loan.id, {
      principal: '2000000',
      interest: '0',
      dueDate: null,
      early: 'payment',
    })
    w = await readWorkspace()
    const lowered = w.obligations[0]!
    expect(BigInt(lowered.payment)).toBeLessThan(500000n)
    expect(outlook(w, loan.id).schedule).toHaveLength(months)
    expect(planOf(w, loan.id)!.amount).toBe(lowered.payment)
    // Cancelling the early repayment brings the previous payment back.
    const entry = w.obligationEntries.find((e) => e.early === 'payment')!
    await run({
      op: 'obligation.payment.cancel',
      id: entry.id,
      expectedRevision: w.revision,
      deleteTransaction: true,
    })
    w = await readWorkspace()
    expect(w.obligations[0]!.payment).toBe('500000')
    expect(planOf(w, loan.id)!.amount).toBe('500000')
  })

  it('reconciles the balance with the bank and keeps the correction in history', async () => {
    const loan = await createLoan()
    let w = await readWorkspace()
    await expect(
      run({
        op: 'obligation.reconcile',
        id: loan.id,
        expectedRevision: w.revision,
        date: today,
        actual: '990000',
        expected: '1',
      }),
    ).rejects.toThrow(/изменился/)
    w = await readWorkspace()
    await run({
      op: 'obligation.reconcile',
      id: loan.id,
      expectedRevision: w.revision,
      date: today,
      actual: '990000',
      expected: '1000000',
    })
    w = await readWorkspace()
    expect(w.obligationEntries[0]).toMatchObject({ kind: 'adjustment', principal: '-10000' })
    expect(outlook(w, loan.id)).toMatchObject({ remaining: 990000n, adjusted: -10000n })
  })

  it('ends the schedule once the debt is repaid', async () => {
    const loan = await createLoan()
    await pay(loan.id, { principal: '1000000', interest: '10000' })
    const w = await readWorkspace()
    expect(outlook(w, loan.id).remaining).toBe(0n)
    const plan = planOf(w, loan.id)!
    expect(plan.endDate! >= start).toBe(true)
    const future = projectPlans(w, addDays(start, 1), addDays(start, 400)).filter(
      (d) => d.planId === plan.id,
    )
    expect(future).toEqual([])
  })

  it('records a returned debt as an income', async () => {
    const loan = await createLoan({
      title: 'Займ другу',
      kind: 'receivable',
      rate: '0',
      payment: '0',
    })
    let w = await readWorkspace()
    expect(planOf(w, loan.id)).toBeUndefined()
    await pay(loan.id, { principal: '400000', interest: '0', dueDate: null })
    w = await readWorkspace()
    expect(w.transactions[0]).toMatchObject({ kind: 'income', category: 'Возврат долга' })
    expect(outlook(w, loan.id).remaining).toBe(600000n)
  })

  it('protects the history: no deletion with repayments, no direction change', async () => {
    const loan = await createLoan()
    await pay(loan.id)
    await expect(run({ op: 'obligation.delete', id: loan.id })).rejects.toThrow(/истори/)
    const w = await readWorkspace()
    await expect(
      run({
        op: 'obligation.update',
        id: loan.id,
        data: { ...w.obligations[0]!, kind: 'receivable' },
      }),
    ).rejects.toThrow()
    const other = await createLoan({ title: 'Без истории' })
    await run({ op: 'obligation.delete', id: other.id })
    expect(planOf(await readWorkspace(), other.id)).toBeUndefined()
  })

  it('round-trips repayments through a backup and upgrades older copies', async () => {
    const loan = await createLoan()
    await pay(loan.id)
    const original = await readWorkspace()
    const backup = JSON.parse(JSON.stringify(createBackup(original)))
    await run({ op: 'workspace.reset', confirmation: 'УДАЛИТЬ' })
    await run({
      op: 'workspace.restore',
      backup,
      expectedRevision: (await readWorkspace()).revision,
      confirmation: 'ВОССТАНОВИТЬ',
    })
    let w = await readWorkspace()
    expect(w.obligationEntries).toEqual(original.obligationEntries)
    expect(outlook(w, loan.id).remaining).toBe(750000n)
    expect(w.plans).toEqual(original.plans)

    // A copy made before iteration 5: the current balance, no history and no schedule plan.
    const { openingBalance, startDate: _s, accountId: _a, ...old } = original.obligations[0]!
    const legacy = {
      ...backup,
      exportedAt: '2026-03-15T10:00:00.000Z',
      obligations: [{ ...old, remaining: openingBalance }],
      obligationEntries: undefined,
      transactions: [],
      plans: [],
      planVersions: [],
      planOccurrences: [],
    }
    expect(backupSchema.parse(legacy).obligations[0]).toMatchObject({
      openingBalance: '1000000',
      startDate: '2026-03-15',
      accountId: null,
    })
    await run({
      op: 'workspace.restore',
      backup: legacy,
      expectedRevision: (await readWorkspace()).revision,
      confirmation: 'ВОССТАНОВИТЬ',
    })
    w = await readWorkspace()
    expect(planOf(w, loan.id)).toMatchObject({ startDate: '2026-03-15', amount: '260000' })
    // An entry with a mismatching transaction is rejected.
    const broken = JSON.parse(JSON.stringify(backup))
    broken.obligationEntries[0].principal = '1'
    expect(backupSchema.safeParse(broken).success).toBe(false)
  })

  it('loads demo loans with last month paid', async () => {
    await run({ op: 'workspace.reset', confirmation: 'УДАЛИТЬ' })
    await run({ op: 'demo.load' })
    const w = await readWorkspace()
    expect(w.obligationEntries).toHaveLength(2)
    for (const o of w.obligations) {
      expect(planOf(w, o.id)).toBeTruthy()
      expect(outlook(w, o.id).remaining).toBeLessThan(BigInt(o.openingBalance))
    }
    // The mortgage is no longer duplicated by a separate one-off plan (rule 13).
    expect(w.plans.filter((p) => /ипотек/i.test(p.title))).toHaveLength(1)
  })
})

describe('migration 9', () => {
  it('keeps the balance as the opening balance and creates the schedule plan', async () => {
    const db = new PGlite()
    try {
      await db.exec(migration.replace(obligationMigration, ''))
      await db.exec(`
        INSERT INTO obligations (id,title,kind,remaining,payment,due_day,rate)
          VALUES ('o','Кредит','credit',1000000,260000,1,'12'),
                 ('d','Долг другу','debt',5000,0,10,'0'),
                 ('r','Мне должны','receivable',30000,10000,15,'0');
      `)
      await db.exec(migration)
      await db.exec(migration)
      const rows = (
        await db.query<{ id: string; opening_balance: string; start_date: string }>(
          'SELECT id, opening_balance, start_date FROM obligations ORDER BY id',
        )
      ).rows
      expect(rows.map((r) => [r.id, r.opening_balance])).toEqual([
        ['d', '5000'],
        ['o', '1000000'],
        ['r', '30000'],
      ])
      expect(rows[0]!.start_date).toBe(today)
      const plans = (
        await db.query<{
          source_id: string
          direction: string
          end_date: string
          month_days: number[]
        }>("SELECT * FROM plans WHERE source = 'obligation' ORDER BY source_id")
      ).rows
      expect(plans.map((p) => [p.source_id, p.direction])).toEqual([
        ['o', 'expense'],
        ['r', 'income'],
      ])
      // The same payoff estimate as the application computes.
      const expected = paymentSchedule(1000000n, '12', 260000n, firstDueDate(today, 1), 1)
      expect(plans[0]!.end_date).toBe(monthEnd(expected.rows.at(-1)!.date))
      expect(plans[0]!.month_days).toEqual([1])
      expect((await db.query('SELECT count(*)::int AS n FROM plan_versions')).rows[0]).toEqual({
        n: 2,
      })
    } finally {
      await db.close()
    }
  })
})
