import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PGlite } from '@electric-sql/pglite'
import { commandSchema, executeCommand, readWorkspace } from '../server/modules/workspace'
import { migration, migrationThrough } from '../server/db/migration'
import { forecastMigration } from '../server/db/forecast-migration'
import { createBackup } from '../shared/backup'

const run = async (input: unknown) => executeCommand(commandSchema.parse(input))
const accountsByName = async () =>
  Object.fromEntries((await readWorkspace()).accounts.map((a) => [a.name, a]))

beforeAll(async () => {
  process.env.LAD_DATA_DIR = join(await mkdtemp(join(tmpdir(), 'lad-forecast-')), 'db')
  delete process.env.DATABASE_URL
})
beforeEach(async () => {
  await run({ op: 'workspace.reset', confirmation: 'УДАЛИТЬ' })
})

describe('accounts in the forecast', () => {
  it('keeps savings outside by default and stores an explicit choice', async () => {
    await run({ op: 'account.create', data: { name: 'Карта', openingBalance: '0' } })
    await run({
      op: 'account.create',
      data: { name: 'Резерв', kind: 'savings', openingBalance: '0' },
    })
    await run({
      op: 'account.create',
      data: { name: 'Вклад', kind: 'savings', openingBalance: '0', inForecast: true },
    })
    let accounts = await accountsByName()
    expect(accounts['Карта']!.inForecast).toBe(true)
    expect(accounts['Резерв']!.inForecast).toBe(false)
    expect(accounts['Вклад']!.inForecast).toBe(true)

    const { id, name, kind, openingBalance, color } = accounts['Карта']!
    // An update without the flag keeps the stored choice.
    await run({
      op: 'account.update',
      id,
      data: { name: 'Карта', kind, openingBalance, color, inForecast: false },
    })
    await run({ op: 'account.update', id, data: { name, kind, openingBalance, color } })
    accounts = await accountsByName()
    expect(accounts['Карта']!.inForecast).toBe(false)
  })

  it('restores copies made before the forecast flag with the migration default', async () => {
    await run({ op: 'account.create', data: { name: 'Карта', openingBalance: '0' } })
    await run({
      op: 'account.create',
      data: { name: 'Резерв', kind: 'savings', openingBalance: '0', inForecast: true },
    })
    const backup = JSON.parse(JSON.stringify(createBackup(await readWorkspace())))
    for (const account of backup.accounts) delete account.inForecast
    await run({
      op: 'workspace.restore',
      backup,
      expectedRevision: (await readWorkspace()).revision,
      confirmation: 'ВОССТАНОВИТЬ',
    })
    const accounts = await accountsByName()
    expect(accounts['Карта']!.inForecast).toBe(true)
    expect(accounts['Резерв']!.inForecast).toBe(false)
  })

  it('migration 7 takes savings out of the forecast once', async () => {
    const db = new PGlite()
    try {
      await db.exec(migrationThrough(6))
      await db.exec(`
        INSERT INTO accounts (id,name,kind,opening_balance,color) VALUES
          ('a','Карта','card',100,'green'), ('b','Резерв','savings',200,'blue');
      `)
      await db.exec(migration)
      await db.exec(`UPDATE accounts SET in_forecast = true WHERE id = 'b'`)
      await db.exec(migration)
      expect((await db.query('SELECT id, in_forecast FROM accounts ORDER BY id')).rows).toEqual([
        { id: 'a', in_forecast: true },
        // The user's later choice survives a repeated run.
        { id: 'b', in_forecast: true },
      ])
      expect(
        (await db.query('SELECT version FROM lad_migrations WHERE version = 7')).rows,
      ).toHaveLength(1)
    } finally {
      await db.close()
    }
  })
})
