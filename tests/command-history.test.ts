import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PGlite } from '@electric-sql/pglite'
import { getDb } from '../server/db'
import {
  commandSchema,
  executeCommand,
  getWorkspaceBackups,
  readWorkspace,
} from '../server/modules/workspace'
import { readCommandHistory } from '../server/modules/command-history'
import { backupSchema, createBackup } from '../shared/backup'
import { commandHistoryMigration } from '../server/db/command-history-migration'
import { migration } from '../server/db/migration'
import { localDate } from '../shared/money'

const run = (input: unknown) => executeCommand(commandSchema.parse(input))
const account = (name = 'Карта') => ({
  op: 'account.create',
  data: { name, openingBalance: '100000' },
})
const history = async () => (await readWorkspace(true)).commandHistory!
beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), 'lad-command-history-'))
  process.env.LAD_DATA_DIR = join(root, 'db')
  process.env.LAD_BACKUP_DIR = join(root, 'backups')
  process.env.LAD_BACKUP_EVERY = '100'
  process.env.LAD_BACKUP_KEEP = '4'
  delete process.env.DATABASE_URL
})
beforeEach(async () => {
  await run({ op: 'workspace.reset', confirmation: 'УДАЛИТЬ' })
})
afterAll(async () => {
  await ((await getDb()).$client as PGlite).close()
})

