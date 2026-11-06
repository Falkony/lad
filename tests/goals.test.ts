import { beforeAll, beforeEach, describe, it, expect } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commandSchema, executeCommand, readWorkspace } from '../server/modules/workspace'
import { createBackup, backupSchema } from '../shared/backup'
import { accountBalance, localDate } from '../shared/money'
import { goalAllocations, decisionMoney, fundingOf } from '../shared/goals'
import { budgetRows } from '../shared/planning'
import { PGlite } from '@electric-sql/pglite'
import { migration, migrationThrough } from '../server/db/migration'
const run = (c: unknown) => executeCommand(commandSchema.parse(c))
beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), 'lad-goals-'))
  process.env.LAD_DATA_DIR = join(root, 'db')
  process.env.LAD_BACKUP_DIR = join(root, 'backups')
  delete process.env.DATABASE_URL
})
beforeEach(async () => {
  await run({ op: 'workspace.reset', confirmation: 'УДАЛИТЬ' })
  await run({ op: 'account.create', data: { name: 'Деньги', openingBalance: '100000' } })
})
async function goal(title = 'Цель') {
  await run({ op: 'goal.create', data: { title, target: '60000', saved: '0' } })
  const w = await readWorkspace()
  return w.goals.find((g) => g.title === title)!
}
async function allocate(id: string, amount: string, action = 'reserve') {
  const w = await readWorkspace()
  return run({
    op: 'goal.allocate',
    id,
    amount,
    action,
    accountId: w.accounts[0]!.id,
    date: localDate(),
    expectedRevision: w.revision,
  })
}
describe('needs, allocations and purchases', () => {
  it('preserves legacy saved estimates in migration and old backups without inventing reserves', async () => {
    const db = new PGlite()
    try {
      await db.exec(migrationThrough(12))
      await db.exec(
        "INSERT INTO goals(id,title,target,saved,status,priority) VALUES('g','Цель',1000,500,'saving','normal')",
      )
      await db.exec(migration)
      await db.exec(migration)
      expect((await db.query('SELECT saved,funding FROM goals')).rows[0]).toMatchObject({
        saved: '500',
        funding: { unassigned: '500', entries: [] },
      })
    } finally {
      await db.close()
    }
    const g = await goal()
    const old: any = createBackup(await readWorkspace())
    old.version = 7
    delete old.goals[0].funding
    expect(backupSchema.parse(old).goals[0]!.funding.unassigned).toBe('0')
  })
  it('reserves without moving money and prevents double assignment atomically', async () => {
    const a = await goal('А'),
      b = await goal('Б')
    await allocate(a.id, '60000')
    const before = await readWorkspace()
    await expect(allocate(b.id, '50000')).rejects.toThrow('резерв')
    const w = await readWorkspace()
    expect(w.revision).toBe(before.revision)
    expect(accountBalance(w.accounts[0]!, w.transactions)).toBe('100000')
    expect(w.transactions).toHaveLength(0)
    expect(goalAllocations(w.goals.find((g) => g.id === a.id)!).get(w.accounts[0]!.id)).toBe(60000n)
    expect(decisionMoney(w, localDate()).available).toBe('40000')
  })
  it('records releases and requires freeing reservations before a conflicting spend', async () => {
    const g = await goal()
    await allocate(g.id, '60000')
    let w = await readWorkspace()
    await expect(
      run({
        op: 'transaction.create',
        data: {
          accountId: w.accounts[0]!.id,
          kind: 'expense',
          amount: '50000',
          category: 'Дом',
          date: localDate(),
        },
      }),
    ).rejects.toThrow('резерв')
    await allocate(g.id, '20000', 'release')
    await expect(allocate(g.id, '40001', 'release')).rejects.toThrow('изъять')
    w = await readWorkspace()
    expect(fundingOf(w.goals[0]!).entries).toHaveLength(2)
    expect(w.goals[0]!.saved).toBe('40000')
  })
  it('creates a budget-linked plan and does not subtract its reserve twice in decision money', async () => {
    let g = await goal()
    await allocate(g.id, '60000')
    let w = await readWorkspace()
    const category = w.categories!.find((c) => c.name === 'Покупки')
    await run({ op: 'category.create', name: 'Для цели' })
    w = await readWorkspace()
    const c = w.categories!.find((c) => c.name === 'Для цели')!
    await run({
      op: 'budget.set',
      data: { month: localDate().slice(0, 7), category: c.name, limit: '70000' },
    })
    g = (await readWorkspace()).goals[0]!
    await run({
      op: 'goal.update',
      id: g.id,
      data: { ...g, status: 'planned', categoryId: c.id, purchaseMonth: localDate().slice(0, 7) },
    })
    w = await readWorkspace()
    expect(w.plans.find((p) => p.source === 'goal')).toBeDefined()
    expect(budgetRows(w, localDate().slice(0, 7))[0]!.planned).toBe('60000')
    expect(decisionMoney(w, localDate()).available).toBe('40000')
  })
  it('purchases in one transaction, releases funds, and supports partial/full refunds', async () => {
    const g = await goal()
    await allocate(g.id, '60000')
    let w = await readWorkspace()
    await run({
      op: 'goal.purchase',
      id: g.id,
      expectedRevision: w.revision,
      mode: 'create',
      accountId: w.accounts[0]!.id,
      amount: '60000',
      date: localDate(),
    })
    w = await readWorkspace()
    expect(w.goals[0]!.status).toBe('done')
    expect(w.goals[0]!.saved).toBe('0')
    expect(w.transactions).toHaveLength(1)
    for (const amount of ['20000', '40000']) {
      await run({
        op: 'goal.refund',
        id: g.id,
        expectedRevision: w.revision,
        mode: 'create',
        accountId: w.accounts[0]!.id,
        amount,
        date: localDate(),
      })
      w = await readWorkspace()
    }
    expect(w.goals[0]!.status).toBe('saving')
    expect(accountBalance(w.accounts[0]!, w.transactions)).toBe('100000')
    await expect(
      run({
        op: 'goal.refund',
        id: g.id,
        expectedRevision: w.revision,
        mode: 'create',
        accountId: w.accounts[0]!.id,
        amount: '1',
        date: localDate(),
      }),
    ).rejects.toThrow('превышает')
    expect(backupSchema.safeParse(createBackup(w)).success).toBe(true)
  })
  it('completes a goal by confirming its calendar plan, and preserves purchase history on cancel', async () => {
    let g = await goal()
    await run({ op: 'category.create', name: 'Целевая' })
    let w = await readWorkspace()
    await run({
      op: 'goal.update',
      id: g.id,
      data: {
        ...g,
        status: 'planned',
        categoryId: w.categories!.find((c) => c.name === 'Целевая')!.id,
        purchaseMonth: localDate().slice(0, 7),
        deadline: localDate(),
      },
    })
    await allocate(g.id, '60000')
    w = await readWorkspace()
    const p = w.plans.find((p) => p.source === 'goal')!
    await run({
      op: 'occurrence.confirm',
      planId: p.id,
      dueDate: localDate(),
      date: localDate(),
      mode: 'create',
      accountId: w.accounts[0]!.id,
      amount: '60000',
      expectedRevision: w.revision,
    })
    w = await readWorkspace()
    expect(w.goals[0]!.status).toBe('done')
    expect(fundingOf(w.goals[0]!).purchases[0]!.transactionId).toBe(w.transactions[0]!.id)
    await run({ op: 'goal.cancel', id: g.id, expectedRevision: w.revision })
    w = await readWorkspace()
    expect(w.goals[0]!.status).toBe('cancelled')
    expect(w.transactions).toHaveLength(1)
    await expect(run({ op: 'goal.delete', id: g.id })).rejects.toThrow('историей')
  })
  it('rolls back stale allocations and restores allocation history through backup', async () => {
    const g = await goal()
    const before = await readWorkspace()
    await allocate(g.id, '60000')
    await expect(
      run({
        op: 'goal.allocate',
        id: g.id,
        amount: '100',
        action: 'reserve',
        accountId: before.accounts[0]!.id,
        date: localDate(),
        expectedRevision: before.revision,
      }),
    ).rejects.toThrow('изменились')
    const w = await readWorkspace()
    const backup = backupSchema.parse(createBackup(w))
    await run({
      op: 'workspace.restore',
      backup,
      expectedRevision: w.revision,
      confirmation: 'ВОССТАНОВИТЬ',
    })
    expect((await readWorkspace()).goals).toEqual(w.goals)
  })
})
