import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { sql } from 'drizzle-orm'
import { commandSchema, executeCommand, readWorkspace } from '../server/modules/workspace'
import { getDb } from '../server/db'
import { backupSchema, createBackup } from '../shared/backup'
import { accountBalance, localDate, sumAmounts } from '../shared/money'

const run = async (input: unknown) => executeCommand(commandSchema.parse(input))
let a: string, b: string
const expense = (accountId: string, amount = '10000', date = localDate()) => ({
  kind: 'expense',
  amount,
  accountId,
  category: 'Дом',
  description: 'Проверка',
  date,
})
beforeAll(async () => {
  process.env.LAD_DATA_DIR = join(await mkdtemp(join(tmpdir(), 'lad-v2-')), 'db')
  delete process.env.DATABASE_URL
})
beforeEach(async () => {
  await run({ op: 'workspace.reset', confirmation: 'УДАЛИТЬ' })
  await run({
    op: 'account.create',
    data: {
      name: 'Основной',
      openingBalance: '100000',
      bankName: 'Банк',
      last4: '1234',
      color: 'blue',
    },
  })
  await run({ op: 'account.create', data: { name: 'Второй', openingBalance: '0' } })
  const state = await readWorkspace()
  a = state.accounts.find((account) => account.name === 'Основной')!.id
  b = state.accounts.find((account) => account.name === 'Второй')!.id
})
describe('account lifecycle and ledger editing', () => {
  it('persists bank details and archives accounts without losing history or money', async () => {
    await run({ op: 'transaction.create', data: expense(a) })
    await run({ op: 'account.archive', id: a, archived: true })
    let state = await readWorkspace()
    expect(state.accounts.find((account) => account.id === a)).toMatchObject({
      bankName: 'Банк',
      last4: '1234',
      color: 'blue',
      archived: true,
    })
    expect(
      accountBalance(
        state.accounts.find((account) => account.id === a)!,
        state.transactions,
      ),
    ).toBe('90000')
    await expect(run({ op: 'transaction.create', data: expense(a) })).rejects.toThrow()
    const old = state.transactions[0]!
    await run({ op: 'transaction.update', id: old.id, data: { ...old, amount: '15000' } })
    await run({ op: 'account.archive', id: a, archived: false })
    state = await readWorkspace()
    expect(state.accounts.find((account) => account.id === a)!.archived).toBe(false)
    expect(
      accountBalance(
        state.accounts.find((account) => account.id === a)!,
        state.transactions,
      ),
    ).toBe('85000')
  })
  it('allows deletion only for a zero-balance account without any history', async () => {
    await expect(run({ op: 'account.delete', id: a })).rejects.toThrow()
    await run({ op: 'account.delete', id: b })
    expect((await readWorkspace()).accounts).toHaveLength(1)
    await run({ op: 'transaction.create', data: expense(a) })
    const state = await readWorkspace()
    await run({ op: 'transaction.delete', id: state.transactions[0]!.id })
    await expect(run({ op: 'account.delete', id: a })).rejects.toThrow()
    expect((await readWorkspace()).deletedTransactions).toHaveLength(1)
  })
  it('recalculates every affected account when editing a transfer', async () => {
    await run({ op: 'account.create', data: { name: 'Третий', openingBalance: '50000' } })
    const c = (await readWorkspace()).accounts.find((account) => account.name === 'Третий')!.id
    await run({
      op: 'transaction.create',
      data: { ...expense(a, '25000'), kind: 'transfer', toAccountId: b },
    })
    const old = (await readWorkspace()).transactions[0]!
    await run({
      op: 'transaction.update',
      id: old.id,
      data: { ...old, accountId: c, amount: '10000' },
    })
    const state = await readWorkspace()
    expect(
      [a, b, c].map((id) =>
        accountBalance(
          state.accounts.find((account) => account.id === id)!,
          state.transactions,
        ),
      ),
    ).toEqual(['100000', '10000', '40000'])
    expect(
      sumAmounts(
        [a, b, c].map((id) =>
          accountBalance(
            state.accounts.find((account) => account.id === id)!,
            state.transactions,
          ),
        ),
      ),
    ).toBe('150000')
    await expect(
      run({ op: 'transaction.update', id: old.id, data: { ...old, toAccountId: a } }),
    ).rejects.toThrow()
  })
  it('keeps deleted operations recoverable and out of the balance', async () => {
    await run({ op: 'transaction.create', data: expense(a) })
    const id = (await readWorkspace()).transactions[0]!.id
    await run({ op: 'transaction.delete', id })
    let state = await readWorkspace()
    expect(state.transactions).toHaveLength(0)
    expect(
      accountBalance(
        state.accounts.find((account) => account.id === a)!,
        state.deletedTransactions,
      ),
    ).toBe('100000')
    await run({ op: 'transaction.restore', id })
    state = await readWorkspace()
    expect(state.deletedTransactions).toHaveLength(0)
    expect(
      accountBalance(
        state.accounts.find((account) => account.id === a)!,
        state.transactions,
      ),
    ).toBe('90000')
  })
  it('preserves import idempotency after moving and deleting an imported operation', async () => {
    const row = { ...expense(a), importKey: 'bank-unique-id' }
    await run({ op: 'import', data: { transactions: [row] } })
    const old = (await readWorkspace()).transactions[0]!
    await run({ op: 'transaction.update', id: old.id, data: { ...old, accountId: b } })
    await run({ op: 'transaction.delete', id: old.id })
    expect(await run({ op: 'import', data: { transactions: [row] } })).toEqual({
      imported: 0,
      skipped: 1,
    })
    expect((await readWorkspace()).deletedTransactions[0]!.importAccountId).toBe(a)
    const backup = createBackup(await readWorkspace())
    await run({ op: 'workspace.reset', confirmation: 'УДАЛИТЬ' })
    await run({
      op: 'workspace.restore',
      backup,
      expectedRevision: (await readWorkspace()).revision,
      confirmation: 'ВОССТАНОВИТЬ',
    })
    expect(await run({ op: 'import', data: { transactions: [row] } })).toEqual({
      imported: 0,
      skipped: 1,
    })
  })
  it('applies category changes atomically to valid selections', async () => {
    await run({ op: 'transaction.create', data: expense(a) })
    const old = (await readWorkspace()).transactions[0]!
    await run({ op: 'transactions.categorize', ids: [old.id], category: 'Продукты' })
    await expect(
      run({ op: 'transactions.categorize', ids: [old.id, crypto.randomUUID()], category: 'Кафе' }),
    ).rejects.toThrow()
    expect((await readWorkspace()).transactions[0]!.category).toBe('Продукты')
  })
  it('rejects checkout and bank imports to archived accounts', async () => {
    await run({ op: 'account.archive', id: a, archived: true })
    await run({ op: 'shopping.create', data: { title: 'Молоко', checked: true } })
    await expect(
      run({ op: 'shopping.checkout', data: { accountId: a, amount: '100', date: localDate() } }),
    ).rejects.toThrow()
    await expect(
      run({ op: 'import', data: { transactions: [{ ...expense(a), importKey: 'no' }] } }),
    ).rejects.toThrow()
    expect((await readWorkspace()).shopping).toHaveLength(1)
  })
})
describe('dated reconciliation', () => {
  it('writes a signed correction on the selected date without changing the opening balance or expenses', async () => {
    await run({ op: 'transaction.create', data: expense(a, '10000', '2026-01-01') })
    await run({ op: 'transaction.create', data: expense(a, '5000') })
    await run({
      op: 'account.reconcile',
      id: a,
      data: { date: '2026-01-01', expectedBalance: '90000', targetBalance: '85000' },
    })
    const state = await readWorkspace(),
      correction = state.transactions.find((t) => t.kind === 'adjustment')!
    expect(correction).toMatchObject({ amount: '-5000', date: '2026-01-01' })
    expect(state.accounts.find((account) => account.id === a)!.openingBalance).toBe('100000')
    expect(
      accountBalance(
        state.accounts.find((account) => account.id === a)!,
        state.transactions,
      ),
    ).toBe('80000')
    expect(
      sumAmounts(state.transactions.filter((t) => t.kind === 'expense').map((t) => t.amount)),
    ).toBe('15000')
    await expect(
      run({ op: 'transaction.update', id: correction.id, data: expense(a) }),
    ).rejects.toThrow()
  })
  it('detects a stale balance and does not create zero corrections', async () => {
    await run({ op: 'transaction.create', data: expense(a) })
    await expect(
      run({
        op: 'account.reconcile',
        id: a,
        data: { date: localDate(), expectedBalance: '100000', targetBalance: '100000' },
      }),
    ).rejects.toThrow()
    await run({
      op: 'account.reconcile',
      id: a,
      data: { date: localDate(), expectedBalance: '90000', targetBalance: '90000' },
    })
    expect((await readWorkspace()).transactions).toHaveLength(1)
  })
})
describe('backup validation and atomic restoration', () => {
  it('round-trips archive flags, deleted transactions, corrections, metadata and all sections', async () => {
    await run({ op: 'goal.create', data: { title: 'Отпуск', target: '50000', saved: '10000' } })
    await run({ op: 'event.create', data: { title: 'План', date: localDate() } })
    await run({ op: 'shopping.create', data: { title: 'Хлеб' } })
    await run({
      op: 'obligation.create',
      data: {
        title: 'Долг',
        kind: 'debt',
        openingBalance: '100',
        startDate: localDate(),
        payment: '0',
        dueDay: 5,
      },
    })
    await run({ op: 'transaction.create', data: expense(a) })
    await run({ op: 'transaction.delete', id: (await readWorkspace()).transactions[0]!.id })
    await run({
      op: 'account.reconcile',
      id: a,
      data: { date: localDate(), expectedBalance: '100000', targetBalance: '105000' },
    })
    await run({ op: 'account.archive', id: b, archived: true })
    const original = await readWorkspace(),
      backup = createBackup(original)
    await run({ op: 'workspace.reset', confirmation: 'УДАЛИТЬ' })
    await run({
      op: 'workspace.restore',
      backup: JSON.parse(JSON.stringify(backup)),
      expectedRevision: (await readWorkspace()).revision,
      confirmation: 'ВОССТАНОВИТЬ',
    })
    const restored = await readWorkspace()
    expect(restored.accounts).toEqual(original.accounts)
    expect(restored.deletedTransactions).toHaveLength(1)
    expect(restored.transactions[0]).toMatchObject({ kind: 'adjustment', amount: '5000' })
    expect(restored.goals).toHaveLength(1)
    expect(restored.events).toHaveLength(1)
    expect(restored.shopping).toHaveLength(1)
    expect(restored.obligations).toHaveLength(1)
  })
  it('migrates version 1 JSON files with defaults for new fields', async () => {
    await run({ op: 'transaction.create', data: expense(a) })
    const old = JSON.parse(JSON.stringify(createBackup(await readWorkspace())))
    old.version = 1
    delete old.deletedTransactions
    for (const account of old.accounts) {
      delete account.archived
      delete account.bankName
      delete account.last4
    }
    for (const transaction of old.transactions) {
      delete transaction.deletedAt
      delete transaction.importAccountId
    }
    const parsed = backupSchema.parse(old)
    expect(parsed.accounts[0]).toMatchObject({ bankName: '', last4: '', archived: false })
    expect(parsed.transactions[0]!.deletedAt).toBeNull()
    await run({
      op: 'workspace.restore',
      backup: old,
      expectedRevision: (await readWorkspace()).revision,
      confirmation: 'ВОССТАНОВИТЬ',
    })
    expect((await readWorkspace()).transactions).toHaveLength(1)
  })
  it('rejects unknown versions, dangling references, duplicate IDs and invalid amounts before replacing records', async () => {
    await run({ op: 'transaction.create', data: expense(a) })
    const backup = createBackup(await readWorkspace())
    expect(backupSchema.safeParse({ ...backup, version: 99 }).success).toBe(false)
    expect(
      backupSchema.safeParse({ ...backup, accounts: [backup.accounts[0], backup.accounts[0]] })
        .success,
    ).toBe(false)
    expect(
      backupSchema.safeParse({
        ...backup,
        transactions: [{ ...backup.transactions[0], accountId: crypto.randomUUID() }],
      }).success,
    ).toBe(false)
    const invalid = { ...backup, transactions: [{ ...backup.transactions[0], amount: '-1' }] }
    await expect(
      run({
        op: 'workspace.restore',
        backup: invalid,
        expectedRevision: (await readWorkspace()).revision,
        confirmation: 'ВОССТАНОВИТЬ',
      }),
    ).rejects.toThrow()
    expect((await readWorkspace()).transactions[0]!.amount).toBe('10000')
  })
  it('rejects a restore preview when the workspace has since changed', async () => {
    const state = await readWorkspace(),
      backup = createBackup(state)
    await run({ op: 'shopping.create', data: { title: 'Новая запись' } })
    await expect(
      run({
        op: 'workspace.restore',
        backup,
        expectedRevision: state.revision,
        confirmation: 'ВОССТАНОВИТЬ',
      }),
    ).rejects.toThrow()
    expect((await readWorkspace()).shopping[0]!.title).toBe('Новая запись')
  })
  it('rolls back the entire replacement if a database write fails midway', async () => {
    await run({ op: 'shopping.create', data: { title: 'Сохранить меня' } })
    const original = await readWorkspace(),
      backup = createBackup(original)
    backup.shopping[0]!.title = 'FAIL_RESTORE'
    const db = await getDb()
    await db.execute(
      sql`ALTER TABLE shopping ADD CONSTRAINT reject_restore_test CHECK (title <> 'FAIL_RESTORE')`,
    )
    try {
      await expect(
        run({
          op: 'workspace.restore',
          backup,
          expectedRevision: original.revision,
          confirmation: 'ВОССТАНОВИТЬ',
        }),
      ).rejects.toThrow()
      const state = await readWorkspace()
      expect(state.accounts).toEqual(original.accounts)
      expect(state.shopping[0]!.title).toBe('Сохранить меня')
      expect(state.revision).toBe(original.revision)
    } finally {
      await db.execute(sql`ALTER TABLE shopping DROP CONSTRAINT reject_restore_test`)
    }
  })
})
