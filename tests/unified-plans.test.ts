import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PGlite } from '@electric-sql/pglite'
import { commandSchema, executeCommand, readWorkspace } from '../server/modules/workspace'
import { migration } from '../server/db/migration'
import { unifiedPlanMigration } from '../server/db/unified-plan-migration'
import { payDaysMigration } from '../server/db/pay-days-migration'
import { backupSchema, createBackup } from '../shared/backup'
import { budgetRows, monthPlan, overduePlans, projectPlans } from '../shared/planning'
import * as money from '../shared/money'

const run = async (input: unknown) => executeCommand(commandSchema.parse(input))
const revision = async () => (await readWorkspace()).revision
let accountId: string
const plan = (overrides: Record<string, unknown> = {}) => ({
  title: 'Зарплата',
  category: 'Зарплата',
  amount: '100000',
  accountId,
  frequency: 'monthly',
  interval: 1,
  startDate: '2026-02-05',
  endDate: null,
  note: '',
  ...overrides,
})
const createPlan = async (direction: 'income' | 'expense', overrides = {}) => {
  await run({ op: 'plan.save', direction, data: plan(overrides) })
  return (await readWorkspace()).plans.find((p) => p.title === (plan(overrides).title as string))!
    .id
}
const confirm = async (planId: string, dueDate: string, extra: Record<string, unknown> = {}) =>
  run({
    op: 'occurrence.confirm',
    planId,
    dueDate,
    expectedRevision: await revision(),
    mode: 'create',
    accountId,
    amount: '100000',
    date: '2026-02-06',
    ...extra,
  })
const decide = async (op: string, planId: string, dueDate: string, extra = {}) =>
  run({ op, planId, dueDate, expectedRevision: await revision(), ...extra })

beforeAll(async () => {
  process.env.LAD_DATA_DIR = join(await mkdtemp(join(tmpdir(), 'lad-plans-')), 'db')
  delete process.env.DATABASE_URL
})
beforeEach(async () => {
  vi.spyOn(money, 'localDate').mockReturnValue('2026-02-10')
  await run({ op: 'workspace.reset', confirmation: 'УДАЛИТЬ' })
  await run({ op: 'account.create', data: { name: 'Карта', openingBalance: '0' } })
  accountId = (await readWorkspace()).accounts[0]!.id
})
afterEach(() => vi.restoreAllMocks())

describe('expected incomes', () => {
  it('confirms an income with a new income transaction and counts it once in the month plan', async () => {
    const id = await createPlan('income')
    let state = await readWorkspace()
    expect(monthPlan(state, '2026-02')).toMatchObject({ received: '0', expectedIncome: '100000' })
    await confirm(id, '2026-02-05', { amount: '98000' })
    state = await readWorkspace()
    expect(state.transactions[0]).toMatchObject({ kind: 'income', amount: '98000' })
    expect(monthPlan(state, '2026-02')).toMatchObject({
      received: '98000',
      expectedIncome: '0',
      incomeTotal: '98000',
    })
    expect(projectPlans(state, '2026-03-01', '2026-03-31')[0]).toMatchObject({
      direction: 'income',
      status: 'pending',
    })
  })
  it('links only an income and keeps the linked transaction an income', async () => {
    const id = await createPlan('income')
    for (const kind of ['expense', 'income'])
      await run({
        op: 'transaction.create',
        data: { kind, accountId, amount: '100000', category: 'Зарплата', date: '2026-02-06' },
      })
    const state = await readWorkspace()
    const expense = state.transactions.find((t) => t.kind === 'expense')!
    const income = state.transactions.find((t) => t.kind === 'income')!
    await expect(
      confirm(id, '2026-02-05', { mode: 'link', transactionId: expense.id }),
    ).rejects.toMatchObject({ statusCode: 400 })
    await confirm(id, '2026-02-05', { mode: 'link', transactionId: income.id })
    await expect(
      run({ op: 'transaction.update', id: income.id, data: { ...income, kind: 'expense' } }),
    ).rejects.toMatchObject({ statusCode: 409 })
    expect((await readWorkspace()).transactions).toHaveLength(2)
  })
  it('keeps incomes out of category budgets', async () => {
    await createPlan('income', { category: 'Дом' })
    await run({ op: 'budget.set', data: { month: '2026-02', category: 'Дом', limit: '5000' } })
    expect(budgetRows(await readWorkspace(), '2026-02')[0]).toMatchObject({ planned: '0' })
  })
})

