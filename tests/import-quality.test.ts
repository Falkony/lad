import { beforeAll, beforeEach, describe, it, expect } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commandSchema, executeCommand, readWorkspace } from '../server/modules/workspace'
import { previewStatement, previewImportUndo } from '../server/modules/import-workflow'
import { readTransactions } from '../server/modules/transaction-pages'
import { importSchema } from '../shared/schemas'
import { createBackup, backupSchema } from '../shared/backup'
import { accountBalance, localDate } from '../shared/money'
import { categorySpending, monthPlan, projectPlans } from '../shared/planning'
const run = (c: unknown) => executeCommand(commandSchema.parse(c))
describe('import compatibility and linked restore', () => {
  it('upgrades aliases from an old copy and preserves repeated import protection', async () => {
    const r = await row()
    await apply([r])
    let w = await readWorkspace()
    const old: any = createBackup(w)
    old.version = 8
    for (const key of ['importBatches', 'importRules', 'importTemplates', 'importKeys'])
      delete old[key]
    for (const t of old.transactions) {
      delete t.splits
      delete t.refundOf
    }
    const backup = backupSchema.parse(old)
    expect(backup.importKeys).toHaveLength(1)
    await run({
      op: 'workspace.restore',
      backup,
      expectedRevision: w.revision,
      confirmation: 'ВОССТАНОВИТЬ',
    })
    expect(await apply([r])).toMatchObject({ skipped: 1, imported: 0 })
  })
  it('matches a credit repayment to its plan as a transfer', async () => {
    const r = await row()
    await run({
      op: 'account.create',
      data: {
        name: 'Кредитная',
        kind: 'credit',
        openingBalance: '-100',
        creditSettings: {
          limit: '1000',
          payFull: true,
          graceUntil: localDate(),
          payerAccountId: r.accountId,
        },
      },
    })
    const preview = await previewStatement(importSchema.parse({ transactions: [r] }))
    const p = preview.suggestions[0]!.plans[0]!
    await apply([r], [{ index: 0, action: 'plan', planId: p.planId, dueDate: p.dueDate }])
    const w = await readWorkspace()
    expect(w.transactions[0]!.kind).toBe('transfer')
    const card = w.accounts.find((a) => a.kind === 'credit')!
    expect(accountBalance(card, w.transactions)).toBe('0')
    expect(monthPlan(w, localDate().slice(0, 7)).spent).toBe('0')
  })
  it('restores a split purchase with a refund foreign key without changing balances or categories', async () => {
    const r = await row()
    await run({ op: 'transaction.create', data: r })
    let w = await readWorkspace()
    const original = w.transactions[0]!
    await run({
      op: 'transaction.details',
      id: original.id,
      expectedRevision: w.revision,
      splits: [{ categoryId: w.categories![0]!.id, amount: r.amount }],
    })
    await run({
      op: 'transaction.create',
      data: { ...r, kind: 'income', amount: '30', importKey: null, refundOf: original.id },
    })
    w = await readWorkspace()
    const backup = backupSchema.parse(createBackup(w))
    await run({
      op: 'workspace.restore',
      backup,
      expectedRevision: w.revision,
      confirmation: 'ВОССТАНОВИТЬ',
    })
    const restored = await readWorkspace()
    expect(restored.transactions).toEqual(w.transactions)
    expect(monthPlan(restored, localDate().slice(0, 7))).toMatchObject({
      received: '0',
      spent: '70',
    })
  })
})
beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), 'lad-import-quality-'))
  process.env.LAD_DATA_DIR = join(root, 'db')
  process.env.LAD_BACKUP_DIR = join(root, 'backups')
  delete process.env.DATABASE_URL
})
beforeEach(async () => {
  await run({ op: 'workspace.reset', confirmation: 'УДАЛИТЬ' })
  await run({ op: 'account.create', data: { name: 'Основной', openingBalance: '100000' } })
  await run({ op: 'account.create', data: { name: 'Второй', openingBalance: '10000' } })
})
async function row(key = 'one') {
  const w = await readWorkspace()
  return {
    kind: 'expense',
    accountId: w.accounts[0]!.id,
    amount: '100',
    date: localDate(),
    category: 'Дом',
    description: 'Магазин у дома',
    importKey: key,
  }
}
async function apply(rows: unknown[], decisions: unknown[] = []) {
  const w = await readWorkspace()
  return run({
    op: 'import',
    expectedRevision: w.revision,
    data: { transactions: rows, decisions, fileName: 'Банк.csv' },
  })
}
describe('period reads and reviewed imports', () => {
  it('uses server pagination, period filters, stable ordering and totals from all filtered rows', async () => {
    const base = await row()
    await apply(
      Array.from({ length: 45 }, (_, i) => ({
        ...base,
        importKey: 'page-' + i,
        description: 'Строка ' + i,
      })),
    )
    const one = await readTransactions({ limit: 20, page: 1, month: localDate().slice(0, 7) }),
      two = await readTransactions({ limit: 20, page: 2, month: localDate().slice(0, 7) })
    expect(one.rows).toHaveLength(20)
    expect(two.rows).toHaveLength(20)
    expect(one.count).toBe(45)
    expect(one.expense).toBe('4500')
    expect(new Set([...one.rows, ...two.rows].map((t) => t.id)).size).toBe(40)
    expect((await readTransactions({ search: 'Строка 1' })).count).toBe(11)
  })
  it('returns a limited ledger with exact opening anchors, references and current balances', async () => {
    const old = { ...(await row('old')), date: '2020-01-01' }
    await apply([old])
    await run({
      op: 'plan.save',
      direction: 'expense',
      data: {
        title: 'План',
        category: 'Дом',
        amount: '100',
        frequency: 'once',
        startDate: localDate(),
      },
    })
    let w = await readWorkspace()
    const plan = w.plans[0]!
    await run({
      op: 'occurrence.confirm',
      planId: plan.id,
      dueDate: localDate(),
      mode: 'link',
      transactionId: w.transactions[0]!.id,
      date: '2020-01-01',
      expectedRevision: w.revision,
    })
    w = await readWorkspace()
    const slim = await readWorkspace(false, localDate().slice(0, 7) + '-01')
    expect(slim.transactions).toHaveLength(0)
    expect(slim.referenceTransactions).toHaveLength(1)
    for (const a of slim.accounts)
      expect(accountBalance(a, slim.transactions)).toBe(
        accountBalance(
          w.accounts.find((x) => x.id === a.id)!,
          w.transactions,
        ),
      )
    expect(slim.accounts[0]!.originalOpeningBalance).toBe(w.accounts[0]!.openingBalance)
    expect(projectPlans(slim, localDate(), localDate())[0]!.status).toBe('paid')
  })
  it('applies ordered scoped categorization rules and preserves mapping templates in backups', async () => {
    await run({ op: 'category.create', name: 'Авто' })
    let w = await readWorkspace()
    await run({
      op: 'import.rule.save',
      data: {
        name: 'Магазины',
        pattern: 'магазин',
        categoryId: w.categories![0]!.id,
        accountId: w.accounts[0]!.id,
        kind: 'expense',
        priority: 1,
      },
    })
    const r = await row()
    const p = await previewStatement(importSchema.parse({ transactions: [r] }))
    expect(p.rows[0]!.category).toBe('Авто')
    await apply([r])
    const mapping = {
      date: 'Дата',
      amount: 'Сумма',
      description: 'Описание',
      category: '',
      externalId: 'ID',
      mode: 'signed',
    }
    await run({ op: 'import.template.save', name: 'Мой банк', mapping })
    w = await readWorkspace()
    expect(backupSchema.parse(createBackup(w)).importTemplates[0]!.mapping).toEqual(mapping)
    expect(w.importBatches![0]!.report.imported).toBe(1)
  })
  it('matches a manual row and keeps the bank alias after moving, deleting and restoring data', async () => {
    const r = await row()
    await run({ op: 'transaction.create', data: { ...r, importKey: null } })
    let w = await readWorkspace()
    const original = w.transactions[0]!
    const p = await previewStatement(importSchema.parse({ transactions: [r] }))
    expect(p.suggestions[0]!.manualIds).toContain(original.id)
    expect(
      await apply([r], [{ index: 0, action: 'match', transactionId: original.id }]),
    ).toMatchObject({ imported: 0, matched: 1 })
    await run({
      op: 'transaction.update',
      id: original.id,
      data: { ...original, accountId: w.accounts[1]!.id },
    })
    await run({ op: 'transaction.delete', id: original.id })
    expect(await apply([r])).toMatchObject({ imported: 0, skipped: 1 })
    w = await readWorkspace()
    const backup = backupSchema.parse(createBackup(w))
    await run({
      op: 'workspace.restore',
      backup,
      expectedRevision: w.revision,
      confirmation: 'ВОССТАНОВИТЬ',
    })
    expect(await apply([r])).toMatchObject({ imported: 0, skipped: 1 })
    expect((await readWorkspace()).deletedTransactions).toHaveLength(1)
  })
  it('suggests plan matches and records one repayment rather than another expense', async () => {
    const r = await row()
    await run({
      op: 'obligation.create',
      data: {
        title: 'Долг',
        kind: 'debt',
        openingBalance: '100',
        startDate: localDate(),
        payment: '100',
        dueDay: Number(localDate().slice(8)),
        rate: '0',
        accountId: r.accountId,
      },
    })
    const p = await previewStatement(importSchema.parse({ transactions: [r] }))
    expect(p.suggestions[0]!.plans).toHaveLength(1)
    const match = p.suggestions[0]!.plans[0]!
    await apply([r], [{ index: 0, action: 'plan', planId: match.planId, dueDate: match.dueDate }])
    const w = await readWorkspace()
    expect(w.transactions).toHaveLength(1)
    expect(w.obligationEntries[0]!.principal).toBe('100')
    expect((await previewImportUndo(w.importBatches![0]!.id)).problems.length).toBeGreaterThan(0)
  })
  it('imports both sides of an own transfer with two aliases and unchanged total money', async () => {
    const r = await row(),
      w = await readWorkspace()
    const from = w.accounts[0]!,
      to = w.accounts[1]!
    await apply([r], [{ index: 0, action: 'transfer', toAccountId: to.id }])
    let next = await readWorkspace()
    const transfer = next.transactions[0]!
    const incoming = { ...r, accountId: to.id, kind: 'income', importKey: 'other-bank-leg' }
    const preview = await previewStatement(importSchema.parse({ transactions: [incoming] }))
    expect(preview.suggestions[0]!.transferIds).toContain(transfer.id)
    await apply([incoming], [{ index: 0, action: 'match', transactionId: transfer.id }])
    next = await readWorkspace()
    expect(next.transactions).toHaveLength(1)
    expect(next.importKeys).toHaveLength(2)
    expect(
      next.accounts.reduce((sum, a) => sum + BigInt(accountBalance(a, next.transactions)), 0n),
    ).toBe(110000n)
  })
  it('keeps ambiguous equal-looking records separate unless the user chooses a match', async () => {
    const r = await row()
    for (let i = 0; i < 2; i++)
      await run({ op: 'transaction.create', data: { ...r, importKey: null } })
    const p = await previewStatement(importSchema.parse({ transactions: [r] }))
    expect(p.suggestions[0]!.ambiguous).toBe(true)
    await apply([r], [{ index: 0, action: 'ignore' }])
    expect((await readWorkspace()).transactions).toHaveLength(2)
  })
  it('previews undo, refuses edited rows, and permits explicit undo followed by re-import', async () => {
    const r = await row()
    const result = await apply([r])
    let preview = await previewImportUndo(result.batchId!)
    expect(preview.problems).toEqual([])
    await run({ op: 'import.undo', id: result.batchId, expectedRevision: preview.revision })
    let w = await readWorkspace()
    expect(w.transactions).toHaveLength(0)
    expect(w.deletedTransactions).toHaveLength(1)
    expect(await apply([r])).toMatchObject({ imported: 1 })
    w = await readWorkspace()
    const tx = w.transactions[0]!
    await run({ op: 'transaction.update', id: tx.id, data: { ...tx, description: 'Исправлено' } })
    preview = await previewImportUndo(w.importBatches!.find((b) => b.status === 'applied')!.id)
    expect(preview.problems.some((p) => p.includes('изменена'))).toBe(true)
    expect(backupSchema.safeParse(createBackup(await readWorkspace())).success).toBe(true)
  })
  it('splits a receipt exactly and allocates repeated one-kopeck refunds without rounding loss', async () => {
    for (const name of ['А', 'Б', 'В']) await run({ op: 'category.create', name })
    let w = await readWorkspace()
    const r = {
      ...(await row()),
      amount: '3',
      splits: w.categories!.map((c) => ({ categoryId: c.id, amount: '1' })),
    }
    await run({ op: 'transaction.create', data: r })
    w = await readWorkspace()
    const purchase = w.transactions[0]!
    for (let i = 0; i < 3; i++)
      await run({
        op: 'transaction.create',
        data: { ...r, kind: 'income', splits: [], amount: '1', refundOf: purchase.id },
      })
    w = await readWorkspace()
    expect([...categorySpending(w.transactions, localDate().slice(0, 7)).values()]).toEqual([
      0n,
      0n,
      0n,
    ])
    expect(monthPlan(w, localDate().slice(0, 7))).toMatchObject({ received: '0', spent: '0' })
    expect((await readTransactions({})).income).toBe('0')
    expect(accountBalance(w.accounts[0]!, w.transactions)).toBe(w.accounts[0]!.openingBalance)
    await expect(
      run({
        op: 'transaction.create',
        data: { ...r, kind: 'income', splits: [], amount: '1', refundOf: purchase.id },
      }),
    ).rejects.toThrow('превышают')
    expect(backupSchema.safeParse(createBackup(w)).success).toBe(true)
  })
  it('rejects invalid splits atomically and keeps deduplication through splits, refunds and deletion', async () => {
    const r = await row()
    await apply([r])
    let w = await readWorkspace()
    const t = w.transactions[0]!,
      category = w.categories![0]!
    await expect(
      run({
        op: 'transaction.details',
        id: t.id,
        expectedRevision: w.revision,
        splits: [{ categoryId: category.id, amount: '99' }],
      }),
    ).rejects.toThrow('Суммы')
    expect((await readWorkspace()).revision).toBe(w.revision)
    await run({
      op: 'transaction.details',
      id: t.id,
      expectedRevision: w.revision,
      splits: [{ categoryId: category.id, amount: '100' }],
    })
    expect(await apply([r])).toMatchObject({ skipped: 1 })
    await run({ op: 'transaction.delete', id: t.id })
    expect(await apply([r])).toMatchObject({ skipped: 1 })
  })
})
