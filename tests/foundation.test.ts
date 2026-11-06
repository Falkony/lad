import { beforeAll, beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { commandSchema, executeCommand, readWorkspace } from '../server/modules/workspace'
import { migration, migrationThrough } from '../server/db/migration'
import { foundationMigration } from '../server/db/foundation-migration'
import { createBackup, backupSchema } from '../shared/backup'
import { configureTimeZone, dateInTimeZone } from '../shared/time-zone'
import { pastDate } from '../shared/schemas'
import { localDate } from '../shared/money'
const run = (input: unknown) => executeCommand(commandSchema.parse(input))
beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), 'lad-foundation-'))
  process.env.LAD_DATA_DIR = join(root, 'db')
  process.env.LAD_BACKUP_DIR = join(root, 'backups')
  delete process.env.DATABASE_URL
})
beforeEach(async () => {
  await run({ op: 'workspace.reset', confirmation: 'УДАЛИТЬ' })
  await run({ op: 'account.create', data: { name: 'Карта', openingBalance: '100000' } })
})
afterEach(() => {
  vi.useRealTimers()
  configureTimeZone('Europe/Moscow')
})
async function expense(category: string) {
  const account = (await readWorkspace()).accounts[0]!
  await run({
    op: 'transaction.create',
    data: { accountId: account.id, category, amount: '100', kind: 'expense', date: localDate() },
  })
}
describe('foundation: category identities and workspace time', () => {
  it('migrates names to foreign keys without changing money, and repeats safely', async () => {
    const db = new PGlite()
    try {
      await db.exec(migrationThrough(10))
      await db.exec(
        "INSERT INTO accounts(id,name,kind,opening_balance,color) VALUES('a','Счёт','card',123456,'green'); INSERT INTO transactions(id,kind,amount,account_id,category,description,date) VALUES('t','expense',123,'a','Дом','','2026-01-01'); INSERT INTO budgets(id,month,category,\"limit\") VALUES('b','2026-01','Дом',1000)",
      )
      await db.exec(foundationMigration)
      const before = (await db.query('SELECT * FROM transactions')).rows
      await db.exec(foundationMigration)
      expect((await db.query('SELECT * FROM transactions')).rows).toEqual(before)
      expect((await db.query('SELECT amount FROM transactions')).rows[0]!.amount).toBe('123')
      expect(
        (
          await db.query(
            'SELECT t.category_id=b.category_id AS same FROM transactions t CROSS JOIN budgets b',
          )
        ).rows[0]!.same,
      ).toBe(true)
    } finally {
      await db.close()
    }
  })
  it('renames a category everywhere while preserving identity, operations and historical versions', async () => {
    await expense('Дом')
    await run({ op: 'budget.set', data: { month: '2026-11', category: 'Дом', limit: '1000' } })
    await run({
      op: 'plan.save',
      direction: 'expense',
      data: {
        title: 'Платёж',
        category: 'Дом',
        amount: '100',
        frequency: 'monthly',
        startDate: '2026-11-01',
      },
    })
    const before = await readWorkspace()
    const cat = before.categories!.find((c) => c.name === 'Дом')!
    await run({
      op: 'category.rename',
      id: cat.id,
      name: 'Жильё',
      expectedRevision: before.revision,
    })
    const after = await readWorkspace()
    expect(after.transactions[0]!.amount).toBe('100')
    expect((after.transactions[0] as any).categoryId).toBe(cat.id)
    for (const key of ['transactions', 'budgets', 'plans', 'planVersions'] as const)
      expect(after[key].every((row) => row.category === 'Жильё')).toBe(true)
    expect(backupSchema.safeParse(createBackup(after)).success).toBe(true)
  })
  it('merges overlapping monthly limits and references without changing recorded amounts', async () => {
    await expense('Первая')
    await expense('Вторая')
    for (const [category, limit] of [
      ['Первая', '1000'],
      ['Вторая', '2000'],
    ])
      await run({ op: 'budget.set', data: { month: '2026-11', category, limit } })
    const before = await readWorkspace(),
      first = before.categories!.find((c) => c.name === 'Первая')!,
      second = before.categories!.find((c) => c.name === 'Вторая')!
    await run({
      op: 'category.merge',
      id: first.id,
      targetId: second.id,
      expectedRevision: before.revision,
    })
    const after = await readWorkspace()
    expect(after.budgets).toHaveLength(1)
    expect(after.budgets[0]!.limit).toBe('3000')
    expect(after.transactions.map((t) => t.amount)).toEqual(['100', '100'])
    expect(after.categories!.some((c) => c.id === first.id)).toBe(false)
    expect(after.transactions.every((t) => (t as any).categoryId === second.id)).toBe(true)
  })
  it('rejects new assignments to an archived category and rejects stale merge previews', async () => {
    await expense('Архив')
    const w = await readWorkspace(),
      cat = w.categories![0]!
    await run({ op: 'category.archive', id: cat.id, archived: true })
    await expect(expense('Архив')).rejects.toThrow('архиве')
    await run({ op: 'category.create', name: 'Новая' })
    await expect(
      run({
        op: 'category.merge',
        id: cat.id,
        targetId: (await readWorkspace()).categories!.find((c) => c.name === 'Новая')!.id,
        expectedRevision: w.revision,
      }),
    ).rejects.toThrow()
  })
  it('exports and restores category IDs and timezone, validates dangling references', async () => {
    await expense('Дом')
    let w = await readWorkspace()
    await run({ op: 'settings.update', timeZone: 'Asia/Tokyo', expectedRevision: w.revision })
    w = await readWorkspace()
    const backup = createBackup(w)
    expect(backup.timeZone).toBe('Asia/Tokyo')
    const broken = structuredClone(backup)
    broken.transactions[0]!.categoryId = crypto.randomUUID()
    expect(backupSchema.safeParse(broken).success).toBe(false)
    await run({ op: 'workspace.reset', confirmation: 'УДАЛИТЬ' })
    await run({
      op: 'workspace.restore',
      backup,
      expectedRevision: (await readWorkspace()).revision,
      confirmation: 'ВОССТАНОВИТЬ',
    })
    expect((await readWorkspace()).categories).toEqual(w.categories)
    expect((await readWorkspace()).timeZone).toBe('Asia/Tokyo')
  })
  it('uses the workspace day at UTC midnight for input validation', () => {
    const now = new Date('2026-11-06T22:30:00Z')
    expect(dateInTimeZone(now, 'Europe/Moscow')).toBe('2026-11-07')
    expect(dateInTimeZone(now, 'America/New_York')).toBe('2026-11-06')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(now)
    configureTimeZone('America/New_York')
    expect(pastDate().safeParse('2026-11-07').success).toBe(false)
    configureTimeZone('Europe/Moscow')
    expect(pastDate().safeParse('2026-11-07').success).toBe(true)
  })
})