describe('one-off plans', () => {
  it('appears once, is replaced on edit and cannot be paused', async () => {
    const id = await createPlan('expense', { title: 'Ремонт', frequency: 'once' })
    await run({
      op: 'plan.save',
      id,
      direction: 'expense',
      data: plan({ title: 'Ремонт', frequency: 'once', startDate: '2026-03-15', amount: '7000' }),
    })
    const state = await readWorkspace()
    expect(projectPlans(state, '2026-01-01', '2026-12-31').map((p) => [p.date, p.amount])).toEqual([
      ['2026-03-15', '7000'],
    ])
    await expect(run({ op: 'plan.toggle', id, active: false })).rejects.toMatchObject({
      statusCode: 400,
    })
    await expect(
      run({ op: 'plan.save', id, direction: 'expense', data: plan({ title: 'Ремонт' }) }),
    ).rejects.toMatchObject({ statusCode: 400 })
    await expect(
      run({ op: 'plan.save', id, direction: 'income', data: plan({ frequency: 'once' }) }),
    ).rejects.toMatchObject({ statusCode: 400 })
  })
  it('can be deleted until it is confirmed', async () => {
    const draft = await createPlan('expense', { title: 'Черновик', frequency: 'once' })
    await run({ op: 'plan.delete', id: draft })
    const done = await createPlan('expense', { title: 'Оплачено', frequency: 'once' })
    await confirm(done, '2026-02-05')
    await expect(run({ op: 'plan.delete', id: done })).rejects.toMatchObject({ statusCode: 409 })
    await expect(
      run({
        op: 'plan.save',
        id: done,
        direction: 'expense',
        data: plan({ title: 'Оплачено', frequency: 'once', startDate: '2026-04-01' }),
      }),
    ).rejects.toMatchObject({ statusCode: 409 })
    expect((await readWorkspace()).plans.map((p) => p.title)).toEqual(['Оплачено'])
  })
  it('rejects repeat settings on a one-off plan', () => {
    expect(
      commandSchema.safeParse({
        op: 'plan.save',
        data: plan({ frequency: 'once', endDate: '2026-12-31' }),
      }).success,
    ).toBe(false)
  })
})

describe('single dates of a schedule', () => {
  it('moves one date and changes its amount without changing the schedule', async () => {
    const id = await createPlan('expense', { title: 'Аренда', category: 'Дом' })
    await decide('occurrence.adjust', id, '2026-03-05', { date: '2026-04-02', amount: '120000' })
    const state = await readWorkspace()
    expect(projectPlans(state, '2026-03-01', '2026-03-31')).toEqual([])
    expect(
      projectPlans(state, '2026-04-01', '2026-04-30').map((p) => [p.dueDate, p.date, p.amount]),
    ).toEqual([
      ['2026-03-05', '2026-04-02', '120000'],
      ['2026-04-05', '2026-04-05', '100000'],
    ])
    await run({ op: 'budget.set', data: { month: '2026-04', category: 'Дом', limit: '0' } })
    expect(budgetRows(await readWorkspace(), '2026-04')[0]!.planned).toBe('220000')
    await decide('occurrence.adjust', id, '2026-03-05', { date: '2026-03-05', amount: '100000' })
    expect(projectPlans(await readWorkspace(), '2026-03-01', '2026-03-31')[0]).toMatchObject({
      movedTo: null,
      amount: '100000',
    })
  })
  it('keeps a moved date when confirmed and refuses to adjust confirmed or cancelled dates', async () => {
    const id = await createPlan('expense', { title: 'Аренда' })
    await decide('occurrence.adjust', id, '2026-02-05', { date: '2026-02-08', amount: '90000' })
    await confirm(id, '2026-02-05', { amount: '90000' })
    const paid = projectPlans(await readWorkspace(), '2026-02-01', '2026-02-28')[0]!
    expect(paid).toMatchObject({ status: 'paid', date: '2026-02-08', actualAmount: '90000' })
    await expect(
      decide('occurrence.adjust', id, '2026-02-05', { date: '2026-02-09', amount: '1' }),
    ).rejects.toMatchObject({ statusCode: 400 })
    await decide('occurrence.skip', id, '2026-03-05')
    await expect(
      decide('occurrence.adjust', id, '2026-03-05', { date: '2026-03-09', amount: '1' }),
    ).rejects.toMatchObject({ statusCode: 400 })
  })
  it('lists overdue dates until they are confirmed, moved or cancelled', async () => {
    const id = await createPlan('expense', { title: 'Связь', startDate: '2025-12-20' })
    const overdue = async () =>
      overduePlans(await readWorkspace(), '2026-02-10').map((p) => p.dueDate)
    expect(await overdue()).toEqual(['2025-12-20', '2026-01-20'])
    await decide('occurrence.skip', id, '2025-12-20')
    await decide('occurrence.adjust', id, '2026-01-20', { date: '2026-02-15', amount: '100000' })
    expect(await overdue()).toEqual([])
  })
})

