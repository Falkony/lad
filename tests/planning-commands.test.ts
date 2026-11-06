import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { commandSchema, executeCommand, readWorkspace } from '../server/modules/workspace'
import { backupSchema, createBackup } from '../shared/backup'
import { budgetRows, projectPlans } from '../shared/planning'
import * as money from '../shared/money'
import type { PlanFields } from '../shared/planning-types'

const run = async (input: unknown) => executeCommand(commandSchema.parse(input))
let accountId: string
const fields = (): PlanFields => ({
  title: 'Интернет',
  amount: '10000',
  category: 'Дом',
  accountId,
  frequency: 'monthly',
  interval: 1,
  startDate: '2026-01-31',
  endDate: null,
  note: 'Тариф',
})
const createRule = async () => {
  await run({ op: 'plan.save', data: fields() })
  return (await readWorkspace()).plans[0]!.id
}
const pay = async (planId: string, dueDate = '2026-02-28', extra: Record<string, unknown> = {}) =>
  run({
    op: 'occurrence.confirm',
    planId,
    dueDate,
    expectedRevision: (await readWorkspace()).revision,
    mode: 'create',
    accountId,
    amount: '11000',
    date: '2026-02-10',
    ...extra,
  })
const mark = async (op: string, planId: string, dueDate: string) =>
  run({ op, planId, dueDate, expectedRevision: (await readWorkspace()).revision })
