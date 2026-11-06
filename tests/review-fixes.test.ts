import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { commandSchema, executeCommand, readWorkspace } from '../server/modules/workspace'
import { getDb, lockDataDir } from '../server/db'
import { transactions } from '../server/db/schema'
import { backupSchema, createBackup } from '../shared/backup'
import { localDate } from '../shared/money'
import { addDays } from '../shared/planning'
import { previewImport } from '../shared/import'

const run = async (input: unknown) => executeCommand(commandSchema.parse(input))
const missing = '00000000-0000-4000-8000-000000000000'
let account: string
beforeAll(async () => {
  process.env.LAD_DATA_DIR = join(await mkdtemp(join(tmpdir(), 'lad-fixes-')), 'db')
  delete process.env.DATABASE_URL
})
beforeEach(async () => {
  await run({ op: 'workspace.reset', confirmation: 'УДАЛИТЬ' })
  await run({ op: 'account.create', data: { name: 'Карта', openingBalance: '0' } })
  account = (await readWorkspace()).accounts[0]!.id
})

describe('backup export', () => {
  it('still exports and restores a workspace that contains a future-dated row', async () => {
    const db = await getDb()
    await db.insert(transactions).values({
      id: crypto.randomUUID(),
      kind: 'expense',
      amount: '100',
      accountId: account,
      category: 'Дом',
      description: '',
      date: addDays(localDate(), 3),
    })
    const state = await readWorkspace()
    const backup = createBackup(state)
    expect(backupSchema.safeParse(backup).success).toBe(true)
    await run({
      op: 'workspace.restore',
      backup: JSON.parse(JSON.stringify(backup)),
      expectedRevision: state.revision,
      confirmation: 'ВОССТАНОВИТЬ',
    })
    expect((await readWorkspace()).transactions).toHaveLength(1)
  })
  it('rejects a shopping checkout dated in the future', () => {
    expect(
      commandSchema.safeParse({
        op: 'shopping.checkout',
        data: { accountId: account, amount: '100', date: addDays(localDate(), 1) },
      }).success,
    ).toBe(false)
  })
})

describe('stale edits', () => {
  it('rejects a full-object update based on an old revision', async () => {
    await run({
      op: 'goal.create',
      data: { title: 'Цель', target: '1000', saved: '0' },
    })
    const before = await readWorkspace()
    const goal = before.goals[0]!
    await run({ op: 'goal.update', id: goal.id, data: { ...goal, title: 'Свежая' } })
    await expect(
      run({
        op: 'goal.update',
        id: goal.id,
        data: { ...goal, title: 'Устаревшая' },
        expectedRevision: before.revision,
      }),
    ).rejects.toMatchObject({ statusCode: 409 })
    expect((await readWorkspace()).goals[0]!.title).toBe('Свежая')
  })
  it('reports 404 for edits of records that no longer exist', async () => {
    for (const command of [
      { op: 'goal.delete', id: missing },
      { op: 'event.toggle', id: missing, done: true },
      { op: 'shopping.delete', id: missing },
      { op: 'obligation.delete', id: missing },
      { op: 'transaction.delete', id: missing },
      { op: 'transaction.restore', id: missing },
      { op: 'budget.delete', id: missing },
    ])
      await expect(run(command)).rejects.toMatchObject({ statusCode: 404 })
  })
})

it('flags future-dated statement rows in the import preview', async () => {
  const preview = await previewImport(
    [
      { date: localDate(), amount: '-10' },
      { date: addDays(localDate(), 2), amount: '-10' },
    ],
    {
      date: 'date',
      amount: 'amount',
      description: '',
      category: '',
      externalId: '',
      mode: 'signed',
    },
    account,
  )
  expect(preview.rows).toHaveLength(1)
  expect(preview.errors[0]).toMatch(/Строка 3/)
})

describe('embedded database lock', () => {
  it('refuses a directory held by another live process and takes over a stale lock', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'lad-lock-')), 'db')
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'])
    try {
      await writeFile(`${dir}.lock`, String(holder.pid))
      await expect(lockDataDir(dir)).rejects.toThrow(/другим процессом/)
    } finally {
      holder.kill()
    }
    await new Promise((resolve) => holder.once('exit', resolve))
    await lockDataDir(dir)
    expect(await readFile(`${dir}.lock`, 'utf8')).toBe(String(process.pid))
  })
})
