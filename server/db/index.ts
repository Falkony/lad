import { PGlite } from '@electric-sql/pglite'
import { drizzle as embeddedDrizzle } from 'drizzle-orm/pglite'
import { drizzle as postgresDrizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { resolve, dirname } from 'node:path'
import { mkdir } from 'node:fs/promises'
import * as schema from './schema'
import { migration } from './migration'

async function connect() {
  if (process.env.DATABASE_URL) {
    const client = postgres(process.env.DATABASE_URL, { max: 5 })
    await client.unsafe(migration)
    return postgresDrizzle(client, { schema })
  }
  const dataDir = resolve(process.env.LAD_DATA_DIR || '.data/lad')
  await mkdir(dirname(dataDir), { recursive: true })
  const client = new PGlite(dataDir)
  await client.exec(migration)
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
