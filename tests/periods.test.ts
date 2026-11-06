import { beforeAll, beforeEach, describe, it, expect } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commandSchema, executeCommand, readWorkspace } from '../server/modules/workspace'
import { readPeriodAnalysis, exportPeriod } from '../server/modules/periods'
import { backupSchema, createBackup } from '../shared/backup'
import { localDate, accountBalance } from '../shared/money'
import { monthRange, shiftMonth } from '../shared/planning'
import { stableJSON } from '../shared/periods'
import { PGlite } from '@electric-sql/pglite'
import { migration, migrationThrough } from '../server/db/migration'
const run = (c: unknown) => executeCommand(commandSchema.parse(c)),
  month = shiftMonth(localDate().slice(0, 7), -1),
  previous = shiftMonth(month, -1),
  date = month + '-10'
describe('historical planning and debt analysis', () => {
  it('migrates prior budget limits and zero-delta reconciliation evidence without changing money', async () => {
    const db = new PGlite()
    try {
      await db.exec(migrationThrough(14))
      await db.exec(
        `INSERT INTO accounts(id,name,kind,opening_balance,color) VALUES('a','a','card',123,'green');INSERT INTO budgets(id,month,category,"limit") VALUES('b','${month}','Дом',1000);INSERT INTO command_history(id,revision,operation,payload,result) VALUES('c',1,'account.reconcile','{"id":"a","data":{"date":"${monthRange(month).to}","targetBalance":"123"}}','{}');`,
      )
      await db.exec(migration)
      await db.exec(migration)
      expect((await db.query('SELECT balance FROM reconciliations')).rows).toEqual([
        { balance: '123' },
      ])
      expect((await db.query('SELECT new_limit FROM budget_history')).rows).toEqual([
        { new_limit: '1000' },
      ])
      expect(
        (await db.query('SELECT opening_balance FROM accounts')).rows[0]!.opening_balance,
      ).toBe('123')
    } finally {
      await db.close()
    }
  })
  it('permits a duplicate-only import after month close without rewriting the snapshot', async () => {
    const w = await readWorkspace(),
      data = {
        transactions: [
          {
            kind: 'expense',
            accountId: w.accounts[0]!.id,
            amount: '1000',
            date,
            category: 'Дом',
            importKey: 'closed-bank-key',
          },
        ],
      }
    await run({ op: 'import', data })
    await reconcile()
    const first = await close()
    const next = await readWorkspace()
    expect(await run({ op: 'import', data, expectedRevision: next.revision })).toMatchObject({
      imported: 0,
      skipped: 1,
    })
    expect((await exportPeriod(first.id)).closure.sha256).toBe(first.sha256)
  })
  it('shows principal, interest and regular payments once in the recorded month', async () => {
    const w = await readWorkspace(),
      accountId = w.accounts[0]!.id
    await run({
      op: 'obligation.create',
      data: {
        title: 'Рассрочка',
        kind: 'credit',
        openingBalance: '300',
        startDate: month + '-01',
        payment: '110',
        dueDay: 10,
        rate: '0',
        accountId,
        bankSchedule: [
          { date, amount: '110', interest: '10' },
          { date: shiftMonth(month, 1) + '-10', amount: '200', interest: '0' },
        ],
      },
    })
    let next = await readWorkspace()
    await run({
      op: 'obligation.pay',
      obligationId: next.obligations[0]!.id,
      expectedRevision: next.revision,
      date,
      dueDate: date,
      mode: 'create',
      accountId,
      principal: '100',
      interest: '10',
      fees: '0',
    })
    const report = (await readPeriodAnalysis(month)).report
    expect(report.expenses).toBe('110')
    expect(report.obligations[0]).toMatchObject({
      opening: '0',
      closing: '200',
      principal: '100',
      interest: '10',
    })
    expect(report.recurring[0]).toMatchObject({ planned: '110', actual: '110' })
  })
  it('keeps a payment booked next month open in the earlier month, with no earlier expense', async () => {
    const w = await readWorkspace(),
      accountId = w.accounts[0]!.id
    await run({
      op: 'obligation.create',
      data: {
        title: 'Поздний платёж',
        kind: 'debt',
        openingBalance: '100',
        startDate: month + '-01',
        payment: '100',
        dueDay: 10,
        rate: '0',
        accountId,
      },
    })
    let next = await readWorkspace()
    const p = next.plans.find((p) => p.source === 'obligation')!
    await run({
      op: 'occurrence.confirm',
      planId: p.id,
      dueDate: date,
      date: localDate(),
      mode: 'create',
      accountId,
      amount: '100',
      expectedRevision: next.revision,
    })
    const report = (await readPeriodAnalysis(month)).report
    expect(report).toMatchObject({ expenses: '0', expectedPayments: '100' })
    expect(report.obligations[0]!.closing).toBe('100')
  })
  it('reduces expenses in the refund month and keeps its receipt out of income', async () => {
    const original = await transaction('1000', previous + '-10')
    const w = await readWorkspace()
    await run({
      op: 'transaction.create',
      data: {
        kind: 'income',
        accountId: w.accounts[0]!.id,
        amount: '200',
        date,
        category: 'Дом',
        refundOf: original.id,
      },
    })
    const report = (await readPeriodAnalysis(month)).report
    expect(report).toMatchObject({ income: '0', expenses: '-200', net: '200' })
    expect(report.categories.find((c) => c.category === 'Дом')!.spent).toBe('-200')
  })
})
beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), 'lad-periods-'))
  process.env.LAD_DATA_DIR = join(root, 'db')
  process.env.LAD_BACKUP_DIR = join(root, 'backups')
  delete process.env.DATABASE_URL
})
beforeEach(async () => {
  await run({ op: 'workspace.reset', confirmation: 'УДАЛИТЬ' })
  await run({ op: 'account.create', data: { name: 'Мой счёт', openingBalance: '100000' } })
})
async function transaction(amount = '1000', when = date, kind = 'expense', category = 'Дом') {
  const w = await readWorkspace()
  await run({
    op: 'transaction.create',
    data: {
      accountId: w.accounts[0]!.id,
      amount,
      date: when,
      kind,
      category,
      description: 'Операция',
    },
  })
  return (await readWorkspace()).transactions.find((t) => t.amount === amount && t.date === when)!
}
async function reconcile() {
  const w = await readWorkspace()
  const to = monthRange(month).to,
    expected = accountBalance(
      w.accounts[0]!,
      w.transactions.filter((t) => t.date <= to),
    )
  await run({
    op: 'account.reconcile',
    id: w.accounts[0]!.id,
    data: { date: to, targetBalance: expected, expectedBalance: expected },
  })
}
async function close() {
  const w = await readWorkspace()
  await run({ op: 'period.close', month, expectedRevision: w.revision })
  return (await readPeriodAnalysis(month)).closures[0]!
}
describe('period analysis and immutable month close', () => {
  it('compares net expenses and income by period, with category causes and transaction links', async () => {
    await transaction('500', previous + '-05')
    const t = await transaction('1000')
    await transaction('3000', date, 'income', 'Зарплата')
    await run({ op: 'budget.set', data: { month, category: 'Дом', limit: '800' } })
    const a = await readPeriodAnalysis(month)
    expect(a.report).toMatchObject({ income: '3000', expenses: '1000', net: '2000' })
    expect(a.delta).toMatchObject({ expenses: '500', income: '3000', net: '2500' })
    expect(a.report.categories.find((c) => c.category === 'Дом')).toMatchObject({
      over: '200',
      transactionIds: [t.id],
    })
  })
  it('preserves exact before/after budget limits with revisions and prepares only missing next-month limits', async () => {
    await run({ op: 'budget.set', data: { month, category: 'Дом', limit: '1000' } })
    await run({ op: 'budget.set', data: { month, category: 'Дом', limit: '1200' } })
    await run({
      op: 'budget.set',
      data: { month: shiftMonth(month, 1), category: 'Дом', limit: '2000' },
    })
    await run({ op: 'budget.set', data: { month, category: 'Кафе', limit: '500' } })
    let w = await readWorkspace()
    const history = (await readPeriodAnalysis(month)).history.filter((h) => h.category === 'Дом')
    expect(history.map((h) => [h.oldLimit, h.newLimit])).toEqual([
      ['1000', '1200'],
      [null, '1000'],
    ])
    expect(await run({ op: 'period.prepare', month, expectedRevision: w.revision })).toMatchObject({
      copied: 1,
    })
    w = await readWorkspace()
    expect(
      w.budgets.find((b) => b.month === shiftMonth(month, 1) && b.category === 'Дом')!.limit,
    ).toBe('2000')
  })
  it('checks unclassified operations, balances and open plans, requiring an explicit reason for warnings', async () => {
    await transaction('1000', date, 'expense', 'Другое')
    await run({
      op: 'plan.save',
      direction: 'expense',
      data: {
        title: 'Не подтверждён',
        category: 'Дом',
        amount: '100',
        frequency: 'once',
        startDate: date,
      },
    })
    let a = await readPeriodAnalysis(month)
    expect(a.report.issues.map((i) => i.code)).toEqual(
      expect.arrayContaining(['unreconciled', 'uncategorized', 'open-plan']),
    )
    await expect(run({ op: 'period.close', month, expectedRevision: a.revision })).rejects.toThrow(
      'вопросы',
    )
    await expect(
      run({ op: 'period.close', month, expectedRevision: a.revision, allowWarnings: true }),
    ).rejects.toThrow('вопросы')
    await run({
      op: 'period.close',
      month,
      expectedRevision: a.revision,
      allowWarnings: true,
      note: 'Выписка ожидается, вопросы сохранены',
    })
    expect((await readPeriodAnalysis(month)).closures[0]!.snapshot.issues.length).toBe(3)
  })
  it('records a zero-delta reconciliation and closes without a money adjustment', async () => {
    await transaction()
    await reconcile()
    let w = await readWorkspace()
    expect(w.reconciliations).toHaveLength(1)
    expect(w.transactions).toHaveLength(1)
    expect((await readPeriodAnalysis(month)).report.accounts[0]!.reconciled).toBe(true)
    const closure = await close()
    expect(closure.sourceRevision).toBe(w.revision)
    expect(closure.snapshot.expenses).toBe('1000')
    expect(closure.sha256).toMatch(/^[a-f0-9]{64}$/)
  })
  it('protects closed facts, budgets and starting balances while allowing new-period operations', async () => {
    const t = await transaction()
    await reconcile()
    await close()
    await expect(run({ op: 'transaction.delete', id: t.id })).rejects.toThrow('откройте')
    await expect(
      run({ op: 'budget.set', data: { month, category: 'Дом', limit: '1000' } }),
    ).rejects.toThrow('откройте')
    const w = await readWorkspace()
    await expect(
      run({
        op: 'account.update',
        id: w.accounts[0]!.id,
        data: { ...w.accounts[0]!, openingBalance: '1' },
      }),
    ).rejects.toThrow('откройте')
    await transaction('200', localDate())
    expect((await readPeriodAnalysis(month)).report.expenses).toBe('1000')
  })
  it('reopens and recloses as a new generation, preserving the first snapshot and export', async () => {
    const t = await transaction()
    await reconcile()
    const first = await close()
    let w = await readWorkspace()
    await run({
      op: 'period.reopen',
      id: first.id,
      expectedRevision: w.revision,
      note: 'Исправляю сумму по выписке',
    })
    await run({ op: 'transaction.update', id: t.id, data: { ...t, amount: '2000' } })
    await reconcile()
    const second = await close()
    expect(second.generation).toBe(2)
    expect(second.snapshot.expenses).toBe('2000')
    const exported = await exportPeriod(first.id)
    expect(exported.closure.snapshot.expenses).toBe('1000')
    expect(exported.closure.sha256).toBe(first.sha256)
    expect(exported.closure.status).toBe('reopened')
  })
  it('rejects stale closes and closing an unfinished month', async () => {
    let w = await readWorkspace()
    await transaction()
    await expect(run({ op: 'period.close', month, expectedRevision: w.revision })).rejects.toThrow(
      'изменились',
    )
    w = await readWorkspace()
    await expect(
      run({
        op: 'period.close',
        month: localDate().slice(0, 7),
        expectedRevision: w.revision,
        allowWarnings: true,
        note: 'Рано',
      }),
    ).rejects.toThrow('завершившийся')
  })
  it('preserves closures and their checksum on restore, rejecting a tampered snapshot atomically', async () => {
    await transaction()
    await reconcile()
    const c = await close()
    let w = await readWorkspace()
    const backup = backupSchema.parse(createBackup(w))
    await run({
      op: 'workspace.restore',
      backup,
      expectedRevision: w.revision,
      confirmation: 'ВОССТАНОВИТЬ',
    })
    w = await readWorkspace()
    expect((await exportPeriod(c.id)).closure.sha256).toBe(c.sha256)
    const bad = structuredClone(backup)
    bad.periodClosures[0]!.snapshot.accounts[0]!.name = 'Подмена'
    const before = w.revision
    await expect(
      run({
        op: 'workspace.restore',
        backup: bad,
        expectedRevision: before,
        confirmation: 'ВОССТАНОВИТЬ',
      }),
    ).rejects.toThrow('Контрольная сумма')
    expect((await readWorkspace()).revision).toBe(before)
  })
  it('requires opening later closed periods when earlier money facts change', async () => {
    const t = await transaction('100', previous + '-05')
    await reconcile()
    await close()
    await expect(
      run({ op: 'transaction.update', id: t.id, data: { ...t, amount: '200' } }),
    ).rejects.toThrow(month)
  })
  it('uses a canonical checksum representation independent of JSON property order', () => {
    expect(stableJSON({ b: 1, a: { z: 2, x: 3 } })).toBe(stableJSON({ a: { x: 3, z: 2 }, b: 1 }))
  })
})