describe('transactional command history', () => {
  it('records normalized payload, result, time and the committed revision without loading history in the workspace API', async () => {
    const revision = (await readWorkspace()).revision
    await run(account())
    const entries = await history()
    const latest = entries.at(-1)!
    expect(entries).toHaveLength(2)
    expect(latest).toMatchObject({
      operation: 'account.create',
      revision: (BigInt(revision) + 1n).toString(),
      payload: { data: { name: 'Карта', openingBalance: '100000' } },
      result: { ok: true },
    })
    expect(Number.isFinite(Date.parse(latest.createdAt))).toBe(true)
    expect((await readWorkspace()).revision).toBe(latest.revision)
    expect((await readWorkspace()).commandHistory).toBeUndefined()
  })

  it('does not record rejected commands or partial imports, and leaves their revision unchanged', async () => {
    await run(account())
    const before = await readWorkspace(true)
    await expect(
      run({
        op: 'account.update',
        id: before.accounts[0]!.id,
        data: { name: 'Устарело', openingBalance: '100000' },
        expectedRevision: '0',
      }),
    ).rejects.toThrow()
    await expect(
      run({
        op: 'import',
        data: {
          transactions: [
            {
              accountId: before.accounts[0]!.id,
              kind: 'expense',
              amount: '100',
              date: localDate(),
              category: 'Дом',
              importKey: 'first',
            },
            {
              accountId: crypto.randomUUID(),
              kind: 'expense',
              amount: '100',
              date: localDate(),
              category: 'Дом',
              importKey: 'bad',
            },
          ],
        },
      }),
    ).rejects.toThrow()
    expect(await readWorkspace(true)).toEqual(before)
  })

  it('rolls back the financial change and revision if inserting its journal record fails', async () => {
    const db = (await getDb()).$client as PGlite
    const before = await readWorkspace(true)
    await db.exec(`CREATE FUNCTION reject_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'journal unavailable'; END $$;
      CREATE TRIGGER reject_history BEFORE INSERT ON command_history FOR EACH ROW EXECUTE FUNCTION reject_history();`)
    try {
      await expect(run(account())).rejects.toThrow()
      expect(await readWorkspace(true)).toEqual(before)
    } finally {
      await db.exec(
        'DROP TRIGGER reject_history ON command_history; DROP FUNCTION reject_history();',
      )
    }
    await expect(run(account('После сбоя'))).resolves.toEqual({ ok: true })
  })

  it('logs demo, planning and obligation commands once each, including their internal changes', async () => {
    await run({ op: 'demo.load' })
    await run({
      op: 'plan.save',
      direction: 'income',
      data: {
        title: 'Разовое поступление',
        category: 'Зарплата',
        amount: '10000',
        frequency: 'once',
        startDate: localDate(),
      },
    })
    await run({
      op: 'obligation.create',
      data: {
        title: 'Долг',
        kind: 'debt',
        openingBalance: '10000',
        startDate: localDate(),
        payment: '0',
        dueDay: 5,
      },
    })
    expect((await history()).map((e) => e.operation)).toEqual([
      'workspace.reset',
      'demo.load',
      'plan.save',
      'obligation.create',
    ])
  })

  it('records repeated successful confirmations without creating another financial transaction', async () => {
    await run(account())
    const accountId = (await readWorkspace()).accounts[0]!.id
    await run({
      op: 'plan.save',
      direction: 'income',
      data: {
        title: 'Доход',
        category: 'Зарплата',
        amount: '10000',
        frequency: 'once',
        startDate: localDate(),
        accountId,
      },
    })
    const w = await readWorkspace()
    const confirm = {
      op: 'occurrence.confirm',
      planId: w.plans[0]!.id,
      dueDate: localDate(),
      expectedRevision: w.revision,
      mode: 'create',
      accountId,
      amount: '10000',
      date: localDate(),
    }
    await run(confirm)
    await run(confirm)
    expect((await readWorkspace()).transactions).toHaveLength(1)
    const entries = (await history()).filter((e) => e.operation === 'occurrence.confirm')
    expect(entries).toHaveLength(2)
    expect(entries[1]!.result.alreadyPaid).toBe(true)
    expect(BigInt(entries[1]!.revision)).toBe(BigInt(entries[0]!.revision) + 1n)
  })

  it('assigns unique ordered revisions to concurrent requests and paginates without duplicates', async () => {
    await Promise.all(Array.from({ length: 5 }, (_, i) => run(account(`Счёт ${i}`))))
    const entries = await history()
    expect(new Set(entries.map((e) => e.revision)).size).toBe(6)
    const first = await readCommandHistory(undefined, 2)
    await run(account('Новое изменение'))
    const second = await readCommandHistory(first.nextBefore!, 2)
    expect(
      first.entries.every(
        (e) => BigInt(e.revision) > BigInt(first.nextBefore!) || e.revision === first.nextBefore,
      ),
    ).toBe(true)
    expect(second.entries.every((e) => BigInt(e.revision) < BigInt(first.nextBefore!))).toBe(true)
    expect(new Set([...first.entries, ...second.entries].map((e) => e.id)).size).toBe(4)
  })

  it('restores saved history, advances beyond both revision ranges and records compact restore metadata', async () => {
    await run(account())
    const backup = createBackup(await readWorkspace(true))
    backup.commandHistory.at(-1)!.revision = '9000'
    const before = (await readWorkspace()).revision
    await run({
      op: 'workspace.restore',
      backup,
      expectedRevision: before,
      confirmation: 'ВОССТАНОВИТЬ',
    })
    const entries = await history()
    expect(entries.slice(0, -1)).toEqual(backup.commandHistory)
    expect(entries.at(-1)).toMatchObject({
      operation: 'workspace.restore',
      revision: '9001',
      payload: { backup: { version: 5, exportedAt: backup.exportedAt } },
    })
    const metadata = entries.at(-1)!.payload.backup as Record<string, unknown>
    expect(metadata.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(metadata.accounts).toBeUndefined()
    expect(JSON.stringify(entries.at(-1)!.payload).length).toBeLessThan(1500)
  })

  it('resets history to a single reset record while preserving the old history in the safety copy', async () => {
    await run(account('До очистки'))
    const before = await history()
    await run({ op: 'workspace.reset', confirmation: 'УДАЛИТЬ' })
    const entries = await history()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ operation: 'workspace.reset', payload: {} })
    expect(BigInt(entries[0]!.revision)).toBeGreaterThan(BigInt(before.at(-1)!.revision))
    const backups = getWorkspaceBackups()
    const saved = await backups.read((await backups.status()).files[0]!.name)
    expect(saved.commandHistory).toEqual(before)
  })

  it('upgrades versions 1–4 without inventing history and rejects malformed version 5 logs', async () => {
    await run(account())
    const backup = createBackup(await readWorkspace(true))
    for (const version of [1, 2, 3, 4]) {
      const legacy = { ...backup, version }
      expect(backupSchema.parse(legacy).commandHistory).toEqual([])
    }
    const duplicate = structuredClone(backup)
    duplicate.commandHistory[1]!.revision = duplicate.commandHistory[0]!.revision
    expect(backupSchema.safeParse(duplicate).success).toBe(false)
    const malformed = structuredClone(backup)
    malformed.commandHistory[0]!.revision = 'invalid'
    expect(backupSchema.safeParse(malformed).success).toBe(false)
    expect(backupSchema.safeParse({ ...backup, commandHistory: undefined }).success).toBe(false)
  })

  it('migrates version 9 without changing records or revision and is safe to repeat', async () => {
    const db = new PGlite()
    try {
      await db.exec(migration.replace(commandHistoryMigration, ''))
      await db.exec(
        "INSERT INTO accounts(id,name,kind,opening_balance,color) VALUES ('legacy','Старый счёт','card',100,'green'); UPDATE workspace_guard SET revision = 42;",
      )
      const before = (await db.query('SELECT * FROM accounts')).rows
      await db.exec(commandHistoryMigration)
      await db.exec(commandHistoryMigration)
      expect((await db.query('SELECT * FROM accounts')).rows).toEqual(before)
      expect((await db.query('SELECT revision FROM workspace_guard')).rows[0]!.revision).toBe('42')
      expect((await db.query('SELECT * FROM command_history')).rows).toEqual([])
      expect(
        (await db.query('SELECT version FROM lad_migrations WHERE version=10')).rows,
      ).toHaveLength(1)
    } finally {
      await db.close()
    }
  })
})
