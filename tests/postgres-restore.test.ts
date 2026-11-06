import { describe, it, beforeAll, expect } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  commandSchema,
  executeCommand,
  readWorkspace,
  getWorkspaceBackups,
} from '../server/modules/workspace'
const url = process.env.LAD_TEST_DATABASE_URL
describe.skipIf(!url)('PostgreSQL server backup integration', () => {
  beforeAll(async () => {
    if (!/^\/lad_test_[a-z0-9_]+$/i.test(new URL(url!).pathname))
      throw new Error('Use a dedicated lad_test_* database')
    process.env.DATABASE_URL = url
    process.env.LAD_AUTH_ENABLED = '0'
    const dir = await mkdtemp(join(tmpdir(), 'lad-postgres-backups-'))
    process.env.LAD_BACKUP_DIR = dir
  })
  it('restores an actual automatic file with all financial sections and links', async () => {
    const run = (c: unknown) => executeCommand(commandSchema.parse(c))
    await run({ op: 'workspace.reset', confirmation: 'УДАЛИТЬ' })
    await run({ op: 'demo.load' })
    const before = await readWorkspace()
    const backups = getWorkspaceBackups()
    await backups.capture()
    const file = (await backups.status()).files[0]!
    const backup = await backups.read(file.name)
    await run({ op: 'workspace.reset', confirmation: 'УДАЛИТЬ' })
    const empty = await readWorkspace()
    await run({
      op: 'workspace.restore',
      backup,
      expectedRevision: empty.revision,
      confirmation: 'ВОССТАНОВИТЬ',
    })
    const after = await readWorkspace()
    for (const key of [
      'accounts',
      'transactions',
      'categories',
      'goals',
      'plans',
      'planVersions',
      'planOccurrences',
      'obligations',
      'obligationEntries',
    ] as const) {
      const normalize = (rows: unknown[]) =>
        [...rows].sort((a: any, b: any) => a.id.localeCompare(b.id))
      expect(normalize(after[key] || []), key).toEqual(normalize(before[key] || []))
    }
    expect((await backups.status()).error).toBeNull()
    await run({ op: 'workspace.reset', confirmation: 'УДАЛИТЬ' })
  })
})
