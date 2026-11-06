import { configureTimeZone } from '../../shared/time-zone'
import { PGlite } from '@electric-sql/pglite'
import { drizzle as embeddedDrizzle } from 'drizzle-orm/pglite'
import { drizzle as postgresDrizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { resolve, dirname } from 'node:path'
import { mkdir, open, readFile, rm } from 'node:fs/promises'
import { readFileSync, rmSync } from 'node:fs'
import * as schema from './schema'
import { migration } from './migration'

function isAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: any) {
    return error?.code === 'EPERM'
  }
}

// PGlite is a single-process database: two servers (for example `dev` and `preview`) opening the
// same directory corrupt it. A pid lock file next to the directory makes the second one fail fast.
export async function lockDataDir(dataDir: string) {
  const lockPath = `${dataDir}.lock`
  const owner = String(process.pid)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(lockPath, 'wx')
      await handle.writeFile(owner)
      await handle.close()
      process.once('exit', () => {
        try {
          if (readFileSync(lockPath, 'utf8') === owner) rmSync(lockPath)
        } catch {
          /* already released */
        }
      })
      return
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error
      const pid = Number((await readFile(lockPath, 'utf8').catch(() => '')).trim())
      // The same pid means a reloaded dev worker of this very server: take the lock over.
      if (pid && pid !== process.pid && isAlive(pid))
        throw new Error(
          `База ${dataDir} уже открыта другим процессом (PID ${pid}). ` +
            'Остановите его или задайте другой LAD_DATA_DIR.',
        )
      await rm(lockPath, { force: true })
    }
  }
  throw new Error(`Не удалось заблокировать базу ${dataDir}`)
}

async function connect() {
  if (process.env.DATABASE_URL) {
    const client = postgres(process.env.DATABASE_URL, { max: 5 })
    await client.unsafe(migration)
    const [zone] = await client.unsafe("SELECT value FROM settings WHERE key='time_zone'")
    configureTimeZone(zone?.value || 'Europe/Moscow')
    return postgresDrizzle(client, { schema })
  }
  const dataDir = resolve(process.env.LAD_DATA_DIR || '.data/lad')
  await mkdir(dirname(dataDir), { recursive: true })
  await lockDataDir(dataDir)
  const client = new PGlite(dataDir)
  await client.exec(migration)
  const zone = await client.query<{ value: string }>(
    "SELECT value FROM settings WHERE key='time_zone'",
  )
  configureTimeZone(zone.rows[0]?.value || 'Europe/Moscow')
  return embeddedDrizzle(client, { schema })
}
let connection: ReturnType<typeof connect> | undefined
export function getDb() {
  connection ??= connect().catch((error) => {
    connection = undefined
    throw error
  })
  return connection
}
export type WriteTransaction = Parameters<
  Parameters<Awaited<ReturnType<typeof getDb>>['transaction']>[0]
>[0]
