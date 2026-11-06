import { beforeAll, beforeEach, describe, it, expect } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commandSchema, executeCommand, readWorkspace } from '../server/modules/workspace'
import { createBackup, backupSchema } from '../shared/backup'
import { creditState } from '../shared/credit'
import { accountBalance, localDate } from '../shared/money'
import { projectPlans, monthPlan } from '../shared/planning'
import { forecast } from '../shared/forecast'
import { actual365Interest, obligationOutlook } from '../shared/obligations'
import { PGlite } from '@electric-sql/pglite'
import { migration, migrationThrough } from '../server/db/migration'
const run = (c: unknown) => executeCommand(commandSchema.parse(c))
beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), 'lad-credit-'))
  process.env.LAD_DATA_DIR = join(root, 'db')
  process.env.LAD_BACKUP_DIR = join(root, 'backups')
  delete process.env.DATABASE_URL
})
beforeEach(async () => {
  await run({ op: 'workspace.reset', confirmation: 'УДАЛИТЬ' })
  await run({
    op: 'account.create',
    data: { name: 'Собственные деньги', openingBalance: '100000' },
  })
})
async function card() {
  const cash = (await readWorkspace()).accounts[0]!
  await run({
    op: 'account.create',
    data: {
      name: 'Кредитная',
      kind: 'credit',
      openingBalance: '-50000',
      creditSettings: {
        limit: '100000',
        minimumPayment: '5000',
        payerAccountId: cash.id,
        graceUntil: localDate(),
        payFull: true,
      },
    },
  })
  const w = await readWorkspace()
  return { cash, card: w.accounts.find((a) => a.kind === 'credit')!, w }
}
describe('credit accounts and bank schedules', () => {
  it('migrates an existing workspace idempotently without changing money', async () => {
    const db = new PGlite()
    try {
      await db.exec(migrationThrough(11))
      await db.exec(
        "INSERT INTO accounts(id,name,kind,opening_balance,color) VALUES('a','a','card',123,'green')",
      )
      await db.exec(migration)
      await db.exec(migration)
      expect(
        (await db.query('SELECT opening_balance,credit_settings FROM accounts')).rows[0],
      ).toMatchObject({ opening_balance: '123', credit_settings: { limit: '0' } })
    } finally {
      await db.close()
    }
  })
  it('repays by one transfer, conserves total money and is idempotent', async () => {
    const { cash, card: c, w } = await card()
    const p = w.plans.find((p) => p.source === 'credit')!
    const cmd = {
      op: 'occurrence.confirm',
      planId: p.id,
      dueDate: localDate(),
      date: localDate(),
      expectedRevision: w.revision,
      mode: 'create',
      accountId: cash.id,
      amount: '50000',
    }
    await run(cmd)
    await run(cmd)
    const next = await readWorkspace()
    expect(next.transactions).toHaveLength(1)
    expect(next.transactions[0]).toMatchObject({
      kind: 'transfer',
      accountId: cash.id,
      toAccountId: c.id,
    })
    expect(accountBalance(c, next.transactions)).toBe('0')
    expect(monthPlan(next, localDate().slice(0, 7)).spent).toBe('0')
    expect(backupSchema.safeParse(createBackup(next)).success).toBe(true)
  })
  it('rejects overspending atomically including history and rejects archiving debt', async () => {
    const { card: c } = await card()
    const before = await readWorkspace()
    await expect(
      run({
        op: 'transaction.create',
        data: {
          accountId: c.id,
          kind: 'expense',
          amount: '50001',
          category: 'Дом',
          date: localDate(),
        },
      }),
    ).rejects.toThrow('лимит')
    expect((await readWorkspace()).revision).toBe(before.revision)
    expect((await readWorkspace()).transactions).toHaveLength(0)
    await expect(run({ op: 'account.archive', id: c.id, archived: true })).rejects.toThrow('долг')
  })
  it('forecasts the available limit and both sides of repayment without counting a new expense', async () => {
    const { w, card: c } = await card()
    const only = forecast(
      { ...w, accounts: w.accounts.map((a) => ({ ...a, inForecast: a.id === c.id })) },
      localDate(),
      30,
    )
    expect(only.accounts[0]).toMatchObject({
      available: '50000',
      minAvailable: '50000',
      deficitDate: null,
      end: '0',
    })
    const all = forecast(
      { ...w, accounts: w.accounts.map((a) => ({ ...a, inForecast: true })) },
      localDate(),
      30,
    )
    expect(all.total.end).toBe(all.total.start)
    expect(all.total.payments).toBe('0')
    expect(monthPlan(w, localDate().slice(0, 7)).expectedPayments).toBe('0')
  })
  it('reopens debt and its forecast on deleted repayment and restores exactly', async () => {
    const { w, cash, card: c } = await card()
    const p = w.plans.find((p) => p.source === 'credit')!
    await run({
      op: 'occurrence.confirm',
      planId: p.id,
      dueDate: localDate(),
      date: localDate(),
      expectedRevision: w.revision,
      mode: 'create',
      accountId: cash.id,
      amount: '50000',
    })
    const paid = await readWorkspace()
    await run({ op: 'transaction.delete', id: paid.transactions[0]!.id })
    const deleted = await readWorkspace()
    expect(creditState(c, deleted.transactions).debt).toBe(50000n)
    const before = createBackup(deleted)
    expect(backupSchema.safeParse(before).success).toBe(true)
    await run({ op: 'transaction.restore', id: paid.transactions[0]!.id })
    expect(creditState(c, (await readWorkspace()).transactions).debt).toBe(0n)
  })
  it('uses bank dates, variable amounts and interest on confirmation; cancellation restores principal', async () => {
    const cash = (await readWorkspace()).accounts[0]!
    const date = localDate()
    await run({
      op: 'obligation.create',
      data: {
        title: 'Банк',
        kind: 'credit',
        openingBalance: '10000',
        startDate: date,
        payment: '0',
        dueDay: 10,
        rate: '12',
        accountId: cash.id,
        bankSchedule: [
          { date, amount: '5500', interest: '500' },
          { date: '2027-01-15', amount: '5100', interest: '100' },
        ],
      },
    })
    let w = await readWorkspace()
    const p = w.plans.find((p) => p.source === 'obligation')!
    expect(projectPlans(w, date, '2027-01-31').map((r) => r.amount)).toEqual(['5500', '5100'])
    await run({
      op: 'occurrence.confirm',
      planId: p.id,
      dueDate: date,
      date,
      expectedRevision: w.revision,
      mode: 'create',
      accountId: cash.id,
      amount: '5500',
    })
    w = await readWorkspace()
    expect(w.obligationEntries[0]).toMatchObject({ principal: '5000', interest: '500' })
    expect(obligationOutlook(w.obligations[0]!, w).remaining).toBe(5000n)
    await run({
      op: 'obligation.payment.cancel',
      id: w.obligationEntries[0]!.id,
      expectedRevision: w.revision,
    })
    w = await readWorkspace()
    expect(obligationOutlook(w.obligations[0]!, w).remaining).toBe(10000n)
  })
  it('calculates actual/365 using exact kopecks and elapsed days across leap day', () => {
    expect(actual365Interest(100000n, '36.5', '2024-02-28', '2024-03-01')).toBe(200n)
    expect(actual365Interest(100000n, '36.5', '2024-01-01', '2025-01-01')).toBe(36600n)
  })
})
