import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { PGlite } from '@electric-sql/pglite'
import { backupSchema } from '../shared/backup'
import { localDate } from '../shared/money'

let root: string
const clients: PGlite[] = []
beforeEach(async () => {
  vi.resetModules()
  root = await mkdtemp(join(tmpdir(), 'lad-auto-backups-'))
  vi.stubEnv('DATABASE_URL', '')
  vi.stubEnv('LAD_DATA_DIR', join(root, 'db'))
  vi.stubEnv('LAD_BACKUP_DIR', join(root, 'backups'))
  vi.stubEnv('LAD_BACKUP_EVERY', '2')
  vi.stubEnv('LAD_BACKUP_KEEP', '3')
})
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

async function workspace() {
  const module = await import('../server/modules/workspace')
  const { getDb } = await import('../server/db')
  const client = (await getDb()).$client as PGlite
  clients.push(client)
  return {
    ...module,
    run: (input: unknown) => module.executeCommand(module.commandSchema.parse(input)),
    backups: module.getWorkspaceBackups(),
  }
}

const account = (name = 'Карта') => ({
  op: 'account.create',
  data: { name, openingBalance: '1234567890123456' },
})

describe('automatic backups', () => {
  it('uses configurable positive intervals and a separate directory next to the database', async () => {
    const { automaticBackupOptions } = await import('../server/modules/automatic-backups')
    vi.stubEnv('LAD_BACKUP_DIR', '')
    vi.stubEnv('LAD_BACKUP_EVERY', '')
    vi.stubEnv('LAD_BACKUP_KEEP', '')
    expect(automaticBackupOptions()).toEqual({
      directory: join(root, 'backups'),
      every: 10,
      keep: 20,
    })
    vi.stubEnv('LAD_BACKUP_EVERY', '0')
    expect(() => automaticBackupOptions()).toThrow('LAD_BACKUP_EVERY')
    vi.stubEnv('LAD_BACKUP_EVERY', '1.5')
    expect(() => automaticBackupOptions()).toThrow('LAD_BACKUP_EVERY')
    vi.stubEnv('LAD_BACKUP_EVERY', '1')
    vi.stubEnv('LAD_BACKUP_KEEP', '1')
    expect(() => automaticBackupOptions()).toThrow('LAD_BACKUP_KEEP')
  })

  it('creates one startup snapshot and copies only after successful committed changes', async () => {
    const w = await workspace()
    await Promise.all([w.backups.start(), w.backups.start()])
    expect((await w.backups.status()).files).toHaveLength(1)
    await w.run(account())
    await expect(
      w.run({
        op: 'transaction.create',
        data: {
          kind: 'expense',
          amount: '100',
          accountId: crypto.randomUUID(),
          category: 'Дом',
          date: localDate(),
        },
      }),
    ).rejects.toThrow()
    expect((await w.backups.status()).files).toHaveLength(1)
    await w.run(account('Наличные'))
    const status = await w.backups.status()
    expect(status.files).toHaveLength(2)
    const saved = await w.backups.read(status.files[0]!.name)
    expect(saved.accounts).toHaveLength(2)
    expect(saved.accounts[0]!.openingBalance).toBe('1234567890123456')
    expect(status.error).toBeNull()
  })

  it('serializes concurrent copies, rotates oldest files and leaves unrelated files alone', async () => {
    vi.stubEnv('LAD_BACKUP_EVERY', '1')
    vi.stubEnv('LAD_BACKUP_KEEP', '2')
    const w = await workspace()
    await w.backups.start()
    const first = (await w.backups.status()).files[0]!.name
    const unrelated = join(root, 'backups', 'manual-backup.json')
    await writeFile(unrelated, 'manual copy')
    await Promise.all(Array.from({ length: 4 }, (_, i) => w.run(account(`Счёт ${i}`))))
    const status = await w.backups.status()
    expect(status.files).toHaveLength(2)
    expect(status.files.some((file) => file.name === first)).toBe(false)
    expect((await w.backups.read(status.files[0]!.name)).accounts).toHaveLength(4)
    expect(await readFile(unrelated, 'utf8')).toBe('manual copy')
    expect((await readdir(status.directory)).filter((file) => file.endsWith('.tmp'))).toEqual([])
  })

  it('keeps data intact on backup failure, reports the error and retries the next change', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const blocked = join(root, 'blocked')
    await writeFile(blocked, 'not a directory')
    vi.stubEnv('LAD_BACKUP_DIR', blocked)
    const w = await workspace()
    await expect(w.run(account())).resolves.toEqual({ ok: true })
    expect((await w.backups.status()).error).not.toBeNull()
    await expect(w.run({ op: 'workspace.reset', confirmation: 'УДАЛИТЬ' })).rejects.toMatchObject({
      statusCode: 503,
    })
    expect((await w.readWorkspace()).accounts).toHaveLength(1)
    await rm(blocked)
    await w.run(account('После исправления'))
    const status = await w.backups.status()
    expect(status.error).toBeNull()
    expect((await w.backups.read(status.files[0]!.name)).accounts).toHaveLength(2)
  })

  it('does not rotate a good snapshot when the next snapshot fails validation', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubEnv('LAD_BACKUP_KEEP', '2')
    const w = await workspace()
    await w.run(account())
    await w.backups.capture()
    const beforeFiles = (await w.backups.status()).files
    const before = beforeFiles[0]!
    const contents = await readFile(join(root, 'backups', before.name), 'utf8')
    const { createAutomaticBackups, automaticBackupOptions } =
      await import('../server/modules/automatic-backups')
    const invalid = createAutomaticBackups(async () => {
      const state = await w.readWorkspace()
      state.accounts[0]!.openingBalance = 'invalid amount'
      return state
    }, automaticBackupOptions())
    expect(await invalid.start()).toBe(false)
    expect(await readFile(join(root, 'backups', before.name), 'utf8')).toBe(contents)
    expect((await invalid.status()).files).toEqual(beforeFiles)
    expect((await readdir(join(root, 'backups'))).some((name) => name.endsWith('.tmp'))).toBe(false)
  })

  it('saves changes below the interval before resetting the workspace', async () => {
    vi.stubEnv('LAD_BACKUP_EVERY', '100')
    const w = await workspace()
    await w.run(account())
    const before = await w.readWorkspace()
    await Promise.all([
      w.run(account('Параллельный запрос')),
      w.run({ op: 'workspace.reset', confirmation: 'УДАЛИТЬ' }),
    ])
    expect((await w.readWorkspace()).accounts).toEqual([])
    const status = await w.backups.status()
    const safetyCopy = await w.backups.read(status.files[0]!.name)
    expect(safetyCopy.accounts).toHaveLength(2)
    expect(safetyCopy.accounts).toContainEqual(before.accounts[0])
    expect(safetyCopy.accounts.some((a) => a.name === 'Параллельный запрос')).toBe(true)
  })

  it('rejects corrupt files and paths outside the managed backups', async () => {
    const w = await workspace()
    await w.backups.start()
    const { name } = (await w.backups.status()).files[0]!
    await expect(w.backups.read('../db')).rejects.toThrow()
    await expect(w.backups.read('manual.json')).rejects.toThrow()
    await writeFile(join(root, 'backups', name), '{broken')
    await expect(w.backups.read(name)).rejects.toThrow()
  })

  it('retains the pre-reset data even with a copy after every change and the minimum retention', async () => {
    vi.stubEnv('LAD_BACKUP_EVERY', '1')
    vi.stubEnv('LAD_BACKUP_KEEP', '2')
    const w = await workspace()
    await w.run(account())
    await w.run({ op: 'workspace.reset', confirmation: 'УДАЛИТЬ' })
    const status = await w.backups.status()
    expect(status.files).toHaveLength(2)
    expect((await w.backups.read(status.files[0]!.name)).accounts).toEqual([])
    expect((await w.backups.read(status.files[1]!.name)).accounts).toHaveLength(1)
  })

  it('restores an automatic file into an independent empty database with all sections and links', async () => {
    const source = await workspace()
    await source.run({ op: 'demo.load' })
    await source.run(account('Архив'))
    const archived = (await source.readWorkspace()).accounts.find((a) => a.name === 'Архив')!
    await source.run({
      op: 'import',
      data: {
        transactions: [
          {
            accountId: archived.id,
            kind: 'expense',
            amount: '321',
            date: localDate(),
            category: 'Дом',
            importKey: 'automatic-backup-import',
          },
        ],
      },
    })
    const imported = (await source.readWorkspace()).transactions.find((t) => t.importKey)!
    await source.run({ op: 'transaction.delete', id: imported.id })
    await source.run({ op: 'account.archive', id: archived.id, archived: true })
    await source.backups.capture()
    const status = await source.backups.status()
    // Read actual bytes from disk, not an in-memory export or an injected snapshot.
    const saved = backupSchema.parse(
      JSON.parse(await readFile(join(status.directory, status.files[0]!.name), 'utf8')),
    )
    expect(saved.version).toBe(4)
    expect(saved.obligationEntries.length).toBeGreaterThan(0)
    expect(saved.plans.length).toBeGreaterThan(0)
    expect(saved.planVersions.length).toBeGreaterThan(0)
    expect(saved.planOccurrences.length).toBeGreaterThan(0)
    expect(saved.budgets.length).toBeGreaterThan(0)
    expect(saved.deletedTransactions).toHaveLength(1)
    const original = await source.readWorkspace()

    vi.resetModules()
    vi.stubEnv('LAD_DATA_DIR', join(root, 'restored-db'))
    vi.stubEnv('LAD_BACKUP_DIR', join(root, 'restored-backups'))
    const target = await workspace()
    const empty = await target.readWorkspace()
    expect(empty.accounts).toEqual([])
    await target.run({
      op: 'workspace.restore',
      backup: saved,
      expectedRevision: empty.revision,
      confirmation: 'ВОССТАНОВИТЬ',
    })
    const restored = await target.readWorkspace()
    for (const key of Object.keys(original) as (keyof typeof original)[]) {
      if (key === 'revision') continue
      const normalize = (value: unknown) =>
        Array.isArray(value) ? [...value].sort((a, b) => a.id.localeCompare(b.id)) : value
      expect(normalize(restored[key]), key).toEqual(normalize(original[key]))
    }
    expect((await source.readWorkspace()).revision).toBe(original.revision)
    expect(restored.deletedTransactions[0]!.importAccountId).toBe(archived.id)
  })
})