describe('migration and backups', () => {
  it('moves calendar payments into one-off plans and keeps recurring history', async () => {
    const db = new PGlite()
    try {
      await db.exec(migration.replace(unifiedPlanMigration, '').replace(payDaysMigration, ''))
      await db.exec(`
        INSERT INTO accounts (id,name,kind,opening_balance,color) VALUES ('a','Счёт','card',0,'green');
        INSERT INTO transactions (id,kind,amount,account_id,category,description,date) VALUES ('t','expense',500,'a','Дом','','2026-01-05');
        INSERT INTO recurring_payments (id,title,category,amount,account_id,frequency,interval,start_date,note) VALUES ('r','Связь','Дом',500,'a','monthly',1,'2026-01-05','');
        INSERT INTO recurring_versions (id,recurring_id,title,category,amount,account_id,frequency,interval,start_date,note,valid_from) VALUES ('v','r','Связь','Дом',500,'a','monthly',1,'2026-01-05','','2026-01-05');
        INSERT INTO payment_occurrences (id,recurring_id,due_date,title,category,amount,account_id,note,status,transaction_id) VALUES ('o','r','2026-01-05','Связь','Дом',500,'a','','paid','t');
        INSERT INTO events (id,title,date,kind,amount,done,note) VALUES
          ('e1','Налог','2026-03-01','payment',900,false,'до 1-го'),
          ('e2','Штраф','2026-01-10','payment',300,true,''),
          ('e3','Без суммы','2026-01-11','payment',NULL,false,''),
          ('e4','Дело','2026-01-12','task',NULL,false,'');
      `)
      await db.exec(migration)
      await db.exec(migration)
      const query = async (sql: string) => (await db.query(sql)).rows
      expect(await query('SELECT id, frequency, direction, amount FROM plans ORDER BY id')).toEqual(
        [
          { id: 'e1', frequency: 'once', direction: 'expense', amount: '900' },
          { id: 'e2', frequency: 'once', direction: 'expense', amount: '300' },
          { id: 'r', frequency: 'monthly', direction: 'expense', amount: '500' },
        ],
      )
      expect(
        await query(
          'SELECT plan_id, status, transaction_id FROM plan_occurrences ORDER BY plan_id',
        ),
      ).toEqual([
        { plan_id: 'e2', status: 'closed', transaction_id: null },
        { plan_id: 'r', status: 'paid', transaction_id: 't' },
      ])
      expect(await query('SELECT id, kind FROM events ORDER BY id')).toEqual([
        { id: 'e3', kind: 'task' },
        { id: 'e4', kind: 'task' },
      ])
      expect(await query('SELECT plan_id, valid_from FROM plan_versions ORDER BY plan_id')).toEqual(
        [
          { plan_id: 'e1', valid_from: '2026-03-01' },
          { plan_id: 'e2', valid_from: '2026-01-10' },
          { plan_id: 'r', valid_from: '2026-01-05' },
        ],
      )
    } finally {
      await db.close()
    }
  })
  it('restores a version 3 copy with recurring payments and calendar payments as plans', async () => {
    const id = await createPlan('expense', { title: 'Связь', category: 'Дом' })
    await confirm(id, '2026-02-05')
    const current = createBackup(await readWorkspace())
    const { plans, planVersions, planOccurrences, ...rest } = JSON.parse(JSON.stringify(current))
    const event = (title: string, done: boolean) => ({
      id: crypto.randomUUID(),
      title,
      date: '2026-02-20',
      kind: 'payment',
      amount: '700',
      done,
      note: '',
    })
    const legacy = {
      ...rest,
      version: 3,
      events: [event('Налог', false), event('Штраф', true)],
      recurringPayments: plans.map(({ direction, source, sourceId, ...p }: any) => p),
      recurringVersions: planVersions.map(({ planId, ...v }: any) => ({
        ...v,
        recurringId: planId,
      })),
      paymentOccurrences: planOccurrences.map(({ planId, movedTo, ...o }: any) => ({
        ...o,
        recurringId: planId,
      })),
    }
    await run({
      op: 'workspace.restore',
      backup: legacy,
      expectedRevision: await revision(),
      confirmation: 'ВОССТАНОВИТЬ',
    })
    const state = await readWorkspace()
    expect(state.events).toEqual([])
    expect(projectPlans(state, '2026-02-01', '2026-02-28').map((p) => [p.title, p.status])).toEqual(
      [
        ['Связь', 'paid'],
        ['Налог', 'pending'],
        ['Штраф', 'closed'],
      ],
    )
  })
  it('round-trips incomes, one-off plans and moved dates in version 4', async () => {
    await createPlan('income')
    const rent = await createPlan('expense', { title: 'Аренда' })
    await createPlan('expense', { title: 'Ремонт', frequency: 'once', startDate: '2026-05-01' })
    await decide('occurrence.adjust', rent, '2026-03-05', { date: '2026-03-07', amount: '1' })
    const before = await readWorkspace()
    const backup = createBackup(before)
    expect(backupSchema.safeParse(backup).success).toBe(true)
    await run({ op: 'workspace.reset', confirmation: 'УДАЛИТЬ' })
    await run({
      op: 'workspace.restore',
      backup: JSON.parse(JSON.stringify(backup)),
      expectedRevision: await revision(),
      confirmation: 'ВОССТАНОВИТЬ',
    })
    const after = await readWorkspace()
    for (const key of ['plans', 'planVersions', 'planOccurrences'] as const)
      expect(after[key]).toEqual(before[key])
  })
})