beforeAll(async () => {
  process.env.LAD_DATA_DIR = join(await mkdtemp(join(tmpdir(), 'lad-planning-')), 'db')
  delete process.env.DATABASE_URL
})
beforeEach(async () => {
  vi.spyOn(money, 'localDate').mockReturnValue('2026-02-10')
  await run({ op: 'workspace.reset', confirmation: 'УДАЛИТЬ' })
  await run({ op: 'account.create', data: { name: 'Карта', openingBalance: '100000' } })
  accountId = (await readWorkspace()).accounts[0]!.id
})
afterEach(() => vi.restoreAllMocks())
describe('budgets and versioned recurring plans', () => {
  it('upserts limits and copies only missing categories without changing actual money', async () => {
    for (const [month, category, limit] of [
      ['2026-01', 'Дом', '50000'],
      ['2026-01', 'Кафе', '10000'],
      ['2026-02', 'Дом', '0'],
    ])
      await run({ op: 'budget.set', data: { month, category, limit } })
    expect(await run({ op: 'budget.copy', from: '2026-01', to: '2026-02' })).toEqual({
      copied: 1,
      skipped: 1,
    })
    await run({ op: 'budget.set', data: { month: '2026-02', category: 'Кафе', limit: '15000' } })
    const state = await readWorkspace()
    expect(
      state.budgets
        .filter((b) => b.month === '2026-02')
        .map((b) => [b.category, b.limit])
        .sort(),
    ).toEqual([
      ['Дом', '0'],
      ['Кафе', '15000'],
    ])
    expect(state.transactions).toEqual([])
    await run({ op: 'budget.delete', id: state.budgets[0]!.id })
    expect((await readWorkspace()).budgets).toHaveLength(3)
  })
  it('projects dates without recording expenses or materializing records on reads', async () => {
    await createRule()
    const before = await readWorkspace()
    expect(projectPlans(before, '2026-01-01', '2026-04-30').map((p) => p.dueDate)).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
    ])
    expect(await readWorkspace()).toEqual(before)
    expect(before.transactions).toEqual([])
    expect(before.planOccurrences).toEqual([])
  })
  it('preserves past settings and excludes the paused gap after resuming', async () => {
    const id = await createRule()
    await run({
      op: 'plan.save',
      id,
      data: { ...fields(), title: 'Новый тариф', amount: '20000' },
    })
    let state = await readWorkspace()
    expect(projectPlans(state, '2026-01-01', '2026-02-28').map((p) => [p.title, p.amount])).toEqual(
      [
        ['Интернет', '10000'],
        ['Новый тариф', '20000'],
      ],
    )
    vi.mocked(money.localDate).mockReturnValue('2026-02-15')
    await run({ op: 'plan.toggle', id, active: false })
    vi.mocked(money.localDate).mockReturnValue('2026-04-01')
    await run({ op: 'plan.toggle', id, active: true })
    state = await readWorkspace()
    expect(projectPlans(state, '2026-01-01', '2026-05-31').map((p) => p.dueDate)).toEqual([
      '2026-01-31',
      '2026-04-30',
      '2026-05-31',
    ])
    expect(backupSchema.safeParse(createBackup(state)).success).toBe(true)
  })
  it('keeps paid and skipped snapshots through edits but removes future pending exceptions on pause', async () => {
    const id = await createRule()
    await pay(id)
    await mark('occurrence.skip', id, '2026-03-31')
    await mark('occurrence.skip', id, '2026-04-30')
    await mark('occurrence.unskip', id, '2026-04-30')
    await run({ op: 'plan.save', id, data: { ...fields(), amount: '20000' } })
    await run({ op: 'plan.toggle', id, active: false })
    const state = await readWorkspace()
    expect(
      projectPlans(state, '2026-02-01', '2026-05-31').map((p) => [p.dueDate, p.status, p.amount]),
    ).toEqual([
      ['2026-02-28', 'paid', '10000'],
      ['2026-03-31', 'skipped', '10000'],
    ])
    expect(state.planOccurrences).toHaveLength(2)
    expect(createBackup(state).version).toBe(5)
  })
  it('retains account references even for paused schedules', async () => {
    await run({ op: 'account.create', data: { name: 'Пустой', openingBalance: '0' } })
    const id = (await readWorkspace()).accounts.find((a) => a.name === 'Пустой')!.id
    await run({ op: 'plan.save', data: { ...fields(), accountId: id } })
    const rule = (await readWorkspace()).plans[0]!
    await run({ op: 'plan.toggle', id: rule.id, active: false })
    await expect(run({ op: 'account.delete', id })).rejects.toThrow()
    await run({ op: 'account.archive', id, archived: true })
    expect((await readWorkspace()).accounts.find((a) => a.id === id)!.archived).toBe(true)
  })
})
describe('confirming actual payments', () => {
  it('makes repeated confirmation idempotent and uses the actual amount in budgets', async () => {
    const id = await createRule(),
      revision = (await readWorkspace()).revision
    const result = await pay(id, '2026-02-28', { expectedRevision: revision })
    expect(await pay(id, '2026-02-28', { expectedRevision: revision })).toMatchObject({
      alreadyPaid: true,
      transactionId: result.transactionId,
    })
    await run({ op: 'budget.set', data: { month: '2026-02', category: 'Дом', limit: '20000' } })
    const state = await readWorkspace()
    expect(state.transactions).toHaveLength(1)
    expect(budgetRows(state, '2026-02')[0]).toMatchObject({
      spent: '11000',
      planned: '0',
      remaining: '9000',
    })
  })
  it('links an existing expense once and follows its edits, deletion and restoration', async () => {
    const id = await createRule()
    await run({
      op: 'transaction.create',
      data: {
        kind: 'expense',
        accountId,
        amount: '9000',
        category: 'Дом',
        description: 'Банк',
        date: '2026-02-09',
      },
    })
    const transaction = (await readWorkspace()).transactions[0]!
    await pay(id, '2026-02-28', { mode: 'link', transactionId: transaction.id })
    await expect(
      pay(id, '2026-03-31', { mode: 'link', transactionId: transaction.id }),
    ).rejects.toThrow()
    expect((await readWorkspace()).transactions).toHaveLength(1)
    await expect(
      run({
        op: 'transaction.update',
        id: transaction.id,
        data: { ...transaction, kind: 'income' },
      }),
    ).rejects.toThrow()
    await run({
      op: 'transaction.update',
      id: transaction.id,
      data: { ...transaction, amount: '9500' },
    })
    expect(projectPlans(await readWorkspace(), '2026-02-28', '2026-02-28')[0]!.actualAmount).toBe(
      '9500',
    )
    await run({ op: 'transaction.delete', id: transaction.id })
    expect(projectPlans(await readWorkspace(), '2026-02-28', '2026-02-28')[0]!.status).toBe(
      'deleted',
    )
    await expect(pay(id)).rejects.toThrow()
    await run({ op: 'transaction.restore', id: transaction.id })
    expect(projectPlans(await readWorkspace(), '2026-02-28', '2026-02-28')[0]!.status).toBe('paid')
  })
  it('skips only one date, restores it and rejects stale payment dialogs', async () => {
    const id = await createRule()
    await mark('occurrence.skip', id, '2026-02-28')
    expect(
      projectPlans(await readWorkspace(), '2026-02-01', '2026-03-31').map((p) => p.status),
    ).toEqual(['skipped', 'pending'])
    await mark('occurrence.unskip', id, '2026-02-28')
    const oldRevision = (await readWorkspace()).revision
    await run({ op: 'shopping.create', data: { title: 'Хлеб' } })
    await expect(pay(id, '2026-02-28', { expectedRevision: oldRevision })).rejects.toThrow()
    expect((await readWorkspace()).transactions).toEqual([])
    await pay(id)
    await expect(mark('occurrence.skip', id, '2026-02-28')).rejects.toThrow()
  })
})
describe('planning backup compatibility', () => {
  it('round-trips plans, version history, budgets and deleted linked expenses', async () => {
    const id = await createRule()
    await run({ op: 'budget.set', data: { month: '2026-02', category: 'Дом', limit: '25000' } })
    const paid = await pay(id)
    await mark('occurrence.skip', id, '2026-03-31')
    await run({ op: 'plan.save', id, data: { ...fields(), amount: '12000' } })
    await run({ op: 'transaction.delete', id: paid.transactionId })
    const before = await readWorkspace(),
      backup = createBackup(before)
    await run({ op: 'workspace.reset', confirmation: 'УДАЛИТЬ' })
    await run({
      op: 'workspace.restore',
      backup,
      expectedRevision: (await readWorkspace()).revision,
      confirmation: 'ВОССТАНОВИТЬ',
    })
    const after = await readWorkspace()
    for (const key of [
      'budgets',
      'plans',
      'planVersions',
      'planOccurrences',
      'deletedTransactions',
    ] as const)
      expect(after[key]).toEqual(before[key])
    expect(projectPlans(after, '2026-02-28', '2026-02-28')[0]!.status).toBe('deleted')
  })
  it('defaults legacy planning sections to empty and rejects broken plan graphs', async () => {
    const id = await createRule()
    await pay(id)
    const backup = createBackup(await readWorkspace())
    for (const version of [1, 2]) {
      const old: Record<string, unknown> = { ...backup, version }
      for (const key of ['budgets', 'plans', 'planVersions', 'planOccurrences']) delete old[key]
      expect(backupSchema.parse(old).plans).toEqual([])
    }
    expect(backupSchema.safeParse({ ...backup, plans: [] }).success).toBe(false)
    expect(
      backupSchema.safeParse({
        ...backup,
        planVersions: [
          ...backup.planVersions,
          { ...backup.planVersions[0], id: crypto.randomUUID() },
        ],
      }).success,
    ).toBe(false)
    expect(
      backupSchema.safeParse({
        ...backup,
        planOccurrences: [
          ...backup.planOccurrences,
          { ...backup.planOccurrences[0], id: crypto.randomUUID(), dueDate: '2026-03-31' },
        ],
      }).success,
    ).toBe(false)
    expect(backupSchema.safeParse({ ...backup, transactions: [] }).success).toBe(false)
  })
})
