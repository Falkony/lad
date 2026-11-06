import { it, expect } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core'
import { migration } from '../server/db/migration'
import * as schema from '../server/db/schema'

// The database is created by the hand-written SQL in migration.ts, while queries are typed by
// schema.ts. Keep the two descriptions identical: a missing column or a wrong NOT NULL would only
// surface at runtime otherwise.
it('keeps the Drizzle schema in sync with the SQL migration', async () => {
  const db = new PGlite()
  try {
    await db.exec(migration)
    const { rows } = await db.query<{
      table_name: string
      column_name: string
      is_nullable: string
    }>(
      "SELECT table_name, column_name, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name <> 'lad_migrations'",
    )
    const actual = rows.map((r) => `${r.table_name}.${r.column_name}:${r.is_nullable === 'NO'}`)
    const expected = Object.values(schema)
      .filter((value): value is PgTable => value instanceof PgTable)
      .flatMap((table) => {
        const config = getTableConfig(table)
        return config.columns.map(
          (column) => `${config.name}.${column.name}:${column.notNull || column.primary}`,
        )
      })
    expect(actual.sort()).toEqual(expected.sort())
  } finally {
    await db.close()
  }
})
